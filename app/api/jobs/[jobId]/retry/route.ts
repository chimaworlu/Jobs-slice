import { NextResponse } from 'next/server';
import { prisma } from '../../../../../lib/db';

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });

    if (!job) {
      return NextResponse.json({ message: 'Job not found.' }, { status: 404 });
    }

    if (job.status !== 'DEAD') {
      return NextResponse.json({ message: 'Only dead jobs can be retried' }, { status: 400 });
    }

    // Guard on status so two concurrent retries cannot both reset the job.
    const { count } = await prisma.job.updateMany({
      where: { id: jobId, status: 'DEAD' },
      data: { status: 'PENDING', runAt: new Date(), lastError: null },
    });

    if (count === 0) {
      return NextResponse.json({ message: 'Only dead jobs can be retried' }, { status: 400 });
    }

    const updatedJob = await prisma.job.findUnique({ where: { id: jobId } });

    console.log('[POST /api/jobs/[jobId]/retry] Dead job reset to PENDING', { jobId });

    return NextResponse.json(updatedJob, { status: 200 });
  } catch (error) {
    console.error('[POST /api/jobs/[jobId]/retry] Failed to retry job', { jobId, error });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again later.' },
      { status: 500 }
    );
  }
}
