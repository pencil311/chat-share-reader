/**
 * Bookmarklet tests.
 *
 * The exporter reads a rendered DOM, so these run it against synthetic Claude
 * share pages in jsdom. Every case asserts on the transcript the bookmarklet
 * copies, not on internals — that's the contract downstream consumers see.
 *
 * The minified build is exercised alongside the source and the two outputs are
 * compared byte-for-byte, so a minifier bug can't ship unnoticed.
 *
 *   node bookmarklet/test/export.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const SOURCE = readFileSync(join(root, "src", "claude-export.js"), "utf8");

const BUILT = join(root, "dist", "bookmarklet.txt");
const MINIFIED = existsSync(BUILT)
  ? decodeURIComponent(readFileSync(BUILT, "utf8").replace(/^javascript:/, ""))
  : null;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** Wrap message rows in a minimal share page. */
function page(body, title = "Test chat") {
  return `<!doctype html><html><head><title>${title} - Claude</title></head>
    <body>${body}</body></html>`;
}

/**
 * Run the exporter against `html` and return what it copied.
 * Console noise is muted — the bookmarklet logs the transcript by design.
 */
function run(html, code = SOURCE) {
  const dom = new JSDOM(html, {
    url: "https://claude.ai/share/test-share-id",
    runScripts: "outside-only",
  });
  const w = dom.window;

  let copied = null;
  Object.defineProperty(w.navigator, "clipboard", {
    value: {
      writeText: (t) => {
        copied = t;
        return Promise.resolve();
      },
    },
    configurable: true,
  });

  const realLog = console.log;
  console.log = () => {};
  try {
    w.eval(code);
  } finally {
    console.log = realLog;
  }

  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          copied,
          transcript: w.__claudeTranscript,
          toast: w.document.getElementById("csr-claude-toast")?.textContent ?? "",
        }),
      0
    )
  );
}

/**
 * Split the copied payload into its Markdown and JSON halves.
 * Assertions about Markdown escaping have to be scoped — the JSON block legitimately
 * contains JSON-escaped forms of the very characters Markdown must leave alone.
 */
function splitPayload(copied) {
  const m = copied.match(/^([\s\S]*?)\n---\n\n(`{3,})json\n([\s\S]*?)\n\2\n?$/);
  assert.ok(m, "payload is not <markdown> --- <json block>");
  return { markdown: m[1], json: m[3] };
}

/** Shorthand: the text of message `i`. */
async function textOf(html, i = 0) {
  const { transcript } = await run(page(html));
  assert.ok(transcript, "no transcript was produced");
  assert.ok(transcript.messages[i], `no message at index ${i}`);
  return transcript.messages[i].text;
}

const userRow = (inner) =>
  `<div class="group/message-row"><div data-testid="user-message">${inner}</div></div>`;

const assistantRow = (inner) =>
  `<div class="group/message-row"><div class="font-claude-response">
     <div class="standard-markdown">${inner}</div>
     <div><button data-testid="action-bar-copy">Copy</button></div>
   </div></div>`;

/* -------------------------------------------------------------------------- */
/* 1. User text is plain text — never Markdown-escaped                         */
/* -------------------------------------------------------------------------- */

console.log("\nUser text is copied verbatim");

await test('a literal backslash survives as "\\yes" in Markdown', async () => {
  const { transcript, copied } = await run(
    page(userRow('<p class="whitespace-pre-wrap">\\yes</p>'))
  );
  // The message body is exactly what was typed: one backslash.
  assert.equal(transcript.messages[0].text, "\\yes");

  const { markdown } = splitPayload(copied);
  assert.ok(markdown.includes("\n\\yes\n"), "Markdown section altered the backslash");
  assert.ok(
    !markdown.includes("\\\\"),
    "user text was Markdown-escaped; it must be copied verbatim"
  );
});

await test('the same backslash is JSON-escaped as "\\\\yes" in the JSON block', async () => {
  const { copied } = await run(
    page(userRow('<p class="whitespace-pre-wrap">\\yes</p>'))
  );
  const { json } = splitPayload(copied);
  // JSON escaping is required here — and is a different thing from Markdown escaping.
  assert.ok(json.includes('"\\\\yes"'), "JSON block did not escape the backslash");
  assert.equal(JSON.parse(json).messages[0].text, "\\yes");
});

await test("Markdown punctuation in user text is not escaped either", async () => {
  const text = await textOf(
    userRow('<p class="whitespace-pre-wrap">use *args, _kwargs_ and a [link](x)</p>')
  );
  assert.equal(text, "use *args, _kwargs_ and a [link](x)");
});

await test("the JSON block parses back to the transcript", async () => {
  const { transcript, copied } = await run(
    page(userRow('<p class="whitespace-pre-wrap">\\yes "quoted" \ttabbed</p>'))
  );
  const { json } = splitPayload(copied);
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(transcript)));
});

/* -------------------------------------------------------------------------- */
/* 2. Blockquotes                                                              */
/* -------------------------------------------------------------------------- */

console.log("\nBlockquotes");

await test("no empty > lines around a quote (whitespace-formatted HTML)", async () => {
  const text = await textOf(
    assistantRow(`<blockquote>
       <p>Watch the stack depth.</p>
     </blockquote>`)
  );
  assert.equal(text, "> Watch the stack depth.");
});

await test("no empty > lines when the quote is wrapped in extra elements", async () => {
  const text = await textOf(
    assistantRow(`<blockquote> <div> <p>Nested and padded.</p> </div> </blockquote>`)
  );
  assert.equal(text, "> Nested and padded.");
});

await test("interior blank lines between quoted paragraphs are kept", async () => {
  const text = await textOf(
    assistantRow(`<blockquote><p>First.</p><p>Second.</p></blockquote>`)
  );
  assert.equal(text, "> First.\n>\n> Second.");
});

await test("a quote next to prose keeps its neighbours", async () => {
  const text = await textOf(
    assistantRow(`<p>Before.</p><blockquote>\n<p>Quoted.</p>\n</blockquote>\n<p>After.</p>`)
  );
  assert.equal(text, "Before.\n\n> Quoted.\n\nAfter.");
});

/* -------------------------------------------------------------------------- */
/* 3. MCP widget chrome                                                        */
/* -------------------------------------------------------------------------- */

console.log("\nMCP widget chrome");

const WIDGET = `<div class="mcp-widget">
  <img src="https://www.google.com/s2/favicons?domain=example.com&amp;sz=32" alt="">
  <div>Connecting to visualize...</div>
</div>`;

await test("a widget block becomes a single [interactive widget] marker", async () => {
  const text = await textOf(
    assistantRow(`<p>Here is a chart:</p>${WIDGET}<p>Done.</p>`)
  );
  assert.equal(text, "Here is a chart:\n\n[interactive widget]\n\nDone.");
});

await test("favicon URLs and status chatter never reach the transcript", async () => {
  const text = await textOf(assistantRow(`<p>Chart:</p>${WIDGET}`));
  assert.ok(!/favicons/.test(text), "favicon URL leaked");
  assert.ok(!/Connecting to/i.test(text), "status text leaked");
  assert.ok(!/!\[/.test(text), "favicon was emitted as an image");
});

await test("adjacent widgets collapse to one marker", async () => {
  const text = await textOf(assistantRow(`${WIDGET}${WIDGET}<p>After.</p>`));
  assert.equal(text, "[interactive widget]\n\nAfter.");
});

await test("a message that is only a widget still produces a message", async () => {
  const text = await textOf(assistantRow(WIDGET));
  assert.equal(text, "[interactive widget]");
});

await test("a favicon beside real text is dropped, not marked", async () => {
  const text = await textOf(
    assistantRow(
      `<p><img src="https://www.google.com/s2/favicons?domain=x.com" alt=""> See <a href="https://x.com">x.com</a> for details.</p>`
    )
  );
  assert.equal(text, "See [x.com](https://x.com) for details.");
});

await test("ordinary images are still kept", async () => {
  const text = await textOf(
    assistantRow(`<p><img src="https://example.com/chart.png" alt="a chart"></p>`)
  );
  assert.equal(text, "![a chart](https://example.com/chart.png)");
});

/* -------------------------------------------------------------------------- */
/* 4. Tool status text                                                         */
/* -------------------------------------------------------------------------- */

console.log("\nTool status text");

await test('"Searched the web" becomes a [searched the web] marker', async () => {
  const text = await textOf(
    assistantRow(`<div><span>Searched the web</span></div><p>Here's what I found.</p>`)
  );
  assert.equal(text, "[searched the web]\n\nHere's what I found.");
});

await test("the raw status string does not survive", async () => {
  const text = await textOf(
    assistantRow(`<div>Searched the web</div><p>Summary.</p>`)
  );
  assert.ok(!/Searched the web/.test(text), "raw status text leaked");
});

await test("repeated search statuses collapse to one marker", async () => {
  const text = await textOf(
    assistantRow(`<div>Searched the web</div><div>Searched the web</div><p>Summary.</p>`)
  );
  assert.equal(text, "[searched the web]\n\nSummary.");
});

await test("transient loading chatter is dropped outright", async () => {
  const text = await textOf(
    assistantRow(`<div>Loading…</div><div>Generating…</div><p>Answer.</p>`)
  );
  assert.equal(text, "Answer.");
});

await test("prose that merely starts with a status word is untouched", async () => {
  const text = await textOf(
    assistantRow(
      `<p>Searching the web for a good analogy is how most people learn this, ` +
        `and the results are usually a mixed bag of tutorials.</p>`
    )
  );
  assert.match(text, /^Searching the web for a good analogy/);
});

/* -------------------------------------------------------------------------- */
/* Regression cover for the rest of the pipeline                               */
/* -------------------------------------------------------------------------- */

console.log("\nCore extraction");

await test("nested response wrappers emit each message once", async () => {
  // font-claude-response is applied at several nesting levels on real pages.
  const { transcript } = await run(
    page(`<div class="group/message-row"><div class="font-claude-response">
       <div class="font-claude-response"><div class="font-claude-response">
         <p>Only once.</p>
       </div></div></div></div>`)
  );
  assert.equal(transcript.messageCount, 1);
  assert.equal(transcript.messages[0].text, "Only once.");
});

await test("roles and order follow the rows", async () => {
  const { transcript } = await run(
    page(
      userRow('<p class="whitespace-pre-wrap">Q1</p>') +
        assistantRow("<p>A1</p>") +
        userRow('<p class="whitespace-pre-wrap">Q2</p>')
    )
  );
  // Spread into this realm's Array — jsdom values carry the VM realm's
  // prototypes, which deepStrictEqual treats as a mismatch.
  const messages = [...transcript.messages];
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user"]
  );
  assert.deepEqual(
    messages.map((m) => m.index),
    [0, 1, 2]
  );
});

await test("code block indentation is preserved", async () => {
  const text = await textOf(
    assistantRow(`<pre><code class="language-python">def f(n):\n    return n</code></pre>`)
  );
  assert.equal(text, "```python\ndef f(n):\n    return n\n```");
});

await test("action-bar chrome never reaches the transcript", async () => {
  const text = await textOf(assistantRow("<p>Answer.</p>"));
  assert.equal(text, "Answer.");
});

await test("an empty page toasts instead of copying silently", async () => {
  const { copied, toast } = await run(page("<div>no conversation here</div>"));
  assert.equal(copied, null);
  assert.match(toast, /Nothing found to copy/);
});

/* -------------------------------------------------------------------------- */
/* Minified build parity                                                       */
/* -------------------------------------------------------------------------- */

console.log("\nMinified build");

if (!MINIFIED) {
  failed++;
  console.error("  ✗ dist/bookmarklet.txt is missing — run `node build.js` first");
} else {
  const FIXTURE = page(
    userRow('<p class="whitespace-pre-wrap">\\yes and   spacing</p>') +
      assistantRow(
        `<p>Text with <code>inline</code>.</p>
         <blockquote>\n<p>Quoted.</p>\n</blockquote>
         ${WIDGET}
         <div>Searched the web</div>
         <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
         <pre><code class="language-js">const a = 1;\n  const b = 2;</code></pre>`
      )
  );

  await test("minified output matches source output byte-for-byte", async () => {
    const a = await run(FIXTURE, SOURCE);
    const b = await run(FIXTURE, MINIFIED);
    assert.ok(a.copied, "source build copied nothing");
    assert.equal(b.copied, a.copied);
  });

  await test("minified build handles the guard paths identically", async () => {
    const empty = page("<div>nothing</div>");
    const a = await run(empty, SOURCE);
    const b = await run(empty, MINIFIED);
    assert.equal(b.toast, a.toast);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed > 0 ? 1 : 0;
