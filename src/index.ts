import 'dotenv/config';
import axios from 'axios';
import { GoogleGenAI, Type } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import cron from 'node-cron';
import {
  generateDailyDigest,
  disconnectDigestService,  
} from './services/digest-service';

// ==========================================
// CONFIG
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GEMINI_API_KEY) {
  throw new Error('Missing GEMINI_API_KEY in .env');
}

const HN_BASE_URL = 'https://hacker-news.firebaseio.com/v0';
const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,

  // BullMQ Worker dùng ioredis bên dưới.
  // Dòng này giúp tránh một số lỗi retry khi dùng Redis cloud.
  maxRetriesPerRequest: null,
};

const SOURCE_LIMIT_PER_RUN = Number(process.env.SOURCE_LIMIT_PER_RUN || 10);
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 1);

// Free tier trong log của bạn là 15 requests/phút.
// Đặt thấp hơn một chút để tránh chạm trần do burst/retry.
const GEMINI_RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT || 10);

// Khi Gemini trả 429 nhưng không parse được retryDelay, dùng fallback này.
const GEMINI_RATE_LIMIT_FALLBACK_MS = Number(process.env.GEMINI_RATE_LIMIT_FALLBACK_MS || 65_000);

// Đừng cào quá dày khi còn dùng free tier.
const CRON_EXPRESSION = process.env.CRON_EXPRESSION || '*/30 * * * *';

const USER_AGENT = process.env.USER_AGENT || 'DevRadar/1.0';

// Khởi tạo các client
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const prisma = new PrismaClient();

// Khởi tạo Queue và kết nối tới Redis
const articleQueue = new Queue('article-processing', {
  connection: REDIS_CONNECTION,
});

// ==========================================
// TYPES
// ==========================================
// Lưu ý: publishedAt cho phép string vì khi qua BullMQ/Redis,
// Date sẽ bị serialize thành string.
type RawArticle = {
  source: string;
  externalId: string;
  title: string;
  url: string;
  author?: string | null;
  score?: number | null;
  publishedAt?: Date | string | null;
  sourceTags?: string[];
};

type SourceAdapter = {
  name: string;
  fetchLatest(limit: number): Promise<RawArticle[]>;
};

type HNStory = {
  id: number;
  title?: string;
  url?: string;
  by?: string;
  score?: number;
  time?: number;
  type?: string;
};

type DevToArticle = {
  id: number;
  title: string;
  description?: string;
  url: string;
  published_at?: string;
  positive_reactions_count?: number;
  comments_count?: number;
  tag_list?: string[] | string;
  user?: {
    name?: string;
    username?: string;
  };
};

type GitHubRepo = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
  updated_at: string;
  topics?: string[];
  owner: {
    login: string;
  };
};

type GitHubSearchResponse = {
  items: GitHubRepo[];
};

type AIResult = {
  summary: string;
  tags: string[];
  is_relevant: boolean;
};

function isAIResult(value: unknown): value is AIResult {
  if (!value || typeof value !== 'object') return false;

  const data = value as Record<string, unknown>;

  return (
    typeof data.summary === 'string' &&
    Array.isArray(data.tags) &&
    data.tags.every((tag) => typeof tag === 'string') &&
    typeof data.is_relevant === 'boolean'
  );
}

function parseAIJson(text: string): AIResult {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed: unknown = JSON.parse(cleaned);

  if (!isAIResult(parsed)) {
    throw new Error(`AI JSON schema is invalid: ${cleaned}`);
  }

  return parsed;
}

function isPrismaUniqueError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function buildJobId(article: RawArticle): string {
  const safeSource = article.source.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeExternalId = article.externalId.replace(/[^a-zA-Z0-9_-]/g, '_');

  return `${safeSource}-${safeExternalId}`;
}

function normalizeDevToTags(tagList: DevToArticle['tag_list']): string[] {
  if (Array.isArray(tagList)) return tagList;

  if (typeof tagList === 'string') {
    return tagList
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  return [];
}

function getDateNDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toISOStringSafe(value: Date | string | null | undefined): string {
  const date = toDate(value);
  return date ? date.toISOString() : 'unknown';
}

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getGeminiRateLimitDelayMs(error: unknown): number | null {
  const text = stringifyUnknownError(error);

  const isRateLimitError =
    text.includes('RESOURCE_EXHAUSTED') ||
    text.includes('"code":429') ||
    text.includes('code: 429') ||
    text.includes('429');

  if (!isRateLimitError) return null;

  const retryDelayMatch = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (retryDelayMatch?.[1]) {
    return Math.ceil(Number(retryDelayMatch[1]) * 1000) + 2_000;
  }

  const retryInMatch = text.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
  if (retryInMatch?.[1]) {
    return Math.ceil(Number(retryInMatch[1]) * 1000) + 2_000;
  }

  return GEMINI_RATE_LIMIT_FALLBACK_MS;
}

// ==========================================
// AI ANALYSIS
// ==========================================
async function analyzeArticle(article: RawArticle): Promise<AIResult> {
  const prompt = `
Bạn là trợ lý lọc tin công nghệ cho dự án DevRadar.

Hãy đánh giá bài viết / repo sau:
- Source: ${article.source}
- Title: ${article.title}
- URL: ${article.url}
- Score: ${article.score ?? 'unknown'}
- Author: ${article.author ?? 'unknown'}
- Published At: ${toISOStringSafe(article.publishedAt)}
- Source Tags: ${article.sourceTags?.join(', ') || 'unknown'}

Nhiệm vụ:
1. Tóm tắt trong 1 câu tiếng Việt, dễ hiểu.
2. Gắn 2-5 tag ngắn, ví dụ: AI, Backend, Web Dev, Database, Security, DevOps, Startup, Open Source.
3. Đánh dấu is_relevant = true nếu đáng đọc với người theo dõi Backend, AI, Web Dev, Database, DevOps, Security, Open Source hoặc xu hướng công nghệ.
4. Đánh dấu false nếu quá ngoài lề, chính trị, tuyển dụng không liên quan, drama, hoặc không có giá trị công nghệ rõ ràng.

Chỉ trả về JSON đúng schema.
`;

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
          },
          tags: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
          },
          is_relevant: {
            type: Type.BOOLEAN,
          },
        },
        required: ['summary', 'tags', 'is_relevant'],
      },
    },
  });

  if (!response.text) {
    throw new Error('Gemini returned empty response');
  }

  return parseAIJson(response.text);
}

// ==========================================
// SOURCE ADAPTERS
// ==========================================
const hackerNewsSource: SourceAdapter = {
  name: 'hackernews',

  async fetchLatest(limit: number): Promise<RawArticle[]> {
    const response = await axios.get<number[]>(`${HN_BASE_URL}/topstories.json`, {
      timeout: 15_000,
    });

    const storyIds = response.data.slice(0, limit);
    const articles: RawArticle[] = [];

    for (const id of storyIds) {
      const storyRes = await axios.get<HNStory>(`${HN_BASE_URL}/item/${id}.json`, {
        timeout: 15_000,
      });

      const story = storyRes.data;

      if (!story?.title) continue;
      if (story.type && story.type !== 'story') continue;

      articles.push({
        source: 'hackernews',
        externalId: String(id),
        title: story.title,
        url: story.url || `https://news.ycombinator.com/item?id=${id}`,
        author: story.by ?? null,
        score: story.score ?? null,
        // Dùng ISO string ngay từ đầu để hợp với Redis/BullMQ
        publishedAt: story.time ? new Date(story.time * 1000).toISOString() : null,
        sourceTags: ['hackernews'],
      });
    }

    return articles;
  },
};

const devToSource: SourceAdapter = {
  name: 'devto',

  async fetchLatest(limit: number): Promise<RawArticle[]> {
    const response = await axios.get<DevToArticle[]>('https://dev.to/api/articles', {
      params: {
        per_page: Math.min(limit, 100),
        top: 7,
      },
      headers: {
        'User-Agent': USER_AGENT,
      },
      timeout: 15_000,
    });

    return response.data
      .filter((article) => article.title && article.url)
      .map((article) => ({
        source: 'devto',
        externalId: String(article.id),
        title: article.description
          ? `${article.title} — ${article.description}`
          : article.title,
        url: article.url,
        author: article.user?.username ?? article.user?.name ?? null,
        score: (article.positive_reactions_count ?? 0) + (article.comments_count ?? 0),
        // Giữ dạng string ISO từ API
        publishedAt: article.published_at ?? null,
        sourceTags: normalizeDevToTags(article.tag_list),
      }));
  },
};

const githubTrendingSource: SourceAdapter = {
  name: 'github',

  async fetchLatest(limit: number): Promise<RawArticle[]> {
    const pushedAfter = getDateNDaysAgo(14);

    const queries = [
      `topic:ai stars:>100 pushed:>=${pushedAfter}`,
      `topic:llm stars:>100 pushed:>=${pushedAfter}`,
      `topic:developer-tools stars:>100 pushed:>=${pushedAfter}`,
      `topic:web-development stars:>100 pushed:>=${pushedAfter}`,
      `topic:database stars:>100 pushed:>=${pushedAfter}`,
    ];

    const perQuery = Math.max(5, Math.ceil(limit / queries.length));
    const repoMap = new Map<string, GitHubRepo>();

    for (const q of queries) {
      const response = await axios.get<GitHubSearchResponse>(
        'https://api.github.com/search/repositories',
        {
          params: {
            q,
            sort: 'updated',
            order: 'desc',
            per_page: perQuery,
          },
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': USER_AGENT,
            ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
          },
          timeout: 15_000,
        },
      );

      for (const repo of response.data.items) {
        repoMap.set(repo.full_name, repo);
      }
    }

    return Array.from(repoMap.values())
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, limit)
      .map((repo) => ({
        source: 'github',
        externalId: repo.full_name,
        title: `${repo.full_name}${repo.description ? ` — ${repo.description}` : ''}`,
        url: repo.html_url,
        author: repo.owner.login,
        score: repo.stargazers_count,
        // Giữ dạng string ISO từ API
        publishedAt: repo.pushed_at || repo.updated_at || null,
        sourceTags: repo.topics ?? ['github', 'open-source'],
      }));
  },
};

const sources: SourceAdapter[] = [
  hackerNewsSource,
  devToSource,
  githubTrendingSource,
];

// ==========================================
// PHẦN 1: PRODUCER
// ==========================================
async function fetchAndQueueFromAllSources(limitPerSource: number = SOURCE_LIMIT_PER_RUN): Promise<void> {
  console.log(`\n📥 [Producer] Bắt đầu cào ${limitPerSource} bài / nguồn...`);

  for (const source of sources) {
    console.log(`\n🔎 [Producer] Đang cào nguồn: ${source.name}`);

    let articles: RawArticle[];

    try {
      articles = await source.fetchLatest(limitPerSource);
    } catch (error: unknown) {
      console.error(`❌ [Producer] Lỗi khi cào ${source.name}: ${(error as Error).message}`);
      continue;
    }

    let queuedCount = 0;
    let skippedCount = 0;

    for (const article of articles) {
      const exists = await prisma.article.findUnique({
        where: {
          source_externalId: {
            source: article.source,
            externalId: article.externalId,
          },
        },
      });

      if (exists) {
        skippedCount += 1;
        continue;
      }

      await articleQueue.add(
        'process-article',
        { article },
        {
          jobId: buildJobId(article),
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 60_000,
          },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      );

      queuedCount += 1;
    }

    console.log(
      `✅ [Producer] ${source.name}: queue mới ${queuedCount}, bỏ qua vì đã có DB ${skippedCount}.`,
    );
  }
}

// Lên lịch Producer. Mặc định 30 phút/lần để tránh dồn quá nhiều job AI.
cron.schedule(CRON_EXPRESSION, () => {
  fetchAndQueueFromAllSources().catch((error) => {
    console.error(`❌ [Producer] Lỗi tổng: ${(error as Error).message}`);
  });
});

cron.schedule(
  '0 7 * * *',
  () => {
    console.log('\n📰 [Digest] Bắt đầu tạo Daily Digest lúc 7h sáng...');

    generateDailyDigest()
      .then((result) => {
        console.log(
          `✅ [Digest] Đã tạo digest từ ${result.articleCount} articles: ${result.digest.title}`,
        );
      })
      .catch((error) => {
        console.error(`❌ [Digest] Lỗi tạo digest: ${(error as Error).message}`);
      });
  },
  {
    timezone: 'Asia/Ho_Chi_Minh',
  },
);
// ==========================================
// PHẦN 2: CONSUMER
// ==========================================
let worker: Worker;

worker = new Worker(
  'article-processing',
  async (job) => {
    const { article } = job.data as { article: RawArticle };

    console.log(`\n⚙️ [Consumer] Đang xử lý [${article.source}] ${article.title}`);

    const alreadyExists = await prisma.article.findUnique({
      where: {
        source_externalId: {
          source: article.source,
          externalId: article.externalId,
        },
      },
    });

    if (alreadyExists) {
      console.log(`⏩ [Consumer] Bài đã có trong DB, bỏ qua.`);
      return;
    }

    let aiResult: AIResult;

    try {
      aiResult = await analyzeArticle(article);
    } catch (error: unknown) {
      const rateLimitDelayMs = getGeminiRateLimitDelayMs(error);

      if (rateLimitDelayMs !== null) {
        console.warn(
          `⏳ [Gemini] Bị rate limit. Tạm dừng queue khoảng ${Math.ceil(
            rateLimitDelayMs / 1000,
          )} giây rồi xử lý lại job này.`,
        );

        await worker.rateLimit(rateLimitDelayMs);
        throw Worker.RateLimitError();
      }

      throw error;
    }

    try {
      await prisma.article.create({
        data: {
          source: article.source,
          externalId: article.externalId,
          title: article.title,
          url: article.url,
          author: article.author ?? null,
          score: article.score ?? null,
          // Convert lại thành Date trước khi lưu Prisma DateTime
          publishedAt: toDate(article.publishedAt),
          summary: aiResult.summary,
          tags: aiResult.tags,
          isRelevant: aiResult.is_relevant,
          processedAt: new Date(),
        },
      });

      console.log(`✅ [Consumer] Đã lưu DB: [${article.source}] ${article.title}`);
    } catch (error: unknown) {
      if (isPrismaUniqueError(error)) {
        console.log(`⏩ [Consumer] Bài đã có trong DB, bỏ qua.`);
        return;
      }

      throw error;
    }
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,

    // Giới hạn số job gọi Gemini mỗi phút.
    // Vì mỗi job gọi AI đúng 1 lần, rate limit queue = rate limit API.
    limiter: {
      max: GEMINI_RPM_LIMIT,
      duration: 60_000,
    },
  },
);

// ==========================================
// EVENTS
// ==========================================
worker.on('completed', (job) => {
  console.log(`🎉 Job ${job.id} hoàn thành!`);
});

worker.on('failed', (job, error) => {
  console.error(`❌ Job ${job?.id} thất bại: ${error.message}`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
async function shutdown(): Promise<void> {
  console.log('\n🛑 Đang tắt DevRadar worker...');

  await worker.close();
  await articleQueue.close();
  await prisma.$disconnect();
  await disconnectDigestService();
  
  console.log('✅ Đã đóng Worker, Queue và Prisma.');
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown().catch((error) => {
    console.error(`❌ Lỗi khi shutdown: ${(error as Error).message}`);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown().catch((error) => {
    console.error(`❌ Lỗi khi shutdown: ${(error as Error).message}`);
    process.exit(1);
  });
});

// Chạy thử ngay khi bật app
fetchAndQueueFromAllSources().catch((error) => {
  console.error(`❌ [Startup] Lỗi khi cào lần đầu: ${(error as Error).message}`);
});

console.log('🚀 DevRadar Multi-source Background Workers đang chạy...');
console.log(`🧭 Producer cron: ${CRON_EXPRESSION}`);
console.log(`🐢 Gemini limiter: ${GEMINI_RPM_LIMIT} requests/phút, concurrency=${WORKER_CONCURRENCY}`);
