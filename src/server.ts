import 'dotenv/config';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3000);

function getStartOfTodayLocal(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

app.use(express.json());

// Serve giao diện ở folder public
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
  const today = getStartOfTodayLocal();

  const todayDigest = await prisma.dailyDigest.findUnique({
    where: {
      date: today,
    },
  });

  if (todayDigest) {
    return res.json({
      ok: true,
      isToday: true,
      digest: todayDigest,
    });
  }

  // Nếu hôm nay chưa có digest, trả về digest mới nhất để UI vẫn có cái đọc
  const latestDigest = await prisma.dailyDigest.findFirst({
    orderBy: {
      date: 'desc',
    },
  });

  if (!latestDigest) {
    return res.status(404).json({
      ok: false,
      message: 'Chưa có Daily Digest nào. Hãy chạy npm run digest trước.',
    });
  }

  return res.json({
    ok: true,
    isToday: false,
    digest: latestDigest,
  });
});

app.get('/articles/latest', async (_req, res) => {
  const articles = await prisma.article.findMany({
    orderBy: {
      createdAt: 'desc',
    },
    take: 30,
    select: {
      id: true,
      source: true,
      title: true,
      url: true,
      summary: true,
      tags: true,
      isRelevant: true,
      score: true,
      author: true,
      createdAt: true,
    },
  });

  res.json({
    ok: true,
    articles,
  });
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