# Claude share exporter (bookmarklet)

Copies a shared Claude conversation to your clipboard as a Markdown transcript
plus a JSON block in this project's `ChatTranscript` schema — the same shape the
ChatGPT path returns, so whatever consumes it doesn't branch on source.

## Why this isn't part of the MCP server

Claude share links can't be read server-side. Two independent blockers, either
of which alone would be fatal:

1. **Cloudflare.** Any non-browser client gets `403` with
   `cf-mitigated: challenge`. This is confirmed in open issues on
   `anthropics/claude-code` — Claude Code can't read these links either.
2. **Client-side rendering.** Even past the challenge, `claude.ai/share/...`
   ships an HTML shell with meta tags and no conversation. The messages are
   fetched and rendered by JavaScript after load.

So `extractTranscript()` fails fast with `claude_not_supported` for claude.ai
URLs rather than pretending. Your browser has already cleared the challenge and
run the JavaScript by the time you're reading a share page — this runs there.

**Don't try to route around blocker 1.** Header spoofing, proxy services, and
retry loops don't work, and blocker 2 means they wouldn't help if they did.

## Install

```bash
node build.js
```

That writes:

| File | What it is |
|---|---|
| `dist/bookmarklet.txt` | The `javascript:` URL, ready to paste |
| `dist/install.html` | A page with a draggable install button and usage notes |

Open `dist/install.html` and drag the button onto your bookmarks bar
(`Ctrl/Cmd + Shift + B` shows it). Or create a bookmark by hand and paste the
contents of `dist/bookmarklet.txt` as its **URL**.

The build has no dependencies — a bookmarklet that needs `npm install` to
rebuild is one nobody rebuilds. `build.js` strips comments, collapses
whitespace, syntax-checks the result with `new Function`, and asserts the DOM
selectors survived before writing anything.

## Use

1. Open a `claude.ai/share/...` link.
2. **Scroll to the bottom.** Long conversations render lazily; the exporter only
   sees what's in the DOM.
3. Click the bookmarklet.
4. A toast in the bottom-right confirms the message count — or says plainly that
   nothing was found. It never fails silently.
5. Paste anywhere.

The transcript object is also left on `window.__claudeTranscript` and logged to
the console, which is your escape hatch if the clipboard is blocked.

### On any other page

It toasts an explanation and stops. It only works on the share page itself,
because reading the rendered DOM is the entire trick.

## What it produces

````markdown
# Conversation title

**Source:** Claude · **Messages:** 4

[Original share link](https://claude.ai/share/...)

---

## User

...

## Assistant

...

---

```json
{ "source": "claude", "url": "...", "shareId": "...", ... }
```
````

Markdown conversion covers fenced code blocks (with language), inline code,
ordered and unordered lists including nesting, headings, links, bold, italic,
strikethrough, blockquotes, tables, and paragraph breaks.

User turns are copied **verbatim**, with whitespace preserved and no Markdown
escaping — that text is what someone typed, so a literal `\yes` stays `\yes`.
(It appears as `"\\yes"` inside the JSON block, which is correct JSON escaping
and a different thing entirely.)

### Markers

Some things in a conversation aren't text and can't be. Rather than emit their
scaffolding or drop them silently, they collapse to a marker:

| Marker | Replaces |
|---|---|
| `[interactive widget]` | An MCP tool widget — favicon, `Connecting to …` status, and an unreadable embed. Adjacent widgets collapse to one. |
| `[searched the web]` | The `Searched the web` tool-status line. Repeats collapse to one. |
| *(removed)* | Transient chatter — `Loading…`, `Generating…`, `Rendering…` — and bare favicon images sitting in a line of real text. |

Status matching is length-capped, so a paragraph that merely *starts* with
"Searching the web for…" is treated as content, not chrome.

## What to do when it breaks

Claude's markup changes without notice. The exporter is built in layers so a
single change degrades rather than throws, but eventually a selector goes stale.

**Symptom → likely cause:**

| Symptom | Cause | Fix |
|---|---|---|
| "Nothing found to copy" | The turn-wrapper selector is stale | Update `collectRows()` |
| Every message appears 2–10× | A content selector became nested and outermost-only filtering missed it | Check `outermost()` is applied to the new selector |
| "Copy" / "Read aloud" in the text | New chrome `data-testid` | Add it to `CHROME_SELECTOR` |
| Code blocks come out as plain paragraphs | Claude moved off `<pre>` | Extend `customCodeBlock()` |
| Assistant text present but user turns missing | The user-message selector changed | Update `userText()` / the `user-message` check |
| Tool chatter like "Connecting to…" in the text | A new status string | Add a pattern to `TRANSIENT_STATUS` / `SEARCH_STATUS` |
| Real prose replaced by `[interactive widget]` | A content block matched `isWidgetShell()` | Tighten the climb in `reduceWidgets()` |

**How to find the new selectors.** Open a share page, open DevTools, and run:

```js
// How many turn wrappers, and do the counts look sane?
document.querySelectorAll('[class*="group/message-row"]').length;
document.querySelectorAll('[data-testid="user-message"]').length;
document.querySelectorAll('[class*="standard-markdown"]').length;
document.querySelectorAll('[class*="font-claude-response"]').length;
document.querySelectorAll('pre').length;
```

Then inspect one message and look for a stable-looking hook — a `data-testid`
first, a `class*=` substring second. Avoid hashed Tailwind-looking classes.

> **The nesting trap.** On the page this was built against,
> `font-claude-response` matched **48 elements for ~3 messages** — it's applied
> at several nesting levels. Any new content selector must go through
> `outermost()` (drop nodes that have a matching ancestor), or every message is
> emitted once per level. `standard-markdown` is tried first precisely because
> it's the tighter match.

Edit `src/claude-export.js`, run `node build.js`, and reinstall the bookmark —
the URL changes on every build, so the old bookmark keeps the old code.

## Tests

```bash
node bookmarklet/test/export.test.mjs   # or `npm test` from the repo root
```

The exporter reads a rendered DOM, so the tests run it against synthetic share
pages in jsdom and assert on the transcript it copies. They also run the
**minified build** over the same fixtures and compare byte-for-byte, so a
minifier bug can't ship unnoticed. Run `node build.js` first — the tests read
`dist/bookmarklet.txt` for that comparison (`npm run test:bookmarklet` does both).

## Files

```
bookmarklet/
├── src/claude-export.js     readable, commented source — edit this
├── build.js                 minifier + install-page generator
├── test/export.test.mjs     jsdom tests, source and minified
├── dist/bookmarklet.txt     generated
└── dist/install.html        generated
```

`dist/` is generated output. Don't edit it; rebuild instead.
