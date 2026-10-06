/**
 * Minimal counter/value store with two backends, chosen at runtime.
 *
 * Serverless makes shared state awkward: every invocation may land on a fresh
 * instance, so a module-level Map is per-instance and an attacker spread across
 * instances slips past it. That makes in-memory counting a best-effort floor,
 * not a guarantee — which is exactly why it is the fallback and not the plan.
 *
 * When UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, counters
 * become global and the rate limiter is real. Upstash is reached over plain
 * HTTP `fetch` with no SDK, so this same file works unchanged on Vercel, on
 * Cloudflare Workers, or in a local Node process.
 *
 * Neither backend is the strongest control available on Vercel: a WAF rate
 * limit rule rejects at the edge and costs zero Fast Origin Transfer, whereas
 * anything in this file has already paid for an invocation. See README.
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const kvBackend: "upstash" | "memory" =
  UPSTASH_URL && UPSTASH_TOKEN ? "upstash" : "memory";

/* ------------------------------- in-memory -------------------------------- */

interface MemEntry {
  value: string;
  expiresAt: number;
}

const mem = new Map<string, MemEntry>();

function memSweep(now: number): void {
  if (mem.size < 512) return;
  for (const [k, v] of mem) if (v.expiresAt <= now) mem.delete(k);
}

/* -------------------------------- upstash --------------------------------- */

async function upstash(command: unknown[]): Promise<unknown> {
  const res = await fetch(UPSTASH_URL!, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    // A rate limiter that hangs is worse than one that misses.
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}`);
  return ((await res.json()) as { result: unknown }).result;
}

/* --------------------------------- api ------------------------------------ */

/**
 * Increment `key`, setting a TTL on first write, and return the new count.
 *
 * Returns null if a shared backend was configured but unreachable. Callers
 * decide what that means; this module does not fail the request on its own,
 * because a store outage shouldn't take the whole endpoint down.
 */
export async function incrementWithTtl(
  key: string,
  ttlSec: number
): Promise<number | null> {
  if (kvBackend === "upstash") {
    try {
      const [count] = (await upstash([
        ["INCR", key],
        ["EXPIRE", key, ttlSec, "NX"],
      ])) as unknown as [number];
      return typeof count === "number" ? count : null;
    } catch {
      return null;
    }
  }

  const now = Date.now();
  memSweep(now);
  const existing = mem.get(key);
  if (!existing || existing.expiresAt <= now) {
    mem.set(key, { value: "1", expiresAt: now + ttlSec * 1000 });
    return 1;
  }
  const next = Number(existing.value) + 1;
  existing.value = String(next);
  return next;
}

/** Read a cached string, or null when absent or expired. */
export async function kvGet(key: string): Promise<string | null> {
  if (kvBackend === "upstash") {
    try {
      const v = await upstash(["GET", key]);
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }
  const entry = mem.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) mem.delete(key);
    return null;
  }
  return entry.value;
}

/** Write a string with a TTL. Failures are swallowed: a cache is optional. */
export async function kvSet(
  key: string,
  value: string,
  ttlSec: number
): Promise<void> {
  if (kvBackend === "upstash") {
    try {
      await upstash(["SET", key, value, "EX", ttlSec]);
    } catch {
      /* ignore */
    }
    return;
  }
  memSweep(Date.now());
  mem.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}

/** Test seam. */
export function __clearMemory(): void {
  mem.clear();
}
