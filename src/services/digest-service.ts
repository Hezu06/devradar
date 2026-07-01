import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

if (!GEMINI_API_KEY) {
  throw new Error('Missing GEMINI_API_KEY in .env');
}

const genAI = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

type DigestAIResult = {
  title: string;
  content: string;
};

function getStartOfTodayLocal(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function getLookbackDate(): Date {
  const hours = Number(process.env.DIGEST_LOOKBACK_HOURS || 24);
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function parseDigestJson(text: string): DigestAIResult {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned) as unknown;

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { title?: unknown }).title !== 'string' ||
    typeof (parsed as { content?: unknown }).content !== 'string'
  ) {
    throw new Error(`Invalid digest JSON: ${cleaned}`);
  }

  return parsed as DigestAIResult;
}

export async function generateDailyDigest() {
  const today = getStartOfTodayLocal();
  const since = getLookbackDate();

  const maxArticles = Number(process.env.DIGEST_MAX_ARTICLES || 50);

  const articles = await prisma.article.findMany({
    where: {
      isRelevant: true,
      createdAt: {
        gte: since,
      },
    },
    orderBy: [
      {
        createdAt: 'desc',
      },
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
ID: ${article.id}
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
Bạn là biên tập viên công nghệ cho DevRadar.

Dưới đây là danh sách bài viết/repo công nghệ đã được hệ thống lọc:

${articleText}

Hãy tạo một bản tin công nghệ tiếng Việt để đọc buổi sáng.

Yêu cầu:
- Chọn 5 đến 10 mục đáng đọc nhất.
- Chia nhóm theo chủ đề nếu phù hợp: AI, Backend, Database, DevTools, Security, Open Source, Web Dev.
- Mỗi mục nên có:
  + Tiêu đề ngắn
  + Tóm tắt 1-2 câu
  + Vì sao đáng đọc
  + Link gốc
- Viết tự nhiên, dễ đọc, không quá học thuật.
- Không bịa thêm thông tin ngoài dữ liệu đã cho.
- Nội dung content nên dùng Markdown.
- Trả về JSON đúng schema.

JSON schema:
{
  "title": "Tiêu đề bản tin",
  "content": "Nội dung bản tin dạng Markdown"
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
          title: {
            type: Type.STRING,
          },
          content: {
            type: Type.STRING,
          },
        },
        required: ['title', 'content'],
      },
    },
  });

  if (!response.text) {
    throw new Error('Gemini returned empty response');
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

export async function disconnectDigestService() {
  await prisma.$disconnect();
}