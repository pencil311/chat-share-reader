/**
 * Parser tests using synthetic fixtures that mimic the real payload shapes.
 *
 * These verify the decoding logic (Flight constant-pool rehydration, tree
 * walking, content flattening, role normalization) without hitting the network,
 * so they keep passing when a share link expires. Validate against real links
 * with `npm run dev -- <url>` before deploying.
 */

import assert from "node:assert/strict";

import { parseChatGPT } from "../src/parsers/chatgpt.js";
import { extractTranscript } from "../src/extract.js";
import { toMarkdown } from "../src/markdown.js";
import { assertAllowedUrl } from "../src/fetchPage.js";
import { ShareError } from "../src/types.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(err as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a ChatGPT-style Flight payload. The pool uses integer back-references
 * exactly like the real format: index 0 is unused, then alternating key/value.
 */
function chatgptFlightHtml(): string {
  const conversationData = {
    title: "Testing the parser",
    update_time: 1738000000,
    model: { slug: "gpt-4o" },
    linear_conversation: [{ id: "n1" }, { id: "n2" }, { id: "n3" }],
    mapping: {
      n1: {
        message: {
          id: "m1",
          author: { role: "system" },
          content: { content_type: "text", parts: ["you are helpful"] },
          create_time: 1737999990,
        },
      },
      n2: {
        message: {
          id: "m2",
          author: { role: "user" },
          content: { content_type: "text", parts: ["What is 2+2?"] },
          create_time: 1738000000,
        },
      },
      n3: {
        message: {
          id: "m3",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["It's 4."] },
          create_time: 1738000005,
        },
      },
    },
  };

  // Pool with a back-reference: index 3 holds the data, referenced by integer.
  const pool: unknown[] = [
    null,
    "loaderData",
    {
      "routes/share.$shareId.($action)": {
        sharedConversationId: "abc-123",
        serverResponse: { data: 3 }, // integer -> pool[3]
      },
    },
    conversationData,
  ];

  const encoded = JSON.stringify(JSON.stringify(pool));
  return `<html><body><script>
    self.__next_f = self.__next_f || [];
    streamController.enqueue(${encoded});
  </script></body></html>`;
}

function chatgptLegacyHtml(): string {
  const payload = {
    props: {
      pageProps: {
        serverResponse: {
          data: {
            conversation_id: "legacy-1",
            title: "Old format chat",
            update_time: 1700000000,
            model: { slug: "gpt-4" },
            linear_conversation: [
              {
                message: {
                  author: { role: "user" },
                  content: { content_type: "text", parts: ["hello there"] },
                },
              },
              {
                message: {
                  author: { role: "assistant" },
                  content: { content_type: "text", parts: ["general kenobi"] },
                },
              },
            ],
          },
        },
      },
    },
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    payload
  )}</script></html>`;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

console.log("\nChatGPT — modern Flight format");

test("decodes flight pool and resolves integer back-references", () => {
  const t = parseChatGPT(chatgptFlightHtml(), "https://chatgpt.com/share/abc-123");
  assert.equal(t.source, "chatgpt");
  assert.equal(t.title, "Testing the parser");
  assert.equal(t.model, "gpt-4o");
  assert.equal(t.shareId, "abc-123");
});

test("skips system messages by default", () => {
  const t = parseChatGPT(chatgptFlightHtml(), "https://chatgpt.com/share/abc-123");
  assert.equal(t.messageCount, 2);
  assert.deepEqual(
    t.messages.map((m) => m.role),
    ["user", "assistant"]
  );
});

test("includes system messages when asked", () => {
  const t = parseChatGPT(chatgptFlightHtml(), "https://chatgpt.com/share/abc-123", {
    includeSystem: true,
  });
  assert.equal(t.messageCount, 3);
  assert.equal(t.messages[0].role, "system");
});

test("preserves message text and order", () => {
  const t = parseChatGPT(chatgptFlightHtml(), "https://chatgpt.com/share/abc-123");
  assert.equal(t.messages[0].text, "What is 2+2?");
  assert.equal(t.messages[1].text, "It's 4.");
  assert.deepEqual(t.messages.map((m) => m.index), [0, 1]);
});

test("converts timestamps to ISO-8601", () => {
  const t = parseChatGPT(chatgptFlightHtml(), "https://chatgpt.com/share/abc-123");
  assert.equal(t.messages[0].createdAt, new Date(1738000000 * 1000).toISOString());
});

console.log("\nChatGPT — legacy __NEXT_DATA__ format");

test("falls back to legacy hydration blob", () => {
  const t = parseChatGPT(chatgptLegacyHtml(), "https://chat.openai.com/share/legacy-1");
  assert.equal(t.title, "Old format chat");
  assert.equal(t.messageCount, 2);
  assert.equal(t.messages[1].text, "general kenobi");
});

test("records a warning when using the legacy path", () => {
  const t = parseChatGPT(chatgptLegacyHtml(), "https://chat.openai.com/share/legacy-1");
  assert.ok(t.warnings.some((w) => w.includes("legacy")));
});

test("throws a ShareError when no payload exists", () => {
  assert.throws(
    () => parseChatGPT("<html><body>nothing here</body></html>", "https://chatgpt.com/share/x"),
    (err: unknown) => err instanceof ShareError && err.code === "parse_failed"
  );
});

console.log("\nURL validation");

test("accepts supported hosts", () => {
  assert.doesNotThrow(() => assertAllowedUrl("https://chatgpt.com/share/abc"));
  assert.doesNotThrow(() => assertAllowedUrl("https://claude.ai/share/abc"));
  assert.doesNotThrow(() => assertAllowedUrl("https://chat.openai.com/share/abc"));
});

test("rejects arbitrary hosts (SSRF guard)", () => {
  assert.throws(
    () => assertAllowedUrl("https://evil.example.com/share/abc"),
    (err: unknown) => err instanceof ShareError && err.code === "unsupported_host"
  );
  assert.throws(
    () => assertAllowedUrl("http://169.254.169.254/latest/meta-data"),
    (err: unknown) => err instanceof ShareError
  );
});

test("rejects non-https schemes", () => {
  assert.throws(
    () => assertAllowedUrl("http://chatgpt.com/share/abc"),
    (err: unknown) => err instanceof ShareError && err.code === "invalid_url"
  );
});

console.log("\nMarkdown rendering");

test("renders a readable transcript with metadata", () => {
  const t = parseChatGPT(chatgptFlightHtml(), "https://chatgpt.com/share/abc-123");
  const md = toMarkdown(t);
  assert.ok(md.startsWith("# Testing the parser"));
  assert.ok(md.includes("## User"));
  assert.ok(md.includes("## Assistant"));
  assert.ok(md.includes("What is 2+2?"));
  assert.ok(md.includes("gpt-4o"));
});

/* -------------------------------------------------------------------------- */
/* Claude — unsupported by design                                              */
/* -------------------------------------------------------------------------- */

/**
 * Claude share pages can't be fetched server-side (Cloudflare challenge) and
 * carry no conversation in their HTML anyway (client-side rendering), so the
 * only correct behaviour is an honest, explainable refusal — thrown before any
 * network call. Claude users get bookmarklet/ instead. See parsers/claude.ts.
 */
async function claudeTests(): Promise<void> {
  console.log("\nClaude — refused before fetching");

  await testAsync("rejects claude.ai share links with claude_not_supported", async () => {
    await assert.rejects(
      extractTranscript("https://claude.ai/share/claude-uuid-9"),
      (err: unknown) =>
        err instanceof ShareError && err.code === "claude_not_supported"
    );
  });

  await testAsync("explains the cause and points at the bookmarklet", async () => {
    const err = await extractTranscript("https://claude.ai/share/abc").catch(
      (e: unknown) => e as ShareError
    );
    assert.ok(err instanceof ShareError);
    assert.match(err.message, /Cloudflare/);
    assert.match(err.message, /client-side rendered/);
    assert.match(err.message, /bookmarklet\/README\.md/);
  });

  await testAsync("refuses without making a network request", async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("network access is not expected here");
    }) as typeof fetch;
    try {
      await extractTranscript("https://claude.ai/share/abc").catch(() => undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, false, "extractTranscript fetched a Claude URL");
  });
}

await claudeTests();

console.log(`\n${passed} passed, ${failed} failed\n`);
// Let the process end on its own — process.exit() can abort a still-closing
// handle and trip libuv's UV_HANDLE_CLOSING assertion on Windows.
process.exitCode = failed > 0 ? 1 : 0;
