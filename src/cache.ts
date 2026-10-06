/**
 * Caches the fetched share page by share id.
 *
 * READ THIS BEFORE CREDITING IT WITH THE BANDWIDTH FIX: it does not reduce Fast
 * Origin Transfer. That meter counts bytes between the CDN and the function, so
 * a cache hit still returns a full transcript and costs exactly what a miss
 * costs. What this does buy is real but different — no repeat round trip to
 * ChatGPT, lower function duration (which is separately billed), faster
 * responses, and markedly less load aimed at someone else's servers, which is
 * the neighbourly thing to do when a public endpoint fetches on demand.
 *
 * The bandwidth controls are auth.ts, rateLimit.ts and budget.ts.
 */

import { kvGet, kvSet } from "./kv.js";
import { LIMITS } from "./limits.js";

/** Namespaced so a shared Redis can hold rate-limit counters too. */
function cacheKey(shareUrl: string): string {
  return `share:v1:${shareUrl}`;
}

export async function getCachedPage(shareUrl: string): Promise<string | null> {
  return kvGet(cacheKey(shareUrl));
}

export async function setCachedPage(
  shareUrl: string,
  html: string
): Promise<void> {
  // Share pages run to megabytes. Pushing those into a shared store on every
  // miss trades one bandwidth problem for another, so only modest pages are
  // stored; large ones are simply re-fetched.
  const maxCacheableBytes = 2 * 1024 * 1024;
  if (Buffer.byteLength(html, "utf8") > maxCacheableBytes) return;

  await kvSet(
    cacheKey(shareUrl),
    html,
    Math.floor(LIMITS.shareCacheTtlMs / 1000)
  );
}
