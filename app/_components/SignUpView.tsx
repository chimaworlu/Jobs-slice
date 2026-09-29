'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatRetryAfter } from '../../lib/format-retry-after';
import { signUpSchema } from '../../lib/validations/auth';
import styles from '../page.module.css';

const NAME_LETTERS_REGEX = /^[A-Za-z\s]*$/;

export default function SignUpView() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const isFormFilled =
    name.trim() !== '' && email.trim() !== '' && password !== '' && confirmPassword !== '';

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

    const validation = signUpSchema.safeParse({ name, email, password, confirmPassword });
    const errors: Record<string, string> = {};

    if (!validation.success) {
      for (const issue of validation.error.issues) {
        const field = issue.path.join('.');
        if (!errors[field]) errors[field] = issue.message;
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, confirmPassword }),
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

      router.push(`/?view=verify-email&email=${encodeURIComponent(email)}`);
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className={styles.main}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <h1 className={styles.title}>Create your account</h1>

        <div className={styles.field}>
          <label htmlFor="name" className={styles.label}>
            Full Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            className={styles.input}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key.length > 1) return;
              if (!/^[A-Za-z\s]$/.test(event.key)) {
                setFieldErrors((prev) => ({ ...prev, name: 'Full Name Must Use Only Letters' }));
              }
            }}
            onKeyUp={(event) => {
              const value = event.currentTarget.value;
              if (value !== '' && !NAME_LETTERS_REGEX.test(value)) {
                setFieldErrors((prev) => ({ ...prev, name: 'Full Name Must Use Only Letters' }));
              } else {
                setFieldErrors((prev) => ({ ...prev, name: '' }));
              }
            }}
            onBlur={(event) => {
              const value = event.target.value;

              if (value.trim() === '') {
                setFieldErrors((prev) => ({ ...prev, name: 'Full Name field cannot be empty' }));
                return;
              }

              const result = signUpSchema.shape.name.safeParse(value);

              if (!result.success) {
                setFieldErrors((prev) => ({
                  ...prev,
                  name: result.error.issues[0]?.message ?? '',
                }));
              } else {
                setFieldErrors((prev) => ({ ...prev, name: '' }));
              }
            }}
          />
          {fieldErrors.name ? <p className={styles.fieldError}>{fieldErrors.name}</p> : null}
        </div>

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
              const value = event.target.value;
              setEmail(value);

              if (value === '') {
                setFieldErrors((prev) => ({ ...prev, email: '' }));
                return;
              }

              const atIndex = value.indexOf('@');
              const hasDomainStarted = atIndex !== -1 && value.slice(atIndex + 1).length > 0;

              if (hasDomainStarted) {
                setFieldErrors((prev) => ({ ...prev, email: '' }));
              } else {
                setFieldErrors((prev) => ({ ...prev, email: 'Enter A Valid Email Address' }));
              }
            }}
            onBlur={(event) => {
              if (event.target.value.trim() === '') {
                setFieldErrors((prev) => ({ ...prev, email: 'Email field cannot be empty' }));
              }
            }}
          />
          {fieldErrors.email ? <p className={styles.fieldError}>{fieldErrors.email}</p> : null}
        </div>

        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>
            Password
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
                setFieldErrors((prev) => ({ ...prev, password: 'Password field cannot be empty' }));
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

        <button type="submit" className={styles.button} disabled={isSubmitting || !isFormFilled}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>

        <div className={styles.links}>
          <Link href="/?view=signin" className={styles.link}>
            Already have an account? Sign in
          </Link>
        </div>

        {retryAfterSeconds > 0 ? (
          <p className={styles.error}>{`Too many attempts. ${formatRetryAfter(retryAfterSeconds)}`}</p>
        ) : errorMessage ? (
          <p className={styles.error}>{errorMessage}</p>
        ) : null}
      </form>
    </main>
  );
}
