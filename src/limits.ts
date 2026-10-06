/**
 * Every tunable that bounds what this server will accept or emit.
 *
 * WHY THIS FILE EXISTS: on 2026-10-05 this project consumed the whole 10 GB
 * Hobby Fast Origin Transfer allowance for a billing period, which is an
 * account-wide quota — it put unrelated projects at risk of being throttled.
 *
 * The Observability numbers for the 30 days to 6 Oct name the cause precisely:
 * 9,500 invocations (~317/day), 0% errors, and incoming transfer at 0.03% of
 * the total. Volume was ordinary and nothing was looping; the average response
 * was 2.01 MB. On the peak day, 1,200 requests moved 2.36 GB. It was response
 * size alone, which is why maxResponseBytes below is the load-bearing number
 * here and the rate limiter is a backstop rather than the fix.
 *
 * The mechanism matters for picking the right fix. Vercel defines Fast Origin
 * Transfer as data moving between the CDN and the Function: incoming = request
 * headers + body, outgoing = response headers + body. It does NOT include what
 * the function itself downloads from a third party, so the (large) ChatGPT
 * share page never counted. Only two things move the number:
 *
 *   1. how many times the function is invoked
 *   2. how many bytes each response carries back to the CDN
 *
 * Note what is NOT on that list: caching the fetched share page. A cache hit
 * still returns the full transcript from the function to the CDN, so it costs
 * exactly the same Fast Origin Transfer as a miss. CDN-level caching, which
 * would genuinely skip the function, does not apply either: MCP is JSON-RPC
 * over POST, and POST responses are not CDN-cacheable. The page cache in
 * cache.ts is still worth having — it cuts latency, function duration and load
 * on ChatGPT — but it is not a bandwidth control, and it should not be
 * mistaken for one.
 *
 * So the controls that actually bound the bill are: auth (auth.ts), rate
 * limiting (rateLimit.ts), and the response budget below.
 */

export const LIMITS = {
  /**
   * Largest JSON-RPC request body accepted. Anything bigger is refused before
   * the MCP server is constructed. Legitimate calls here are a URL and a few
   * flags — well under 1 KB — so this is pure abuse headroom.
   */
  maxRequestBodyBytes: 32 * 1024,

  /**
   * Byte ceiling for the text of a single tool result. The old code returned
   * whole transcripts: a 120-message conversation rendered to ~295 KB, and a
   * few thousand of those alone would clear the monthly allowance. It was also
   * bad for the caller, since that much text lands directly in a model's
   * context.
   */
  maxResponseBytes: 48 * 1024,

  /** Messages returned per read when the caller doesn't say. */
  defaultMessageLimit: 40,

  /** Ceiling on an explicit `limit`; the byte budget still applies on top. */
  maxMessageLimit: 200,

  /**
   * Longest single message kept intact. One pathological message can't be
   * paginated around, so it gets truncated with an explicit marker rather than
   * silently eating the whole budget.
   */
  maxMessageChars: 12_000,

  /** Share-page cache: entry lifetime and how many to keep per instance. */
  shareCacheTtlMs: 15 * 60 * 1000,
  shareCacheMaxEntries: 64,

  /**
   * Per-IP request budget. Two windows: a short one to stop bursts, a long one
   * to stop a slow grind that would still clear the quota over a month.
   */
  rateLimit: {
    shortWindowSec: 60,
    shortWindowMax: 20,
    longWindowSec: 60 * 60,
    longWindowMax: 120,
  },
} as const;

/** Bytes in a UTF-8 string, which is what the transfer meter actually counts. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
