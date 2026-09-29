'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatRetryAfter } from '../../lib/format-retry-after';
import { signInSchema } from '../../lib/validations/auth';
import styles from '../page.module.css';

export default function SignInView() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setRetryAfterSeconds(0);

    const validation = signInSchema.safeParse({ email, password });

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
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (!result) {
        setErrorMessage('Something went wrong. Please try again.');
        return;
      }

      if (result.code?.startsWith('rate-limited:')) {
        const retryAfter = Number(result.code.split(':')[1]) || 0;
        setRetryAfterSeconds(retryAfter);
        return;
      }

      if (result.error) {
        setErrorMessage('Invalid email or password.');
        return;
      }

      router.push('/dashboard');
    } catch {
      setErrorMessage('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className={styles.main}>
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <h1 className={styles.title}>Sign in</h1>

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

        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
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

        <button type="submit" className={styles.button} disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>

        <div className={styles.links}>
          <Link href="/?view=forgot-password" className={styles.link}>
            Forgot password?
          </Link>
          <Link href="/?view=signup" className={styles.link}>
            Don&apos;t have an account? Sign up
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
