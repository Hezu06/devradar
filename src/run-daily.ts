import 'dotenv/config';
import axios from 'axios';
import { GoogleGenAI, Type } from '@google/genai';
import { PrismaClient } from '@prisma/client';
import {
  generateDailyDigest,
  disconnectDigestService,
} from './services/digest-service';

const prisma = new PrismaClient();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GEMINI_API_KEY) {
  throw new Error('Missing GEMINI_API_KEY');
}

const genAI = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

const HN_BASE_URL = 'https://hacker-news.firebaseio.com/v0';

const SOURCE_LIMIT_PER_RUN = Number(process.env.SOURCE_LIMIT_PER_RUN || 10);
const GEMINI_DELAY_MS = Number(process.env.GEMINI_DELAY_MS || 7000);
const USER_AGENT = process.env.USER_AGENT || 'DevRadar/1.0';

type RawArticle = {
  source: string;
  externalId: string;
  title: string;
  url: string;
  author?: string | null;
  score?: number | null;
  publishedAt?: string | null;
  sourceTags?: string[];
};

type AIResult = {
  summary: string;
  tags: string[];
  is_relevant: boolean;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function parseAIJson(text: string): AIResult {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as AIResult;

  if (
    typeof parsed.summary !== 'string' ||
    !Array.isArray(parsed.tags) ||
    typeof parsed.is_relevant !== 'boolean'
  ) {
    throw new Error(`Invalid AI JSON: ${cleaned}`);
  }

  return parsed;
}

async function fetchHackerNews(limit: number): Promise<RawArticle[]> {
  const response = await axios.get<number[]>(`${HN_BASE_URL}/topstories.json`, {
    timeout: 15_000,
  });

  const ids = response.data.slice(0, limit);
  const articles: RawArticle[] = [];

  for (const id of ids) {
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
      publishedAt: story.time ? new Date(story.time * 1000).toISOString() : null,
      sourceTags: ['hackernews'],
    });
  }

  return articles;
}

async function fetchDevTo(limit: number): Promise<RawArticle[]> {
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
      publishedAt: article.published_at ?? null,
      sourceTags: normalizeDevToTags(article.tag_list),
    }));
}

async function fetchGitHub(limit: number): Promise<RawArticle[]> {
  const pushedAfter = getDateNDaysAgo(14);

  const queries = [
    `topic:ai stars:>100 pushed:>=${pushedAfter}`,
    `topic:llm stars:>100 pushed:>=${pushedAfter}`,
    `topic:developer-tools stars:>100 pushed:>=${pushedAfter}`,
    `topic:web-development stars:>100 pushed:>=${pushedAfter}`,
    `topic:database stars:>100 pushed:>=${pushedAfter}`,
  ];

  const perQuery = Math.max(3, Math.ceil(limit / queries.length));
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
      publishedAt: repo.pushed_at || repo.updated_at || null,
      sourceTags: repo.topics ?? ['github', 'open-source'],
    }));
}

async function analyzeArticle(article: RawArticle): Promise<AIResult> {
  const prompt = `
Bạn là trợ lý lọc tin công nghệ cho dự án DevRadar.

Hãy đánh giá bài viết / repo sau:
- Source: ${article.source}
- Title: ${article.title}
- URL: ${article.url}
- Score: ${article.score ?? 'unknown'}
- Author: ${article.author ?? 'unknown'}
- Published At: ${article.publishedAt ?? 'unknown'}
- Source Tags: ${article.sourceTags?.join(', ') || 'unknown'}

Nhiệm vụ:
1. Tóm tắt trong 1 câu tiếng Việt, dễ hiểu.
2. Gắn 2-5 tag ngắn.
3. is_relevant = true nếu đáng đọc với người theo dõi Backend, AI, Web Dev, Database, DevOps, Security, Open Source hoặc xu hướng công nghệ.
4. false nếu quá ngoài lề, tuyển dụng không liên quan, drama, hoặc không có giá trị công nghệ rõ ràng.

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

async function saveArticle(article: RawArticle, aiResult: AIResult): Promise<'created' | 'skipped'> {
  const exists = await prisma.article.findUnique({
    where: {
      source_externalId: {
        source: article.source,
        externalId: article.externalId,
      },
    },
  });

  if (exists) {
    return 'skipped';
  }

  await prisma.article.create({
    data: {
      source: article.source,
      externalId: article.externalId,
      title: article.title,
      url: article.url,
      author: article.author ?? null,
      score: article.score ?? null,
      publishedAt: toDate(article.publishedAt),
      summary: aiResult.summary,
      tags: aiResult.tags,
      isRelevant: aiResult.is_relevant,
      processedAt: new Date(),
    },
  });

  return 'created';
}

async function collectArticles(): Promise<void> {
  console.log(`📥 Bắt đầu collect ${SOURCE_LIMIT_PER_RUN} bài / nguồn...`);

  const sources = [
    {
      name: 'hackernews',
      fetch: fetchHackerNews,
    },
    {
      name: 'devto',
      fetch: fetchDevTo,
    },
    {
      name: 'github',
      fetch: fetchGitHub,
    },
  ];

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const source of sources) {
    console.log(`\n🔎 Đang lấy nguồn: ${source.name}`);

    const articles = await source.fetch(SOURCE_LIMIT_PER_RUN);

    console.log(`→ Lấy được ${articles.length} items từ ${source.name}`);

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
        totalSkipped += 1;
        console.log(`⏩ Bỏ qua đã có DB: [${article.source}] ${article.title}`);
        continue;
      }

      try {
        console.log(`⚙️ AI xử lý: [${article.source}] ${article.title}`);

        const aiResult = await analyzeArticle(article);
        const status = await saveArticle(article, aiResult);

        if (status === 'created') {
          totalCreated += 1;
          console.log(`✅ Đã lưu: [${article.source}] ${article.title}`);
        } else {
          totalSkipped += 1;
        }
      } catch (error) {
        totalFailed += 1;
        console.error(`❌ Lỗi item [${article.source}] ${article.title}:`, error);
      }

      // Chống Gemini free tier rate limit.
      // 7000ms ≈ 8-9 requests/phút, thấp hơn mức 15 rpm trong log lỗi của bạn.
      await sleep(GEMINI_DELAY_MS);
    }
  }

  console.log('\n📊 Kết quả collect:');
  console.log(`Created: ${totalCreated}`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log(`Failed : ${totalFailed}`);
}

async function main() {
  console.log('🚀 DevRadar daily run bắt đầu...');

  await collectArticles();

  console.log('\n📰 Đang tạo Daily Digest...');
  const digestResult = await generateDailyDigest();

  console.log(`✅ Đã tạo digest từ ${digestResult.articleCount} articles.`);
  console.log(`Title: ${digestResult.digest.title}`);

  console.log('\n🎉 DevRadar daily run hoàn tất!');
}

main()
  .catch((error) => {
    console.error('❌ Daily run failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await disconnectDigestService();
  });