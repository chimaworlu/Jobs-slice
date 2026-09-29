import { Ratelimit } from '@upstash/ratelimit';
import IORedis from 'ioredis';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL environment variable is not set');
}

const redisClient = new IORedis(process.env.REDIS_URL);

/**
 * @upstash/ratelimit is built for @upstash/redis's REST client. This adapts
 * a standard ioredis connection (used here since Redis is self-hosted, not
 * Upstash-hosted) to the subset of that interface the library actually
 * calls at runtime: evalsha/eval to run its Lua scripts, with get/set
 * included to satisfy the library's declared type.
 */
const redis = {
  eval: <TArgs extends unknown[], TData = unknown>(script: string, keys: string[], args: TArgs) =>
    redisClient.eval(script, keys.length, ...keys, ...(args as unknown as (string | number)[])) as Promise<TData>,
  evalsha: <TArgs extends unknown[], TData = unknown>(sha1: string, keys: string[], args: TArgs) =>
    redisClient.evalsha(sha1, keys.length, ...keys, ...(args as unknown as (string | number)[])) as Promise<TData>,
  get: <TData>(key: string) => redisClient.get(key) as Promise<TData | null>,
  set: <TData>(key: string, value: TData) => redisClient.set(key, String(value)) as Promise<'OK' | TData | null>,
};

export const signInLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '10 m'),
  prefix: 'ratelimit:sign-in',
});

export const signUpLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '10 m'),
  prefix: 'ratelimit:sign-up',
});

export const passwordResetLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '10 m'),
  prefix: 'ratelimit:password-reset',
});

export const resendLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, '1 m'),
  prefix: 'ratelimit:resend',
});

export async function checkRateLimit(
  limiter: Ratelimit,
  identifier: string
): Promise<{ success: boolean; retryAfter: number }> {
  const { success, reset } = await limiter.limit(identifier);

  if (success) {
    return { success: true, retryAfter: 0 };
  }

  return {
    success: false,
    retryAfter: Math.max(0, Math.ceil((reset - Date.now()) / 1000)),
  };
}
