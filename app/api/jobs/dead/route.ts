import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db';

export async function GET() {
  try {
    const jobs = await prisma.job.findMany({
      where: { status: 'DEAD' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        status: true,
        payload: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        idempotencyKey: true,
        runAt: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ jobs }, { status: 200 });
  } catch (error) {
    console.error('[GET /api/jobs/dead] Failed to fetch dead jobs', { error });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again later.' },
      { status: 500 }
    );
  }
}
