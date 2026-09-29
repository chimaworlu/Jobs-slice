import { NextResponse } from 'next/server';
import { prisma } from '../../../../lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  try {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        type: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        runAt: true,
        startedAt: true,
        finishedAt: true,
        createdAt: true,
      },
    });

    if (!job) {
      return NextResponse.json({ message: 'Job not found.' }, { status: 404 });
    }

    return NextResponse.json(job, { status: 200 });
  } catch (error) {
    console.error('[GET /api/jobs/[jobId]] Failed to fetch job', { jobId, error });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again later.' },
      { status: 500 }
    );
  }
}
