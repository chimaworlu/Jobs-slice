'use client';

import { useEffect, useState } from 'react';
import styles from './jobs.module.css';

interface DeadJob {
  id: string;
  payload: unknown;
  lastError: string | null;
  createdAt: string;
}

function readPayloadField(payload: unknown, field: 'to' | 'subject'): string {
  if (payload && typeof payload === 'object' && field in payload) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
  }
  return '—';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function DeadLetterView() {
  const [jobs, setJobs] = useState<DeadJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [requeuedJobId, setRequeuedJobId] = useState<string | null>(null);

  async function loadDeadJobs() {
    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await fetch('/api/jobs/dead', { cache: 'no-store' });
      const data = await response.json().catch(() => null);

      if (!response.ok || !Array.isArray(data?.jobs)) {
        setLoadError(data?.message ?? 'Could not load dead jobs.');
        return;
      }

      setJobs(data.jobs as DeadJob[]);
    } catch {
      setLoadError('Could not load dead jobs.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadDeadJobs();
  }, []);

  async function handleRetry(jobId: string) {
    setRequeuedJobId(null);
    setRetryErrors((prev) => ({ ...prev, [jobId]: '' }));
    setRetryingIds((prev) => new Set(prev).add(jobId));

    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setRetryErrors((prev) => ({ ...prev, [jobId]: data?.message ?? 'Could not retry this job.' }));
        return;
      }

      setJobs((prev) => prev.filter((job) => job.id !== jobId));
      setRequeuedJobId(jobId);
    } catch {
      setRetryErrors((prev) => ({ ...prev, [jobId]: 'Could not retry this job.' }));
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="dead-letter-title" aria-busy={isLoading}>
      <h1 id="dead-letter-title" className={styles.title}>
        Dead letter
      </h1>
      <p className={styles.description}>Jobs that failed on every attempt. Retry one to queue it again.</p>

      <div aria-live="polite">
        {requeuedJobId ? (
          <p className={styles.success} role="status">
            Job requeued: <span className={styles.mono}>{requeuedJobId}</span>
          </p>
        ) : null}
      </div>

      {isLoading ? (
        <p className={styles.hint} role="status">
          Loading dead jobs…
        </p>
      ) : loadError ? (
        <div className={styles.form}>
          <p className={styles.error} role="alert">
            {loadError}
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={() => void loadDeadJobs()}>
              Try again
            </button>
          </div>
        </div>
      ) : jobs.length === 0 ? (
        <p className={styles.empty}>No dead jobs. Everything has been delivered or is still retrying.</p>
      ) : (
        <ul className={styles.list}>
          {jobs.map((job) => {
            const isRetrying = retryingIds.has(job.id);
            const retryError = retryErrors[job.id];

            return (
              <li key={job.id} className={styles.listItem}>
                <dl className={styles.details}>
                  <dt>Job ID</dt>
                  <dd className={styles.mono}>{job.id}</dd>
                  <dt>To</dt>
                  <dd>{readPayloadField(job.payload, 'to')}</dd>
                  <dt>Subject</dt>
                  <dd>{readPayloadField(job.payload, 'subject')}</dd>
                  <dt>Last error</dt>
                  <dd>{job.lastError ?? '—'}</dd>
                  <dt>Created</dt>
                  <dd>{formatDate(job.createdAt)}</dd>
                </dl>

                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => void handleRetry(job.id)}
                    disabled={isRetrying}
                    aria-label={`Retry job ${job.id}`}
                  >
                    {isRetrying ? 'Retrying…' : 'Retry'}
                  </button>
                </div>

                {retryError ? (
                  <p className={styles.error} role="alert">
                    {retryError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
