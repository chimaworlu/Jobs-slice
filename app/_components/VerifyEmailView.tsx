'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatRetryAfter } from '../../lib/format-retry-after';
import { verifyEmailSchema } from '../../lib/validations/auth';
import styles from '../page.module.css';

export default function VerifyEmailView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? '';

  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timeoutId = setTimeout(() => {
      setResendCooldown((seconds) => seconds - 1);
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [resendCooldown]);

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timeoutId = setTimeout(() => {
      setRetryAfterSeconds((seconds) => seconds - 1);
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [retryAfterSeconds]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setRetryAfterSeconds(0);

    const validation = verifyEmailSchema.safeParse({ email, code });

    if (!validation.success) {
      const errors: Record<string, string> = {};
      for (const issue of validation.error.issues) {
        const field = issue.path.join('.');
        if (!errors[field]) errors[field] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, email }),
      });

      const data = await response.json().catch(() => null);

      if (response.status === 429) {
        const retryAfter = typeof data?.retryAfter === 'number' ? data.retryAfter : 0;
        setRetryAfterSeconds(retryAfter);
        return;
      }

      if (!response.ok) {
        setErrorMessage(data?.message ?? 'Something went wrong. Please try again.');
        return;
      }

      router.push('/?view=signin');
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    setErrorMessage(null);
    setIsResending(true);

    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json().catch(() => null);

      if (response.status === 429) {
        const retryAfter = typeof data?.retryAfter === 'number' ? data.retryAfter : 0;
        setResendCooldown(retryAfter);
        return;
      }

      if (!response.ok) {
        setErrorMessage(data?.message ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsResending(false);
    }
  }

  const resendLabel =
    resendCooldown > 0 ? `Resend in ${resendCooldown}s` : isResending ? 'Sending…' : 'Resend code';

  return (
    <main className={styles.main}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <h1 className={styles.title}>Verify your email</h1>

        <p className={styles.description}>
          We sent a verification code to <span className={styles.email}>{email}</span>
        </p>

        <div className={styles.field}>
          <label htmlFor="code" className={styles.label}>
            Verification code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            autoComplete="one-time-code"
            className={styles.input}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setFieldErrors((prev) => ({ ...prev, code: '' }));
            }}
            onBlur={(event) => {
              if (event.target.value.trim() === '') {
                setFieldErrors((prev) => ({
                  ...prev,
                  code: 'Verification code field cannot be empty',
                }));
              }
            }}
          />
          {fieldErrors.code ? <p className={styles.fieldError}>{fieldErrors.code}</p> : null}
        </div>

        <button type="submit" className={styles.button} disabled={isSubmitting}>
          {isSubmitting ? 'Verifying…' : 'Verify email'}
        </button>

        <button
          type="button"
          className={styles.resendButton}
          onClick={handleResend}
          disabled={isResending || resendCooldown > 0}
        >
          {resendLabel}
        </button>

        {retryAfterSeconds > 0 ? (
          <p className={styles.error}>{`Too many attempts. ${formatRetryAfter(retryAfterSeconds)}`}</p>
        ) : errorMessage ? (
          <p className={styles.error}>{errorMessage}</p>
        ) : null}
      </form>
    </main>
  );
}
