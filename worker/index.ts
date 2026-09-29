import { prisma } from '../lib/db.ts';
import { sendEmail } from '../lib/email.ts';
import {
  JOB_CONCURRENCY,
  JOB_POLL_INTERVAL_MS,
  JOB_STUCK_TIMEOUT_MS,
  JOB_SWEEP_INTERVAL_MS,
  getBackoffDelayMs,
} from '../lib/job-config.ts';
import { sendEmailPayloadSchema } from '../lib/validations/jobs.ts';

interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  startedAt: Date;
}

let running = 0;
let shuttingDown = false;
let slotWaiters: Array<() => void> = [];

function log(message: string, context: Record<string, unknown>) {
  console.log(`[worker] ${message}`, context);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSlot(): Promise<void> {
  if (running < JOB_CONCURRENCY) {
    return Promise.resolve();
  }

  return new Promise((resolve) => slotWaiters.push(resolve));
}

function releaseSlot() {
  running--;
  const next = slotWaiters.shift();
  next?.();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Claims the oldest due PENDING job in one statement. FOR UPDATE SKIP LOCKED
// lets several workers claim concurrently without ever claiming the same job.
async function claimJob(): Promise<ClaimedJob | null> {
  const rows = await prisma.$queryRaw<ClaimedJob[]>`
    UPDATE "Job"
    SET "status" = 'PROCESSING',
        "startedAt" = (now() AT TIME ZONE 'UTC'),
        "attempts" = "attempts" + 1,
        "updatedAt" = (now() AT TIME ZONE 'UTC')
    WHERE "id" = (
      SELECT "id" FROM "Job"
      WHERE "status" = 'PENDING' AND "runAt" <= (now() AT TIME ZONE 'UTC')
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "type", "payload", "attempts", "maxAttempts", "startedAt"
  `;

  return rows[0] ?? null;
}

async function runJob(job: ClaimedJob): Promise<void> {
  if (job.type !== 'SEND_EMAIL') {
    throw new Error(`Unknown job type: ${job.type}`);
  }

  const payload = sendEmailPayloadSchema.parse(job.payload);
  await sendEmail(payload);
}

async function processJob(job: ClaimedJob): Promise<void> {
  const attempt = job.attempts;
  log('Job claimed', { jobId: job.id, attempt, status: 'PROCESSING' });

  const jobLog = await prisma.jobLog.create({
    data: { jobId: job.id, attempt, status: 'PROCESSING', startedAt: job.startedAt },
  });

  // Only write the outcome if this claim still owns the job. If the sweep has
  // reset it in the meantime, the result of this attempt is discarded.
  const ownsJob = { id: job.id, status: 'PROCESSING' as const, attempts: attempt };

  try {
    await runJob(job);

    const finishedAt = new Date();
    const { count } = await prisma.job.updateMany({
      where: ownsJob,
      data: { status: 'SUCCEEDED', finishedAt, lastError: null },
    });
    await prisma.jobLog.update({
      where: { id: jobLog.id },
      data: { status: 'SUCCEEDED', finishedAt },
    });

    if (count === 0) {
      log('Job succeeded after being reclaimed by sweep', { jobId: job.id, attempt });
      return;
    }

    log('Job succeeded', { jobId: job.id, attempt, status: 'SUCCEEDED' });
  } catch (error) {
    const message = errorMessage(error);
    const finishedAt = new Date();
    const isDead = attempt >= job.maxAttempts;
    const nextRunAt = new Date(Date.now() + getBackoffDelayMs(attempt));

    const { count } = await prisma.job.updateMany({
      where: ownsJob,
      data: isDead
        ? { status: 'DEAD', lastError: message, finishedAt }
        : { status: 'PENDING', lastError: message, runAt: nextRunAt },
    });
    await prisma.jobLog.update({
      where: { id: jobLog.id },
      data: { status: isDead ? 'DEAD' : 'FAILED', error: message, finishedAt },
    });

    if (count === 0) {
      log('Job failed after being reclaimed by sweep', { jobId: job.id, attempt, error: message });
      return;
    }

    if (isDead) {
      log('Job moved to DEAD', { jobId: job.id, attempt, status: 'DEAD', error: message });
    } else {
      log('Job failed, scheduled for retry', {
        jobId: job.id,
        attempt,
        status: 'PENDING',
        error: message,
        runAt: nextRunAt.toISOString(),
      });
    }
  }
}

// Resets jobs whose worker died or hung mid-attempt. The attempt was already
// counted when the job was claimed, so attempts is not incremented again here.
async function sweepStuckJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_STUCK_TIMEOUT_MS);
  const stuckJobs = await prisma.job.findMany({
    where: { status: 'PROCESSING', startedAt: { lt: cutoff } },
    select: { id: true, attempts: true, maxAttempts: true, startedAt: true },
  });

  for (const job of stuckJobs) {
    const message = `Timed out after ${JOB_STUCK_TIMEOUT_MS}ms in PROCESSING`;
    const isDead = job.attempts >= job.maxAttempts;
    const now = new Date();
    const nextRunAt = new Date(now.getTime() + getBackoffDelayMs(job.attempts));

    const { count } = await prisma.job.updateMany({
      where: { id: job.id, status: 'PROCESSING', startedAt: job.startedAt },
      data: isDead
        ? { status: 'DEAD', lastError: message, finishedAt: now }
        : { status: 'PENDING', lastError: message, runAt: nextRunAt },
    });

    if (count === 0) {
      continue;
    }

    await prisma.jobLog.updateMany({
      where: { jobId: job.id, attempt: job.attempts, finishedAt: null },
      data: { status: 'TIMED_OUT', error: message, finishedAt: now },
    });

    log(isDead ? 'Stuck job moved to DEAD' : 'Stuck job reset to PENDING', {
      jobId: job.id,
      attempt: job.attempts,
      status: isDead ? 'DEAD' : 'PENDING',
      error: message,
      ...(isDead ? {} : { runAt: nextRunAt.toISOString() }),
    });
  }
}

async function runSweepSafely() {
  try {
    await sweepStuckJobs();
  } catch (error) {
    console.error('[worker] Stuck job sweep failed', { error });
  }
}

async function pollLoop(): Promise<void> {
  while (!shuttingDown) {
    await waitForSlot();

    if (shuttingDown) {
      break;
    }

    let job: ClaimedJob | null = null;

    try {
      job = await claimJob();
    } catch (error) {
      console.error('[worker] Failed to claim job', { error });
    }

    if (!job) {
      await sleep(JOB_POLL_INTERVAL_MS);
      continue;
    }

    running++;
    const claimed = job;
    processJob(claimed)
      .catch((error) => {
        console.error('[worker] Unexpected error while processing job', {
          jobId: claimed.id,
          attempt: claimed.attempts,
          error,
        });
      })
      .finally(releaseSlot);
  }
}

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log('Shutting down, waiting for in-flight jobs', { signal, running });

  // Unblock the poll loop if it is waiting for a free slot.
  const waiters = slotWaiters;
  slotWaiters = [];
  waiters.forEach((resolve) => resolve());

  while (running > 0) {
    await sleep(100);
  }

  await prisma.$disconnect();
  log('Stopped', { signal });
  process.exit(0);
}

async function main() {
  log('Starting', {
    concurrency: JOB_CONCURRENCY,
    pollIntervalMs: JOB_POLL_INTERVAL_MS,
    sweepIntervalMs: JOB_SWEEP_INTERVAL_MS,
    stuckTimeoutMs: JOB_STUCK_TIMEOUT_MS,
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runSweepSafely();
  const sweepTimer = setInterval(() => void runSweepSafely(), JOB_SWEEP_INTERVAL_MS);

  await pollLoop();
  clearInterval(sweepTimer);
}

main().catch(async (error) => {
  console.error('[worker] Fatal error', { error });
  await prisma.$disconnect();
  process.exit(1);
});
