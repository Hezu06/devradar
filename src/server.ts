import 'dotenv/config';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3000);

type Topic = 'tech' | 'finance' | 'sports' | 'world';

const TOPICS: Topic[] = ['tech', 'finance', 'sports', 'world'];

function getStartOfTodayLocal(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function getDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getNextDay(date: Date): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function getArticlesByTopic(date: Date) {
  const start = date;
  const end = getNextDay(date);

  const articlesByTopic: Record<Topic, unknown[]> = {
    tech: [],
    finance: [],
    sports: [],
    world: [],
  };

  await Promise.all(
    TOPICS.map(async (topic) => {
      const articles = await prisma.article.findMany({
        where: {
          topic,
          isRelevant: true,
          createdAt: {
            gte: start,
            lt: end,
          },
        },
        orderBy: [
          { createdAt: 'desc' },
          { score: 'desc' },
        ],
        take: 40,
        select: {
          id: true,
          source: true,
          externalId: true,
          topic: true,
          title: true,
          url: true,
          imageUrl: true,
          summary: true,
          tags: true,
          isRelevant: true,
          author: true,
          score: true,
          publishedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      articlesByTopic[topic] = articles;
    }),
  );

  return articlesByTopic;
}

async function getTopicCounts(date: Date) {
  const start = date;
  const end = getNextDay(date);

  const topicCounts: Record<Topic, number> = {
    tech: 0,
    finance: 0,
    sports: 0,
    world: 0,
  };

  const grouped = await prisma.article.groupBy({
    by: ['topic'],
    where: {
      isRelevant: true,
      createdAt: {
        gte: start,
        lt: end,
      },
    },
    _count: {
      topic: true,
    },
  });

  for (const item of grouped) {
    const topic = item.topic as Topic;

    if (TOPICS.includes(topic)) {
      topicCounts[topic] = item._count.topic;
    }
  }

  return topicCounts;
}

async function buildDigestPayload(digest: {
  id: number;
  date: Date;
  title: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  const todayKey = getDateKey(getStartOfTodayLocal());
  const digestKey = getDateKey(digest.date);

  const [articlesByTopic, topicCounts] = await Promise.all([
    getArticlesByTopic(digest.date),
    getTopicCounts(digest.date),
  ]);

  return {
    ok: true,
    isToday: todayKey === digestKey,
    digest,
    topics: TOPICS,
    topicCounts,
    articlesByTopic,
  };
}

app.use(express.json());
app.use(express.static('public'));

app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'devradar-api',
  });
});

app.get('/digest/today', async (_req, res) => {
  try {
    const today = getStartOfTodayLocal();

    const todayDigest = await prisma.dailyDigest.findUnique({
      where: {
        date: today,
      },
    });

    const latestDigest =
      todayDigest ??
      (await prisma.dailyDigest.findFirst({
        orderBy: {
          date: 'desc',
        },
      }));

    if (!latestDigest) {
      return res.status(404).json({
        ok: false,
        message: 'Chưa có Daily Digest nào. Hãy chạy npm run daily trước.',
      });
    }

    return res.json(await buildDigestPayload(latestDigest));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/digest/by-date/:date', async (req, res) => {
  try {
    const date = parseDateKey(req.params.date);

    if (!date) {
      return res.status(400).json({
        ok: false,
        message: 'Date phải có dạng YYYY-MM-DD.',
      });
    }

    const digest = await prisma.dailyDigest.findUnique({
      where: {
        date,
      },
    });

    if (!digest) {
      return res.status(404).json({
        ok: false,
        message: 'Không tìm thấy digest cho ngày này.',
      });
    }

    return res.json(await buildDigestPayload(digest));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/digests/archive', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 30), 60);

    const digests = await prisma.dailyDigest.findMany({
      orderBy: {
        date: 'desc',
      },
      take: Number.isNaN(limit) ? 30 : limit,
      select: {
        id: true,
        date: true,
        title: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({
      ok: true,
      digests,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/articles/latest', async (_req, res) => {
  try {
    const articles = await prisma.article.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      take: 30,
      select: {
        id: true,
        source: true,
        externalId: true,
        topic: true,
        title: true,
        url: true,
        imageUrl: true,
        summary: true,
        tags: true,
        isRelevant: true,
        score: true,
        author: true,
        publishedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({
      ok: true,
      articles,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 DevRadar API đang chạy tại http://localhost:${PORT}`);
  console.log(`📰 Daily Digest: http://localhost:${PORT}/digest/today`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
