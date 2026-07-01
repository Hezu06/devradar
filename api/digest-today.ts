import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function getStartOfTodayLocal(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
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

    if (todayDigest) {
      return res.status(200).json({
        ok: true,
        isToday: true,
        digest: todayDigest,
      });
    }

    const latestDigest = await prisma.dailyDigest.findFirst({
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

    return res.status(200).json({
      ok: true,
      isToday: false,
      digest: latestDigest,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}