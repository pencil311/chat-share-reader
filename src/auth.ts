/**
 * Optional bearer-token gate.
 *
 * The endpoint shipped public and unauthenticated. That is the correct shape
 * for "anybody can add this connector", and the wrong shape for a URL that
 * makes an outbound fetch and returns the result: the cost of every anonymous
 * request lands on one personal account with an account-wide quota, and the
 * other projects on that account are collateral.
 *
 * So the gate is opt-in by configuration, not by code change. Set MCP_AUTH_TOKEN
 * and the server requires `Authorization: Bearer <token>`; leave it unset and
 * the server stays open (with rate limiting still applied). The deployment
 * decides, so the same build serves a private instance and a public one.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/** Comma-separated so tokens can be rotated, or handed out per person. */
const RAW_TOKENS = process.env.MCP_AUTH_TOKEN ?? "";

const TOKENS: string[] = RAW_TOKENS.split(",")
  .map((t) => t.trim())
  .filter(Boolean);

export const authRequired = TOKENS.length > 0;

/**
 * Compare without leaking length or position through timing. Node's
 * timingSafeEqual needs equal-length buffers, so both sides are hashed to a
 * fixed width first.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export interface AuthResult {
  ok: boolean;
  /** Stable per-token id for rate-limit bucketing; undefined when open. */
  subject?: string;
}

export function checkAuth(headerValue: string | undefined): AuthResult {
  if (!authRequired) return { ok: true };

  const presented = (headerValue ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!presented) return { ok: false };

  for (let i = 0; i < TOKENS.length; i++) {
    if (constantTimeEquals(presented, TOKENS[i])) {
      // Index, not the token — this ends up in logs and rate-limit keys.
      return { ok: true, subject: `token:${i}` };
    }
  }
  return { ok: false };
}

/** Small on purpose: an unauthorized response still costs origin transfer. */
export const UNAUTHORIZED_BODY = {
  error: "unauthorized",
  message:
    "This MCP endpoint requires a bearer token. Send Authorization: Bearer <token>.",
} as const;
