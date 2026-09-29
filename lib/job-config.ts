function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    console.warn(`[job-config] Invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }

  return value;
}

export const JOB_MAX_ATTEMPTS = readPositiveInt('JOB_MAX_ATTEMPTS', 3);
export const JOB_CONCURRENCY = readPositiveInt('JOB_CONCURRENCY', 5);
export const JOB_STUCK_TIMEOUT_MS = readPositiveInt('JOB_STUCK_TIMEOUT_MS', 300000);
export const JOB_BACKOFF_BASE_MS = readPositiveInt('JOB_BACKOFF_BASE_MS', 5000);
export const JOB_SWEEP_INTERVAL_MS = readPositiveInt('JOB_SWEEP_INTERVAL_MS', 60000);
export const JOB_POLL_INTERVAL_MS = readPositiveInt('JOB_POLL_INTERVAL_MS', 1000);

export function getBackoffDelayMs(attempts: number): number {
  return Math.pow(2, attempts) * JOB_BACKOFF_BASE_MS + Math.random() * 1000;
}
