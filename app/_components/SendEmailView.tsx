'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { sendEmailPayloadSchema } from '../../lib/validations/jobs';
import styles from './jobs.module.css';

const STATUS_REFRESH_MS = 3000;
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'DEAD']);

type FieldName = 'to' | 'subject' | 'message';

interface JobStatus {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

interface SubmittedJob {
  jobId: string;
  alreadyQueued: boolean;
}

export default function SendEmailView() {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedJob, setSubmittedJob] = useState<SubmittedJob | null>(null);

  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const [isAutoRefreshing, setIsAutoRefreshing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState(0);

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, []);

  const isTerminal = jobStatus ? TERMINAL_STATUSES.has(jobStatus.status) : false;
  const shouldRefresh = isAutoRefreshing && !isTerminal && submittedJob !== null;

  // Re-arms after every check (successful or not) until the job reaches a terminal status.
  useEffect(() => {
    if (!shouldRefresh || !submittedJob) return;
    const timeoutId = setTimeout(() => {
      void fetchStatus(submittedJob.jobId);
    }, STATUS_REFRESH_MS);
    return () => clearTimeout(timeoutId);
  }, [shouldRefresh, submittedJob, lastCheckedAt]);

  async function fetchStatus(jobId: string) {
    setIsCheckingStatus(true);

    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setStatusError(data?.message ?? 'Could not load the job status.');
        if (response.status === 404) setIsAutoRefreshing(false);
        return;
      }

      setStatusError(null);
      setJobStatus(data as JobStatus);
    } catch {
      setStatusError('Could not load the job status. Retrying…');
    } finally {
      setIsCheckingStatus(false);
      setLastCheckedAt(Date.now());
    }
  }

  function handleCheckStatus() {
    if (!submittedJob) return;
    setIsAutoRefreshing(true);
    void fetchStatus(submittedJob.jobId);
  }

  function clearFieldError(field: FieldName) {
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function resetForm() {
    setTo('');
    setSubject('');
    setMessage('');
    setIdempotencyKey(crypto.randomUUID());
    setFieldErrors({});
    setErrorMessage(null);
    setSubmittedJob(null);
    setJobStatus(null);
    setStatusError(null);
    setIsAutoRefreshing(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const validation = sendEmailPayloadSchema.safeParse({ to, subject, html: message });

    if (!validation.success) {
      const errors: Partial<Record<FieldName, string>> = {};
      for (const issue of validation.error.issues) {
        const field = (issue.path[0] === 'html' ? 'message' : issue.path[0]) as FieldName;
        if (!errors[field]) errors[field] = issue.path[0] === 'html' ? 'Message is required' : issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    if (!idempotencyKey) {
      setErrorMessage('The form is still loading. Please try again.');
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html: message, idempotencyKey }),
      });

      const data = await response.json().catch(() => null);

      if (response.status === 202 && typeof data?.jobId === 'string') {
        setSubmittedJob({ jobId: data.jobId, alreadyQueued: false });
        return;
      }

      if (response.status === 200 && typeof data?.id === 'string') {
        setSubmittedJob({ jobId: data.id, alreadyQueued: true });
        return;
      }

      setErrorMessage(data?.message ?? 'Something went wrong. Please try again.');
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="send-email-title">
      <h1 id="send-email-title" className={styles.title}>
        Send email
      </h1>
      <p className={styles.description}>
        Emails are queued as jobs and sent by the background worker.
      </p>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        <div className={styles.field}>
          <label htmlFor="to" className={styles.label}>
            To
          </label>
          <input
            id="to"
            name="to"
            type="email"
            autoComplete="email"
            className={styles.input}
            value={to}
            aria-invalid={fieldErrors.to ? true : undefined}
            aria-describedby={fieldErrors.to ? 'to-error' : undefined}
            onChange={(event) => {
              setTo(event.target.value);
              clearFieldError('to');
            }}
          />
          {fieldErrors.to ? (
            <p id="to-error" className={styles.fieldError}>
              {fieldErrors.to}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label htmlFor="subject" className={styles.label}>
            Subject
          </label>
          <input
            id="subject"
            name="subject"
            type="text"
            className={styles.input}
            value={subject}
            aria-invalid={fieldErrors.subject ? true : undefined}
            aria-describedby={fieldErrors.subject ? 'subject-error' : undefined}
            onChange={(event) => {
              setSubject(event.target.value);
              clearFieldError('subject');
            }}
          />
          {fieldErrors.subject ? (
            <p id="subject-error" className={styles.fieldError}>
              {fieldErrors.subject}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label htmlFor="message" className={styles.label}>
            Message
          </label>
          <textarea
            id="message"
            name="message"
            className={styles.textarea}
            value={message}
            placeholder="<p>Hello!</p>"
            aria-invalid={fieldErrors.message ? true : undefined}
            aria-describedby={fieldErrors.message ? 'message-error message-hint' : 'message-hint'}
            onChange={(event) => {
              setMessage(event.target.value);
              clearFieldError('message');
            }}
          />
          <p id="message-hint" className={styles.hint}>
            HTML is supported.
          </p>
          {fieldErrors.message ? (
            <p id="message-error" className={styles.fieldError}>
              {fieldErrors.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          <button type="submit" className={styles.button} disabled={isSubmitting}>
            {isSubmitting ? 'Queuing…' : 'Send email'}
          </button>
          {submittedJob ? (
            <button type="button" className={styles.secondaryButton} onClick={resetForm}>
              Send another email
            </button>
          ) : null}
        </div>

        {errorMessage ? (
          <p className={styles.error} role="alert">
            {errorMessage}
          </p>
        ) : null}
      </form>

      {submittedJob ? (
        <div className={styles.statusCard}>
          <p className={submittedJob.alreadyQueued ? styles.notice : styles.success} role="status">
            {submittedJob.alreadyQueued ? 'This email was already queued. ' : 'Email queued. '}
            Job ID: <span className={styles.mono}>{submittedJob.jobId}</span>
          </p>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={handleCheckStatus}
              disabled={isCheckingStatus}
            >
              {isCheckingStatus ? 'Checking…' : 'Check Status'}
            </button>
          </div>

          <div aria-live="polite">
            {jobStatus ? (
              <dl className={styles.details}>
                <dt>Status</dt>
                <dd>
                  <span className={styles.badge} data-status={jobStatus.status}>
                    {jobStatus.status}
                  </span>
                </dd>
                <dt>Attempts</dt>
                <dd>
                  {jobStatus.attempts} of {jobStatus.maxAttempts}
                </dd>
                {jobStatus.lastError ? (
                  <>
                    <dt>Last error</dt>
                    <dd>{jobStatus.lastError}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}

            {shouldRefresh ? (
              <p className={styles.hint}>Refreshing every {STATUS_REFRESH_MS / 1000} seconds…</p>
            ) : null}
          </div>

          {statusError ? (
            <p className={styles.error} role="alert">
              {statusError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
