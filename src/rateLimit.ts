/**
 * Per-caller request budget, checked before any work is done.
 *
 * Two windows run together. The short one stops a burst; the long one stops a
 * slow grind that would stay under any per-minute limit and still clear a
 * monthly transfer quota. The incident this guards against was the second
 * shape: sustained volume, not a spike.
 *
 * Accuracy depends on the backend (see kv.ts). With Upstash configured the
 * counters are global and the limit is real. Without it they are per-instance
 * and merely a floor. Either way this runs inside the function, so a rejected
 * request has already cost one invocation — a Vercel WAF rule is the only
 * control that rejects before that.
 */

import { incrementWithTtl } from "./kv.js";
import { LIMITS } from "./limits.js";

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the offending window resets; for the Retry-After header. */
  retryAfterSec?: number;
  /** Which window tripped, for the log line. */
  window?: "short" | "long";
}

/**
 * Identify the caller. A token subject is preferred: it survives IP changes and
 * buckets a person rather than a network. Otherwise the client IP, which on
 * Vercel arrives in x-forwarded-for (Vercel overwrites it, so it can't be
 * spoofed) and on Cloudflare in cf-connecting-ip.
 */
export function callerKey(
  headers: Record<string, string | string[] | undefined>,
  subject?: string
): string {
  if (subject) return subject;

  const pick = (name: string): string | undefined => {
    const v = headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    return s?.split(",")[0]?.trim() || undefined;
  };

  return (
    pick("cf-connecting-ip") ??
    pick("x-real-ip") ??
    pick("x-forwarded-for") ??
    "unknown"
  );
}

export async function checkRateLimit(key: string): Promise<RateLimitVerdict> {
  const { shortWindowSec, shortWindowMax, longWindowSec, longWindowMax } =
    LIMITS.rateLimit;

  const now = Math.floor(Date.now() / 1000);
  // Fixed windows rather than a sliding log: one counter per window, which is
  // a single round trip and cheap enough to sit in front of every request.
  const shortBucket = Math.floor(now / shortWindowSec);
  const longBucket = Math.floor(now / longWindowSec);

  const [shortCount, longCount] = await Promise.all([
    incrementWithTtl(`rl:s:${key}:${shortBucket}`, shortWindowSec),
    incrementWithTtl(`rl:l:${key}:${longBucket}`, longWindowSec),
  ]);

  // A store that is configured but unreachable returns null. Failing open is
  // deliberate: a transient outage shouldn't take the endpoint down, and the
  // response budget still caps the damage per request.
  if (shortCount !== null && shortCount > shortWindowMax) {
    return {
      allowed: false,
      window: "short",
      retryAfterSec: shortWindowSec - (now % shortWindowSec),
    };
  }
  if (longCount !== null && longCount > longWindowMax) {
    return {
      allowed: false,
      window: "long",
      retryAfterSec: longWindowSec - (now % longWindowSec),
    };
  }
  return { allowed: true };
}

/** Deliberately tiny — a 429 still costs origin transfer. */
export function rateLimitBody(verdict: RateLimitVerdict) {
  return {
    error: "rate_limited",
    message: `Too many requests. Retry in ${verdict.retryAfterSec ?? 60}s.`,
  };
}
