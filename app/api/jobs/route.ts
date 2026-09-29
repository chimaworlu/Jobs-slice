import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/db';
import { JOB_MAX_ATTEMPTS } from '../../../lib/job-config';
import { enqueueJobSchema } from '../../../lib/validations/jobs';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const validation = enqueueJobSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        message: validation.error.issues[0]?.message ?? 'Invalid request.',
        errors: validation.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 }
    );
  }

  const { to, subject, html, idempotencyKey } = validation.data;

  try {
    const existingJob = await prisma.job.findUnique({ where: { idempotencyKey } });

    if (existingJob) {
      return NextResponse.json(existingJob, { status: 200 });
    }

    const job = await prisma.job.create({
      data: {
        type: 'SEND_EMAIL',
        payload: { to, subject, html },
        status: 'PENDING',
        attempts: 0,
        maxAttempts: JOB_MAX_ATTEMPTS,
        idempotencyKey,
        runAt: new Date(),
      },
    });

    return NextResponse.json({ jobId: job.id, status: 'PENDING' }, { status: 202 });
  } catch (error) {
    // A concurrent request with the same key won the insert race.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existingJob = await prisma.job.findUnique({ where: { idempotencyKey } }).catch(() => null);

      if (existingJob) {
        return NextResponse.json(existingJob, { status: 200 });
      }
    }

    console.error('[POST /api/jobs] Failed to enqueue job', { idempotencyKey, to, error });

    return NextResponse.json(
      { message: 'Something went wrong. Please try again later.' },
      { status: 500 }
    );
  }
}
