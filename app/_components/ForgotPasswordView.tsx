'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { formatRetryAfter } from '../../lib/format-retry-after';
import { forgotPasswordSchema } from '../../lib/validations/auth';
import styles from '../page.module.css';

export default function ForgotPasswordView() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timeoutId = setTimeout(() => {
      setRetryAfterSeconds((seconds) => seconds - 1);
    }, 1000);
    return () => clearTimeout(timeoutId);
  }, [retryAfterSeconds]);

  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (event.persisted) {
        setIsSuccess(false);
      }
    }

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setRetryAfterSeconds(0);

    const validation = forgotPasswordSchema.safeParse({ email });

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
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
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

      setIsSuccess(true);
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className={styles.main}>
      {isSuccess ? (
        <div className={styles.form}>
          <h1 className={styles.title}>Forgot password</h1>
          <p className={styles.success}>
            If this email is registered you will receive a password reset link shortly. Check your inbox.
          </p>
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <h1 className={styles.title}>Forgot password</h1>

          <div className={styles.field}>
            <label htmlFor="email" className={styles.label}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              className={styles.input}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setFieldErrors((prev) => ({ ...prev, email: '' }));
              }}
              onBlur={(event) => {
                if (event.target.value.trim() === '') {
                  setFieldErrors((prev) => ({ ...prev, email: 'Email field cannot be empty' }));
                }
              }}
            />
            {fieldErrors.email ? <p className={styles.fieldError}>{fieldErrors.email}</p> : null}
          </div>

          <button type="submit" className={styles.button} disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </button>

          <div className={styles.links}>
            <Link href="/?view=signin" className={styles.link}>
              Remember your password? Sign in
            </Link>
          </div>

          {retryAfterSeconds > 0 ? (
            <p className={styles.error}>{`Too many attempts. ${formatRetryAfter(retryAfterSeconds)}`}</p>
          ) : errorMessage ? (
            <p className={styles.error}>{errorMessage}</p>
          ) : null}
        </form>
      )}
    </main>
  );
}
