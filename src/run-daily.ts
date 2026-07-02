import 'dotenv/config';
import axios from 'axios';
import { GoogleGenAI, Type } from '@google/genai';
import { PrismaClient } from '@prisma/client';

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

const SOURCE_LIMIT_PER_RUN = Number(process.env.SOURCE_LIMIT_PER_RUN || 5);
const GEMINI_DELAY_MS = Number(process.env.GEMINI_DELAY_MS || 8000);
const USER_AGENT = process.env.USER_AGENT || 'DevRadar/1.0';

type Topic = 'tech' | 'finance' | 'sports' | 'world';

type RawArticle = {
  source: string;
  externalId: string;
  topic: Topic;
  title: string;
  url: string;
  author?: string | null;
  score?: number | null;
  publishedAt?: string | null;
  imageUrl?: string | null;
  sourceTags?: string[];
};

type AIResult = {
  summary: string;
  tags: string[];
  is_relevant: boolean;
};

type DigestAIResult = {
  title: string;
  content: string;
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
  cover_image?: string | null;
  social_image?: string | null;
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
    avatar_url?: string;
  };
};

type GitHubSearchResponse = {
  items: GitHubRepo[];
};

type RssFeedConfig = {
  source: string;
  topic: Topic;
  url: string;
  tags: string[];
};

type ParsedRssItem = {
  title: string;
  url: string;
  description?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  imageUrl?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorSummary(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const data = typeof error.response?.data === 'string'
      ? error.response.data.slice(0, 160).replace(/\s+/g, ' ').trim()
      : '';

    return [
      error.code,
      status ? `HTTP ${status}` : undefined,
      statusText,
      data,
    ]
      .filter(Boolean)
      .join(' - ');
  }

  return error instanceof Error ? error.message : String(error);
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

function parseDigestJson(text: string): DigestAIResult {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as DigestAIResult;

  if (typeof parsed.title !== 'string' || typeof parsed.content !== 'string') {
    throw new Error(`Invalid digest JSON: ${cleaned}`);
  }

  return parsed;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlTag(block: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(regex);
  return match?.[1] ? decodeXmlEntities(match[1]) : null;
}

function extractXmlLink(block: string): string | null {
  const linkTag = extractXmlTag(block, 'link');
  if (linkTag) return linkTag;

  const atomLink = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return atomLink?.[1] ? decodeXmlEntities(atomLink[1]) : null;
}

function extractXmlAttr(block: string, tagPattern: string, attr: string): string | null {
  const regex = new RegExp(`<${tagPattern}[^>]+${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const match = block.match(regex);
  return match?.[1] ? decodeXmlEntities(match[1]) : null;
}

function extractXmlImage(block: string): string | null {
  return (
    extractXmlAttr(block, 'media:content', 'url') ||
    extractXmlAttr(block, 'media:thumbnail', 'url') ||
    extractXmlAttr(block, 'enclosure', 'url') ||
    extractXmlTag(block, 'image') ||
    null
  );
}

function parseRssItems(xml: string): ParsedRssItem[] {
  const blocks = [
    ...xml.matchAll(/<item[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi),
  ].map((match) => match[0]);

  const seen = new Set<string>();

  return blocks
    .map((block) => {
      const title = extractXmlTag(block, 'title');
      const url = extractXmlLink(block) || extractXmlTag(block, 'guid') || extractXmlTag(block, 'id');
      const description =
        extractXmlTag(block, 'description') ||
        extractXmlTag(block, 'summary') ||
        extractXmlTag(block, 'content:encoded');
      const author = extractXmlTag(block, 'dc:creator') || extractXmlTag(block, 'author');
      const publishedAt =
        extractXmlTag(block, 'pubDate') ||
        extractXmlTag(block, 'published') ||
        extractXmlTag(block, 'updated');
      const imageUrl = extractXmlImage(block);

      if (!title || !url) return null;

      return {
        title,
        url,
        description: description ?? null,
        author: author ?? null,
        publishedAt: publishedAt ?? null,
        imageUrl: imageUrl ?? null,
      } satisfies ParsedRssItem;
    })
    .filter(
      (
        item,
      ): item is {
        title: string;
        url: string;
        description: string | null;
        author: string | null;
        publishedAt: string | null;
        imageUrl: string | null;
      } => item !== null,
    )
    .filter((item) => {
      if (item === null) return false;
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
}

async function fetchRssFeed(config: RssFeedConfig, limit: number): Promise<RawArticle[]> {
  const response = await axios.get<string>(config.url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    timeout: 20_000,
    responseType: 'text',
  });

  return parseRssItems(response.data)
    .slice(0, limit)
    .map((item) => ({
      source: config.source,
      externalId: item.url,
      topic: config.topic,
      title: item.description ? `${item.title} — ${item.description}` : item.title,
      url: item.url,
      author: item.author ?? config.source,
      score: null,
      publishedAt: item.publishedAt ? toDate(item.publishedAt)?.toISOString() ?? null : null,
      imageUrl: item.imageUrl ?? null,
      sourceTags: config.tags,
    }));
}

async function fetchRssTopic(feeds: RssFeedConfig[], limit: number): Promise<RawArticle[]> {
  const perFeed = Math.max(2, Math.ceil(limit / feeds.length));
  const articleMap = new Map<string, RawArticle>();

  for (const feed of feeds) {
    try {
      const articles = await fetchRssFeed(feed, perFeed);
      for (const article of articles) {
        articleMap.set(article.url, article);
      }
    } catch (error) {
      console.warn(`⚠️ RSS ${feed.source} lỗi: ${getErrorSummary(error)}`);
    }

    await sleep(1000);
  }

  return Array.from(articleMap.values()).slice(0, limit);
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
      topic: 'tech',
      title: story.title,
      url: story.url || `https://news.ycombinator.com/item?id=${id}`,
      author: story.by ?? null,
      score: story.score ?? null,
      publishedAt: story.time ? new Date(story.time * 1000).toISOString() : null,
      sourceTags: ['hackernews', 'tech'],
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
      topic: 'tech',
      title: article.description
        ? `${article.title} — ${article.description}`
        : article.title,
      url: article.url,
      author: article.user?.username ?? article.user?.name ?? null,
      score: (article.positive_reactions_count ?? 0) + (article.comments_count ?? 0),
      publishedAt: article.published_at ?? null,
      imageUrl: article.cover_image ?? article.social_image ?? null,
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
      topic: 'tech',
      title: `${repo.full_name}${repo.description ? ` — ${repo.description}` : ''}`,
      url: repo.html_url,
      author: repo.owner.login,
      score: repo.stargazers_count,
      publishedAt: repo.pushed_at || repo.updated_at || null,
      imageUrl: `https://opengraph.githubassets.com/devradar/${repo.full_name}`,
      sourceTags: repo.topics ?? ['github', 'open-source'],
    }));
}

async function fetchFinanceNews(limit: number): Promise<RawArticle[]> {
  return fetchRssTopic(
    [
      {
        source: 'marketwatch-topstories',
        topic: 'finance',
        url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
        tags: ['finance', 'markets', 'MarketWatch'],
      },
      {
        source: 'marketwatch-headlines',
        topic: 'finance',
        url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
        tags: ['finance', 'markets', 'MarketWatch'],
      },
      {
        source: 'guardian-business',
        topic: 'finance',
        url: 'https://www.theguardian.com/business/rss',
        tags: ['finance', 'business', 'economy', 'Guardian'],
      },
    ],
    limit,
  );
}

async function fetchSportsHotNews(limit: number): Promise<RawArticle[]> {
  return fetchRssTopic(
    [
      {
        source: 'espn-top',
        topic: 'sports',
        url: 'https://www.espn.com/espn/rss/news',
        tags: ['sports', 'ESPN'],
      },
      {
        source: 'guardian-sport',
        topic: 'sports',
        url: 'https://www.theguardian.com/sport/rss',
        tags: ['sports', 'Guardian'],
      },
    ],
    limit,
  );
}

async function fetchWorldHotNews(limit: number): Promise<RawArticle[]> {
  return fetchRssTopic(
    [
      {
        source: 'guardian-world',
        topic: 'world',
        url: 'https://www.theguardian.com/world/rss',
        tags: ['world', 'global', 'Guardian'],
      },
      {
        source: 'guardian-news',
        topic: 'world',
        url: 'https://www.theguardian.com/international/rss',
        tags: ['world', 'global', 'Guardian'],
      },
    ],
    limit,
  );
}

async function analyzeArticle(article: RawArticle): Promise<AIResult> {
  const prompt = `
Bạn là trợ lý lọc thông tin cho dự án DevRadar.

Hãy đánh giá item sau:
- Topic: ${article.topic}
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
3. is_relevant = true nếu item đáng đọc trong topic tương ứng:
   - tech: AI, Backend, Web Dev, Database, DevOps, Security, Open Source
   - finance: chứng khoán, kinh tế vĩ mô, doanh nghiệp lớn, lãi suất, crypto lớn, thị trường
   - sports: kết quả/lịch/trận đấu lớn, chuyển nhượng lớn, giải đấu lớn, vận động viên nổi bật
   - world: sự kiện nóng toàn cầu, chính trị quốc tế, kinh tế, khí hậu, thiên tai, xung đột, khoa học
4. false nếu quá ngoài lề, câu view, drama nhỏ, quảng cáo, tuyển dụng không liên quan.
5. Với finance, không đưa khuyến nghị mua/bán.

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
          summary: { type: Type.STRING },
          tags: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          is_relevant: { type: Type.BOOLEAN },
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
      topic: article.topic,
      title: article.title,
      url: article.url,
      author: article.author ?? null,
      score: article.score ?? null,
      publishedAt: toDate(article.publishedAt),
      imageUrl: article.imageUrl ?? null,
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

  const sources: Array<{ name: string; fetch: (limit: number) => Promise<RawArticle[]> }> = [
    { name: 'hackernews', fetch: fetchHackerNews },
    { name: 'devto', fetch: fetchDevTo },
    { name: 'github', fetch: fetchGitHub },
    { name: 'finance', fetch: fetchFinanceNews },
    { name: 'sports', fetch: fetchSportsHotNews },
    { name: 'world', fetch: fetchWorldHotNews },
  ];

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const source of sources) {
    console.log(`\n🔎 Đang lấy nguồn: ${source.name}`);

    let articles: RawArticle[] = [];

    try {
      if (['finance', 'sports', 'world'].includes(source.name)) {
        console.log(`📰 Lấy ${source.name} bằng RSS feeds thay cho GDELT để tránh 429...`);
      }

      articles = await source.fetch(SOURCE_LIMIT_PER_RUN);
    } catch (error) {
      totalFailed += 1;
      console.error(`❌ Lỗi lấy nguồn ${source.name}: ${getErrorSummary(error)}`);
      continue;
    }

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
        console.log(`⏩ Bỏ qua đã có DB: [${article.topic}/${article.source}] ${article.title}`);
        continue;
      }

      try {
        console.log(`⚙️ AI xử lý: [${article.topic}/${article.source}] ${article.title}`);

        const aiResult = await analyzeArticle(article);
        const status = await saveArticle(article, aiResult);

        if (status === 'created') {
          totalCreated += 1;
          console.log(`✅ Đã lưu: [${article.topic}/${article.source}] ${article.title}`);
        } else {
          totalSkipped += 1;
        }
      } catch (error) {
        totalFailed += 1;
        console.error(`❌ Lỗi item [${article.topic}/${article.source}] ${article.title}:`, error);
      }

      await sleep(GEMINI_DELAY_MS);
    }
  }

  console.log('\n📊 Kết quả collect:');
  console.log(`Created: ${totalCreated}`);
  console.log(`Skipped: ${totalSkipped}`);
  console.log(`Failed : ${totalFailed}`);
}

function getStartOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function getLookbackDate(): Date {
  const hours = Number(process.env.DIGEST_LOOKBACK_HOURS || 24);
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function generateMultiTopicDigest() {
  const today = getStartOfToday();
  const since = getLookbackDate();
  const maxArticles = Number(process.env.DIGEST_MAX_ARTICLES || 80);

  const articles = await prisma.article.findMany({
    where: {
      isRelevant: true,
      createdAt: {
        gte: since,
      },
    },
    orderBy: [
      { topic: 'asc' },
      { score: 'desc' },
      { createdAt: 'desc' },
    ],
    take: maxArticles,
  });

  if (articles.length === 0) {
    throw new Error('Không có article phù hợp để tạo digest.');
  }

  const articleText = articles
    .map((article, index) => {
      return `
${index + 1}.
Topic: ${article.topic}
Source: ${article.source}
Title: ${article.title}
URL: ${article.url}
Summary: ${article.summary ?? 'Chưa có summary'}
Tags: ${article.tags.join(', ')}
Score: ${article.score ?? 'unknown'}
Author: ${article.author ?? 'unknown'}
Published At: ${article.publishedAt?.toISOString() ?? 'unknown'}
`;
    })
    .join('\n');

  const prompt = `
Bạn là biên tập viên cho DevRadar.

Dưới đây là danh sách thông tin đã lọc trong 24h qua:

${articleText}

Hãy tạo bản tin tiếng Việt dạng "Morning Radar".

Yêu cầu:
- Chia thành 4 phần nếu có dữ liệu:
  1. Công nghệ
  2. Chứng khoán & Kinh tế
  3. Thể thao
  4. Tin nóng toàn cầu
- Mỗi phần chọn 3-5 mục quan trọng nhất.
- Mỗi mục có: tiêu đề, tóm tắt, vì sao đáng chú ý, link.
- Với chứng khoán: chỉ tóm tắt thông tin, không khuyến nghị mua/bán.
- Không bịa thêm thông tin ngoài dữ liệu đã cho.
- Nội dung content dùng Markdown.
- Trả về JSON đúng schema:
{
  "title": "Tiêu đề bản tin",
  "content": "Nội dung Markdown"
}
`;

  const response = await genAI.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          content: { type: Type.STRING },
        },
        required: ['title', 'content'],
      },
    },
  });

  if (!response.text) {
    throw new Error('Gemini returned empty digest response');
  }

  const result = parseDigestJson(response.text);

  const digest = await prisma.dailyDigest.upsert({
    where: {
      date: today,
    },
    update: {
      title: result.title,
      content: result.content,
    },
    create: {
      date: today,
      title: result.title,
      content: result.content,
    },
  });

  return {
    digest,
    articleCount: articles.length,
  };
}

async function main() {
  console.log('🚀 DevRadar daily run bắt đầu...');

  await collectArticles();

  console.log('\n⏳ Nghỉ một chút trước khi tạo Digest để tránh rate limit...');
  await sleep(GEMINI_DELAY_MS);

  console.log('\n📰 Đang tạo Morning Radar đa chủ đề...');
  const digestResult = await generateMultiTopicDigest();

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
  });
