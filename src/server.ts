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

async function getArticlesByTopic() {
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
        },
        orderBy: [
          { createdAt: 'desc' },
          { score: 'desc' },
        ],
        take: 12,
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

async function getTopicCounts() {
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

    const [articlesByTopic, topicCounts] = await Promise.all([
      getArticlesByTopic(),
      getTopicCounts(),
    ]);

    return res.json({
      ok: true,
      isToday: Boolean(todayDigest),
      digest: latestDigest,
      topics: TOPICS,
      topicCounts,
      articlesByTopic,
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
