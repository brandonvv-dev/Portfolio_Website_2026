import { Redis } from '@upstash/redis';

/** Strings in, strings out: counts are parsed on read, so a numeric-looking member is never rewritten. */
export const redis = new Redis({
  url: import.meta.env.KV_REST_API_URL,
  token: import.meta.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
  // One retry, not five: with the store unreachable the default backoff holds a function open for ~4.6 s.
  retry: { retries: 1 },
});

/**
 * Every key starts with this. Dev and production share one store, so a local run writes under its
 * own prefix and can never move the real numbers.
 */
export const p = import.meta.env.DEV ? 'a:dev:' : 'a:';

/**
 * Fixed-window limiter: true once `id` has made more than `max` calls to `name` in `windowSec`.
 * The only key outside analytics.ts, because both the beacon and the login form need it.
 */
export async function limited(name: string, id: string, max: number, windowSec: number): Promise<boolean> {
  const key = `${p}rl:${name}:${id}`;
  const [count] = await redis.pipeline().incr(key).expire(key, windowSec, 'NX').exec<[number, number]>();
  return count > max;
}
