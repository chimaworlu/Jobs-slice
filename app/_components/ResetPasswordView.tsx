'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { resetPasswordSchema } from '../../lib/validations/auth';
import styles from '../page.module.css';

export default function ResetPasswordView() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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

    const validation = resetPasswordSchema.safeParse({ token, password, confirmPassword });

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
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });

      const data = await response.json().catch(() => null);

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

  if (!token) {
    return (
      <main className={styles.main}>
        <div className={styles.form}>
          <h1 className={styles.title}>Reset password</h1>
          <p className={styles.error}>Invalid reset link</p>
          <div className={styles.links}>
            <Link href="/?view=forgot-password" className={styles.link}>
              Back to forgot password
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      {isSuccess ? (
        <div className={styles.form}>
          <h1 className={styles.title}>Reset password</h1>
          <p className={styles.success}>Your password has been reset successfully</p>
          <div className={styles.links}>
            <Link href="/?view=signin" className={styles.link}>
              Sign in
            </Link>
          </div>
        </div>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <h1 className={styles.title}>Reset password</h1>

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>
              New password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              className={styles.input}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((prev) => ({ ...prev, password: '' }));
              }}
              onBlur={(event) => {
                if (event.target.value.trim() === '') {
                  setFieldErrors((prev) => ({
                    ...prev,
                    password: 'New password field cannot be empty',
                  }));
                }
              }}
            />
            {fieldErrors.password ? <p className={styles.fieldError}>{fieldErrors.password}</p> : null}
          </div>

          <div className={styles.field}>
            <label htmlFor="confirmPassword" className={styles.label}>
              Confirm password
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              className={styles.input}
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setFieldErrors((prev) => ({ ...prev, confirmPassword: '' }));
              }}
              onBlur={(event) => {
                if (event.target.value.trim() === '') {
                  setFieldErrors((prev) => ({
                    ...prev,
                    confirmPassword: 'Confirm password field cannot be empty',
                  }));
                }
              }}
            />
            {fieldErrors.confirmPassword ? (
              <p className={styles.fieldError}>{fieldErrors.confirmPassword}</p>
            ) : null}
          </div>

          <button type="submit" className={styles.button} disabled={isSubmitting}>
            {isSubmitting ? 'Resetting…' : 'Reset password'}
          </button>

          {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}
        </form>
      )}
    </main>
  );
}
