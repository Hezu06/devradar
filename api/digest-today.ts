import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

type Topic = 'tech' | 'finance' | 'sports' | 'world';

const TOPICS: Topic[] = ['tech', 'finance', 'sports', 'world'];

function getStartOfTodayLocal(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getArticlesByTopic() {
  const entries = await Promise.all(
    TOPICS.map(async (topic) => {
      const articles = await prisma.article.findMany({
        where: {
          topic,
          isRelevant: true,
        },
        orderBy: [
          {
            createdAt: 'desc',
          },
          {
            score: 'desc',
          },
        ],
        take: 12,
        select: {
          id: true,
          source: true,
          externalId: true,
          topic: true,
          title: true,
          url: true,
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

      return [topic, articles] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<Topic, unknown[]>;
}

async function getTopicCounts() {
  const grouped = await prisma.article.groupBy({
    by: ['topic'],
    where: {
      isRelevant: true,
    },
    _count: {
      topic: true,
    },
  });

  return TOPICS.reduce<Record<Topic, number>>((acc, topic) => {
    acc[topic] = grouped.find((item) => item.topic === topic)?._count.topic ?? 0;
    return acc;
  }, {
    tech: 0,
    finance: 0,
    sports: 0,
    world: 0,
  });
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      message: 'Method not allowed',
    });
  }

  try {
    const today = getStartOfTodayLocal();

    const todayDigest = await prisma.dailyDigest.findUnique({
      where: {
        date: today,
      },
    });

    const latestDigest = todayDigest ?? await prisma.dailyDigest.findFirst({
      orderBy: {
        date: 'desc',
      },
    });

    if (!latestDigest) {
      return res.status(404).json({
        ok: false,
        message: 'Chưa có Daily Digest nào.',
      });
    }

    const [articlesByTopic, topicCounts] = await Promise.all([
      getArticlesByTopic(),
      getTopicCounts(),
    ]);

    return res.status(200).json({
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
      message: error instanceof Error ? error.message : 'Unknown error.',
    });
  }
}
