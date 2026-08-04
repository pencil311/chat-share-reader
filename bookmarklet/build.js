#!/usr/bin/env node
/**
 * Builds the Claude export bookmarklet.
 *
 *   node build.js
 *     -> dist/bookmarklet.txt   the javascript: URL, ready to paste
 *     -> dist/install.html      a page with a draggable install link + usage
 *
 * No dependencies on purpose: this repo ships a parser, not a toolchain, and a
 * bookmarklet that needs `npm install` to rebuild is a bookmarklet nobody
 * rebuilds. The minifier below is deliberately conservative — it strips
 * comments and collapses whitespace while tracking string, template, regex and
 * comment state, and it never reorders or rewrites code.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src", "claude-export.js");
const DIST = join(here, "dist");

/* -------------------------------------------------------------------------- */
/* Minifier                                                                    */
/* -------------------------------------------------------------------------- */

/** Characters after which a `/` begins a regex literal rather than division. */
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "~", "^", "<", ">", "\n",
]);

/** Keywords after which a `/` begins a regex literal. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

function startsRegex(out) {
  // Walk back over whitespace already emitted.
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i])) {
    i--;
  }
  if (i < 0) {
    return true;
  }
  const ch = out[i];
  if (REGEX_PRECEDERS.has(ch)) {
    return true;
  }
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(out[j])) {
      j--;
    }
    return REGEX_KEYWORDS.has(out.slice(j + 1, i + 1));
  }
  return false;
}

function minify(source) {
  const out = [];
  // String and regex literals are swapped out for placeholders so the
  // whitespace-tightening pass below can never reach inside them — a literal
  // like "[image: " must survive byte for byte.
  const literals = [];
  const SENTINEL = String.fromCharCode(0);
  let i = 0;
  const n = source.length;

  const push = (s) => out.push(s);
  const pushLiteral = (s) => {
    literals.push(s);
    out.push(SENTINEL + (literals.length - 1) + SENTINEL);
  };
  /** Emit, collapsing runs of whitespace into a single space. */
  const pushSpace = () => {
    const last = out.length ? out[out.length - 1] : "";
    if (last && last !== " ") {
      out.push(" ");
    }
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // --- comments ---
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        i++;
      }
      pushSpace();
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        i++;
      }
      i += 2;
      pushSpace();
      continue;
    }

    // --- whitespace ---
    if (/\s/.test(ch)) {
      i++;
      pushSpace();
      continue;
    }

    // --- strings and template literals ---
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let lit = ch;
      i++;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          lit += c + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        lit += c;
        i++;
        if (c === quote) {
          break;
        }
      }
      pushLiteral(lit);
      continue;
    }

    // --- regex literals ---
    if (ch === "/" && startsRegex(out.join(""))) {
      let lit = "/";
      let inClass = false;
      i++;
      while (i < n) {
        const c = source[i];
        if (c === "\\") {
          lit += c + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        lit += c;
        i++;
        if (c === "[") {
          inClass = true;
        } else if (c === "]") {
          inClass = false;
        } else if (c === "/" && !inClass) {
          break;
        }
      }
      while (i < n && /[a-z]/.test(source[i])) {
        lit += source[i];
        i++;
      }
      pushLiteral(lit);
      continue;
    }

    push(ch);
    i++;
  }

  let code = out.join("");

  // Drop spaces next to punctuation that can never be part of an identifier.
  // Safe here because every string and regex is currently a placeholder.
  code = code.replace(/\s*([(){}\[\];,:])\s*/g, (_m, p) => p);

  // Restore literals.
  const restore = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");
  code = code.replace(restore, (_m, idx) => literals[Number(idx)]);

  if (code.includes(SENTINEL)) {
    throw new Error("Literal placeholder survived into the output.");
  }

  return code.trim();
}

/* -------------------------------------------------------------------------- */
/* Sanity checks                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A broken bookmarklet fails silently in the address bar, so refuse to ship one
 * that doesn't even parse, and confirm the DOM contract survived minification.
 */
function verify(code) {
  // Throws a SyntaxError with a line/column if minification mangled anything.
  new Function(code);

  const required = [
    "group/message-row",
    "user-message",
    "standard-markdown",
    "font-claude-response",
    "action-bar-copy",
    "action-bar-read-aloud",
    "file-thumbnail",
    "whitespace-pre-wrap",
    "clipboard",
    "execCommand",
  ];
  const missing = required.filter((s) => !code.includes(s));
  if (missing.length) {
    throw new Error(`Minified output lost: ${missing.join(", ")}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Install page                                                                */
/* -------------------------------------------------------------------------- */

function installHtml(href, bytes) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install — Claude share exporter</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66;
          --card:#fff; --line:#e5e4e0; --accent:#c96442; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1a18; --fg:#f2f1ee; --muted:#a3a29c; --card:#242422;
            --line:#383834; --accent:#d97757; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:48px 20px; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 .35em; letter-spacing: -.02em; }
  h2 { font-size: 1.05rem; margin: 2.2em 0 .6em; letter-spacing: -.01em; }
  p, li { color: var(--fg); }
  .lede { color: var(--muted); margin-top: 0; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
          padding:24px; margin:28px 0; text-align:center; }
  .drag { display:inline-block; padding:12px 22px; border-radius:10px;
          background:var(--accent); color:#fff; font-weight:600; text-decoration:none;
          cursor:grab; }
  .drag:active { cursor:grabbing; }
  .hint { color:var(--muted); font-size:.875rem; margin:14px 0 0; }
  ol, ul { padding-left: 1.3em; }
  li { margin: .35em 0; }
  code { background:rgba(127,127,127,.16); padding:.15em .4em; border-radius:5px;
         font-size:.9em; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  details { border:1px solid var(--line); border-radius:10px; padding:14px 16px;
            background:var(--card); margin-top:12px; }
  summary { cursor:pointer; font-weight:600; }
  textarea { width:100%; min-height:150px; margin-top:12px; padding:12px;
             border-radius:8px; border:1px solid var(--line); background:var(--bg);
             color:var(--fg); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
             resize:vertical; }
  footer { color:var(--muted); font-size:.85rem; margin-top:40px;
           border-top:1px solid var(--line); padding-top:16px; }
</style>
</head>
<body>
<main>
  <h1>Claude share exporter</h1>
  <p class="lede">Copies a shared Claude conversation as Markdown&nbsp;+&nbsp;JSON,
  straight from the page in your browser.</p>

  <div class="card">
    <a class="drag" href="${href}">📋 Copy Claude chat</a>
    <p class="hint">Drag this button onto your bookmarks bar. ${bytes.toLocaleString()} bytes.</p>
  </div>

  <h2>Why a bookmarklet and not the MCP server?</h2>
  <p>Claude share pages can't be fetched by a server. Cloudflare returns
  <code>403</code> with <code>cf-mitigated: challenge</code> for any non-browser
  client, and the page is client-side rendered — the HTML that arrives contains
  meta tags and no conversation. Your browser has already solved both problems by
  the time you're looking at the page, so the export runs there instead.</p>

  <h2>Install</h2>
  <ol>
    <li>Show your bookmarks bar (<code>Ctrl/Cmd&nbsp;+&nbsp;Shift&nbsp;+&nbsp;B</code>).</li>
    <li>Drag the button above onto it.</li>
    <li>If dragging isn't available, create a bookmark manually and paste the code
      below as its <em>URL</em>.</li>
  </ol>

  <details>
    <summary>Paste the code manually</summary>
    <textarea readonly onclick="this.select()">${href
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</textarea>
  </details>

  <h2>Use</h2>
  <ol>
    <li>Open a <code>claude.ai/share/…</code> link.</li>
    <li>Scroll to the bottom — long conversations render lazily, and the exporter
      only sees what has been rendered.</li>
    <li>Click the bookmarklet. A toast confirms how many messages were copied.</li>
    <li>Paste into your notes, an issue, or another AI chat.</li>
  </ol>

  <h2>What you get</h2>
  <p>One clipboard payload with two parts: a readable Markdown transcript, then a
  fenced <code>json</code> block matching this project's <code>ChatTranscript</code>
  schema — the same shape the ChatGPT path returns, so anything consuming it
  doesn't have to care which platform it came from.</p>

  <h2>If it copies nothing</h2>
  <p>The toast says so explicitly rather than failing quietly. That means Claude's
  markup changed; see <code>bookmarklet/README.md</code> →
  “What to do when it breaks”.</p>

  <footer>Generated by <code>bookmarklet/build.js</code> — do not edit this file;
  edit <code>bookmarklet/src/claude-export.js</code> and rebuild.</footer>
</main>
</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

const source = readFileSync(SRC, "utf8");
const minified = minify(source);

verify(minified);

// `void 0` keeps the expression's value undefined so the browser stays on the
// page instead of navigating to the script's return value.
const href = "javascript:" + encodeURIComponent(minified + ";void 0;");

mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, "bookmarklet.txt"), href, "utf8");
writeFileSync(join(DIST, "install.html"), installHtml(href, href.length), "utf8");

const pct = ((1 - minified.length / source.length) * 100).toFixed(1);
console.log(`source     ${source.length.toLocaleString()} bytes`);
console.log(`minified   ${minified.length.toLocaleString()} bytes  (-${pct}%)`);
console.log(`bookmarklet ${href.length.toLocaleString()} bytes (URL-encoded)`);
console.log(`\nwrote dist/bookmarklet.txt`);
console.log(`wrote dist/install.html    -> open it and drag the button`);
