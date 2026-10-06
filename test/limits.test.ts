/**
 * Tests for the controls added after the 10 GB Fast Origin Transfer incident.
 *
 * The point of each assertion is a byte count or a rejection, not a parse — the
 * parser tests live next door. auth.ts and rateLimit.ts read configuration at
 * import time, so those modules are imported dynamically after the environment
 * is set, which is why this file is async from the top.
 */

import assert from "node:assert/strict";

import { buildWindow } from "../src/budget.js";
import { LIMITS, utf8Bytes } from "../src/limits.js";
import { callerKey } from "../src/rateLimit.js";
import type { ChatTranscript } from "../src/types.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed++;
        console.log(`  ✓ ${name}`);
      },
      (err: Error) => {
        failed++;
        console.error(`  ✗ ${name}\n    ${err.message}`);
      }
    );
}

function transcript(n: number, perMsg: number): ChatTranscript {
  return {
    source: "chatgpt",
    url: "https://chatgpt.com/share/abc",
    shareId: "abc",
    title: "Budget test",
    model: "gpt-4o",
    updatedAt: "2026-10-01T00:00:00.000Z",
    messageCount: n,
    messages: Array.from({ length: n }, (_, i) => ({
      index: i,
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      text: `m${i} `.repeat(Math.ceil(perMsg / 4)).slice(0, perMsg),
      contentType: "text",
      createdAt: null,
    })),
    warnings: [],
  };
}

console.log("\nResponse budget");

await test("a huge conversation stays under the byte ceiling", () => {
  for (const format of ["markdown", "json", "text"] as const) {
    const r = buildWindow(transcript(400, 3000), { format });
    const size = utf8Bytes(r.text);
    assert.ok(
      size <= LIMITS.maxResponseBytes * 1.1,
      `${format} returned ${size} bytes, ceiling ${LIMITS.maxResponseBytes}`
    );
  }
});

await test("the pre-fix payload would have blown the ceiling", () => {
  // Guards the regression itself: this is what the old code returned.
  const full = JSON.stringify(transcript(400, 3000), null, 2);
  assert.ok(utf8Bytes(full) > LIMITS.maxResponseBytes * 10);
});

await test("a short conversation is returned whole and unannotated", () => {
  const r = buildWindow(transcript(6, 200), { format: "markdown" });
  assert.equal(r.returned, 6);
  assert.equal(r.truncated, false);
  assert.ok(!r.text.includes("Showing messages"));
});

await test("paging walks the whole conversation without gaps", () => {
  const total = 130;
  const seen: number[] = [];
  let offset = 0;
  for (let guard = 0; guard < 50 && offset < total; guard++) {
    const r = buildWindow(transcript(total, 500), { offset, format: "markdown" });
    assert.ok(r.returned > 0, "a page must make progress");
    for (let i = 0; i < r.returned; i++) seen.push(offset + i);
    offset += r.returned;
  }
  assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i));
});

await test("markdown pages advertise the next offset", () => {
  const r = buildWindow(transcript(200, 500), { offset: 0, format: "markdown" });
  assert.ok(r.text.includes("Showing messages 0–"));
  assert.ok(r.text.includes(`offset=${r.returned}`));
});

await test("json pages carry a window object instead of prose", () => {
  const r = buildWindow(transcript(200, 500), { offset: 0, format: "json" });
  const parsed = JSON.parse(r.text) as {
    window: { offset: number; returned: number; total: number; nextOffset: number | null };
  };
  assert.equal(parsed.window.offset, 0);
  assert.equal(parsed.window.total, 200);
  assert.equal(parsed.window.nextOffset, parsed.window.returned);
  assert.ok(!r.text.includes("Showing messages"));
});

await test("one pathological message is clamped, not allowed to dominate", () => {
  const t = transcript(3, 10);
  t.messages[1].text = "x".repeat(400_000);
  const r = buildWindow(t, { format: "markdown" });
  assert.ok(utf8Bytes(r.text) <= LIMITS.maxResponseBytes * 1.1);
  assert.ok(r.text.includes("message truncated"));
});

await test("limit is clamped to the hard cap", () => {
  const r = buildWindow(transcript(500, 20), { limit: 99_999, format: "markdown" });
  assert.ok(r.returned <= LIMITS.maxMessageLimit);
});

await test("message count still reports the conversation total", () => {
  const r = buildWindow(transcript(200, 500), { format: "json" });
  const parsed = JSON.parse(r.text) as { messageCount: number };
  assert.equal(parsed.messageCount, 200);
});

console.log("\nCaller identification");

await test("token subject wins over network headers", () => {
  assert.equal(callerKey({ "x-forwarded-for": "1.2.3.4" }, "token:0"), "token:0");
});

await test("falls back through the proxy headers to the client IP", () => {
  assert.equal(callerKey({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }), "9.9.9.9");
  assert.equal(callerKey({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "1.1.1.1");
  assert.equal(callerKey({}), "unknown");
});

console.log("\nAuth gate");

await test("stays open when no token is configured", async () => {
  delete process.env.MCP_AUTH_TOKEN;
  const mod = await import(`../src/auth.js?open=${Date.now()}`);
  assert.equal(mod.authRequired, false);
  assert.equal(mod.checkAuth(undefined).ok, true);
});

await test("rejects a missing or wrong token once configured", async () => {
  process.env.MCP_AUTH_TOKEN = "alpha,beta";
  const mod = await import(`../src/auth.js?gated=${Date.now()}`);
  assert.equal(mod.authRequired, true);
  assert.equal(mod.checkAuth(undefined).ok, false);
  assert.equal(mod.checkAuth("Bearer wrong").ok, false);
  assert.equal(mod.checkAuth("Bearer alph").ok, false, "prefixes must not pass");
});

await test("accepts any configured token and reports an index, never the secret", async () => {
  process.env.MCP_AUTH_TOKEN = "alpha,beta";
  const mod = await import(`../src/auth.js?accept=${Date.now()}`);
  assert.equal(mod.checkAuth("Bearer alpha").subject, "token:0");
  assert.equal(mod.checkAuth("beta").subject, "token:1", "bare token accepted too");
  assert.ok(!JSON.stringify(mod.checkAuth("Bearer alpha")).includes("alpha"));
  delete process.env.MCP_AUTH_TOKEN;
});

console.log("\nRate limiting");

await test("allows a normal burst then rejects with a retry hint", async () => {
  const { checkRateLimit } = await import(`../src/rateLimit.js?rl=${Date.now()}`);
  const key = `test-${Math.random()}`;
  const max = LIMITS.rateLimit.shortWindowMax;

  for (let i = 0; i < max; i++) {
    const v = await checkRateLimit(key);
    assert.equal(v.allowed, true, `request ${i + 1} should be allowed`);
  }
  const over = await checkRateLimit(key);
  assert.equal(over.allowed, false);
  assert.equal(over.window, "short");
  assert.ok((over.retryAfterSec ?? 0) > 0);
});

await test("buckets callers independently", async () => {
  const { checkRateLimit } = await import(`../src/rateLimit.js?rl2=${Date.now()}`);
  const a = `a-${Math.random()}`;
  const b = `b-${Math.random()}`;
  for (let i = 0; i < LIMITS.rateLimit.shortWindowMax; i++) await checkRateLimit(a);
  assert.equal((await checkRateLimit(a)).allowed, false);
  assert.equal((await checkRateLimit(b)).allowed, true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed > 0 ? 1 : 0;
