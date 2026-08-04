/**
 * chat-share-reader — Claude share page exporter (browser bookmarklet)
 *
 * WHY THIS EXISTS
 * ---------------
 * claude.ai share links cannot be read server-side. Cloudflare answers every
 * non-browser client with 403 (`cf-mitigated: challenge`), and even past that
 * the page is client-side rendered — the served HTML holds meta tags and
 * nothing else. So instead of fetching the page, we run inside the page the
 * user already has open, where the conversation is fully rendered in the DOM.
 *
 * OUTPUT
 * ------
 * Copies a Markdown transcript plus a JSON block matching this project's
 * `ChatTranscript` type (src/types.ts) — same schema the ChatGPT path emits, so
 * downstream consumers never branch on source.
 *
 * CONSTRAINTS
 * -----------
 * Fully self-contained: claude.ai's CSP blocks injected remote scripts, so
 * everything needed is inlined here. Written with explicit semicolons and no
 * ASI reliance so `build.js` can flatten it to one line safely.
 *
 * DOM CONTRACT (verified against a real share page — see README "when it breaks")
 *   - turn wrapper:  [class*="group/message-row"]      (document order)
 *   - user turn:     row contains [data-testid="user-message"];
 *                    text in p.whitespace-pre-wrap, whitespace significant
 *   - assistant:     [class*="standard-markdown"], falling back to
 *                    [class*="font-claude-response"] — the latter is NESTED
 *                    (48 matches for ~3 messages), so outermost matches only
 *   - chrome:        [data-testid="action-bar-copy"], ...="action-bar-read-aloud",
 *                    ...="page-header"
 *   - attachments:   [data-testid="file-thumbnail"]
 */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------- */
  /* Small helpers                                                          */
  /* ---------------------------------------------------------------------- */

  /** Collapse all whitespace to single spaces and trim. For comparisons only. */
  function norm(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  /** innerText when the element is laid out, textContent otherwise. */
  function readText(el) {
    if (!el) {
      return "";
    }
    var t = el.innerText;
    return typeof t === "string" && t.length ? t : el.textContent || "";
  }

  /**
   * Keep only nodes that have no other match as an ancestor.
   * Without this, nested `font-claude-response` wrappers emit each message
   * once per nesting level.
   */
  function outermost(nodes) {
    var arr = Array.prototype.slice.call(nodes || []);
    return arr.filter(function (n) {
      return !arr.some(function (other) {
        return other !== n && other.contains(n);
      });
    });
  }

  function qsa(root, selector) {
    try {
      return Array.prototype.slice.call(root.querySelectorAll(selector));
    } catch (e) {
      // A selector this browser dislikes must not take the whole export down.
      return [];
    }
  }

  /* ---------------------------------------------------------------------- */
  /* UI chrome removal                                                      */
  /* ---------------------------------------------------------------------- */

  var CHROME_SELECTOR = [
    '[data-testid="action-bar-copy"]',
    '[data-testid="action-bar-read-aloud"]',
    '[data-testid="page-header"]'
  ].join(",");

  /** Button labels that are chrome wherever they appear inside a turn. */
  var CHROME_LABELS = ["copy", "read aloud", "retry", "edit", "copy code"];

  /**
   * True when every scrap of text in `el` comes from chrome descendants — i.e.
   * the element is the action-bar container and holds no message content.
   * This is how "Copy" / "Read aloud" wrappers get dropped whole rather than
   * leaving an empty shell behind.
   */
  function isChromeOnly(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var remaining = norm(el.textContent);
    if (!remaining) {
      return true;
    }
    var chrome = qsa(el, CHROME_SELECTOR);
    for (var i = 0; i < chrome.length; i++) {
      var piece = norm(chrome[i].textContent);
      if (piece) {
        remaining = remaining.split(piece).join(" ");
      }
    }
    return norm(remaining) === "";
  }

  /** Strip UI chrome from a detached clone, in place. */
  function stripChrome(root) {
    qsa(root, CHROME_SELECTOR).forEach(function (el) {
      // Climb to the outermost ancestor that is nothing but chrome, so the
      // action bar's padding wrappers go with it.
      var target = el;
      while (
        target.parentElement &&
        target.parentElement !== root &&
        isChromeOnly(target.parentElement)
      ) {
        target = target.parentElement;
      }
      if (target.parentNode) {
        target.parentNode.removeChild(target);
      }
    });

    // Belt and braces: buttons whose whole label is a known chrome action.
    qsa(root, "button").forEach(function (btn) {
      var label = norm(btn.textContent).toLowerCase();
      var aria = norm(btn.getAttribute("aria-label")).toLowerCase();
      if (!label || CHROME_LABELS.indexOf(label) !== -1) {
        if (btn.parentNode) {
          btn.parentNode.removeChild(btn);
        }
        return;
      }
      if (aria && CHROME_LABELS.indexOf(aria) !== -1 && label.length <= 16) {
        if (btn.parentNode) {
          btn.parentNode.removeChild(btn);
        }
      }
    });

    reduceWidgets(root);

    return root;
  }

  /* ---------------------------------------------------------------------- */
  /* MCP widgets and tool-status chatter                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Claude embeds MCP tool output as live widgets. What lands in the DOM is a
   * favicon, a transient status line, and an iframe/canvas we can't read — none
   * of which is conversation. Rather than emit that noise or silently drop it,
   * collapse the whole block to one marker so a reader knows content was there.
   */
  var WIDGET_MARKER = "[interactive widget]";
  var SEARCH_MARKER = "[searched the web]";

  /** Favicon service used for widget and citation chrome. Never content. */
  var FAVICON_SRC = /google\.com\/s2\/favicons/i;

  /** Painted while a tool runs, then replaced. Never part of the answer. */
  var TRANSIENT_STATUS = [
    /^connecting\b/i,
    /^loading\b/i,
    /^generating\b/i,
    /^rendering\b/i,
    /^starting\b/i,
    /^initializing\b/i
  ];

  var SEARCH_STATUS = [/^search(ed|ing) the web\b/i];

  function matchesAny(patterns, text) {
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Classify a string as tool status, or "" for ordinary prose.
   * The length cap matters: a paragraph that happens to open with "Searching
   * the web for ..." is content, and must not be mistaken for chrome.
   */
  function statusKind(text) {
    var t = norm(text);
    if (!t || t.length > 40) {
      return "";
    }
    if (matchesAny(SEARCH_STATUS, t)) {
      return "search";
    }
    if (matchesAny(TRANSIENT_STATUS, t)) {
      return "transient";
    }
    return "";
  }

  /** An element carrying nothing but widget status chatter (or no text at all). */
  function isWidgetShell(el) {
    var t = norm(el.textContent);
    return !t || statusKind(t) !== "";
  }

  function replaceWithMarker(node, marker) {
    if (!node.parentNode) {
      return;
    }
    var doc = node.ownerDocument;
    var p = doc.createElement("p");
    p.textContent = marker;
    node.parentNode.replaceChild(p, node);
  }

  function reduceWidgets(root) {
    // Favicon-anchored widget blocks.
    qsa(root, "img").forEach(function (img) {
      if (!FAVICON_SRC.test(img.getAttribute("src") || "")) {
        return;
      }
      if (!root.contains(img)) {
        return; // already swallowed by an earlier widget block
      }
      // Climb to the outermost wrapper that is still only widget shell, so the
      // marker replaces the whole block rather than leaving its scaffolding.
      var node = img;
      var climbed = false;
      while (
        node.parentElement &&
        node.parentElement !== root &&
        isWidgetShell(node.parentElement)
      ) {
        node = node.parentElement;
        climbed = true;
      }
      if (climbed) {
        replaceWithMarker(node, WIDGET_MARKER);
      } else if (img.parentNode) {
        // A lone favicon sitting in a line of real text is decoration.
        img.parentNode.removeChild(img);
      }
    });

    // Status lines with no favicon of their own — "Searched the web" and friends.
    qsa(root, "div,span,p,section,li").forEach(function (el) {
      if (!root.contains(el) || el.querySelector("img")) {
        return;
      }
      var kind = statusKind(el.textContent);
      if (!kind) {
        return;
      }
      // Defer to the innermost element holding the status, so a wrapper that
      // also holds real siblings is never removed wholesale.
      if (
        el.children.length &&
        norm(el.children[0].textContent) === norm(el.textContent)
      ) {
        return;
      }
      if (kind === "search") {
        replaceWithMarker(el, SEARCH_MARKER);
      } else if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    });

    return root;
  }

  /* ---------------------------------------------------------------------- */
  /* HTML -> Markdown                                                       */
  /* ---------------------------------------------------------------------- */

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, CANVAS: 1,
    TEMPLATE: 1, IFRAME: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1
  };

  /**
   * Language names accepted as a code-block label. Deliberately a fixed list:
   * Claude's code-block container is UNCONFIRMED on the sample page, so a loose
   * "short text before a code body" rule would misfire on ordinary content.
   */
  var LANGS = {};
  ("text plaintext bash sh shell zsh console powershell ps1 batch cmd " +
   "js javascript jsx ts typescript tsx json json5 jsonc yaml yml toml ini " +
   "html xml svg css scss sass less " +
   "py python rb ruby go golang rust rs java kotlin kt swift objc c cpp " +
   "c++ cs csharp php perl lua r scala dart elixir ex erlang haskell hs " +
   "clojure ocaml fsharp groovy sql graphql proto " +
   "md markdown mdx tex latex diff patch make dockerfile docker nginx " +
   "vim regex csv tsv env"
  ).split(" ").forEach(function (k) {
    LANGS[k] = 1;
  });

  function langFromClass(el) {
    if (!el || !el.getAttribute) {
      return "";
    }
    var cls = el.getAttribute("class") || "";
    var m = /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#._-]+)/.exec(cls);
    return m ? m[1].toLowerCase() : "";
  }

  /** Longest backtick run in `s`, used to pick a fence that can't be broken. */
  function longestTickRun(s) {
    var max = 0;
    var re = /`+/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m[0].length > max) {
        max = m[0].length;
      }
    }
    return max;
  }

  function fenceFor(body) {
    var n = longestTickRun(body);
    return new Array(Math.max(3, n + 1) + 1).join("`");
  }

  function fencedBlock(lang, body) {
    var code = String(body).replace(/\s+$/, "");
    var fence = fenceFor(code);
    return "\n\n" + fence + (lang || "") + "\n" + code + "\n" + fence + "\n\n";
  }

  /**
   * Claude renders a code block as <pre> preceded by a small header showing the
   * language. Detect that header so its text doesn't leak in as a stray line,
   * and reuse it as the fence language.
   */
  function codeHeaderChild(el) {
    var pre = el.querySelector ? el.querySelector("pre") : null;
    if (!pre) {
      return null;
    }
    var kids = Array.prototype.slice.call(el.children || []);
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c === pre || c.contains(pre)) {
        continue;
      }
      var label = norm(c.textContent).toLowerCase();
      if (label && LANGS[label] === 1) {
        return { node: c, lang: label };
      }
    }
    return null;
  }

  /**
   * Fallback for a <pre>-less code container: a wrapper whose first child is a
   * bare language label and whose remainder is the code body. UNCONFIRMED
   * structure, so the gate is tight — a real language name plus a code-ish
   * container — and a miss simply falls through to normal block handling.
   */
  function customCodeBlock(el) {
    if (!el.querySelector || el.querySelector("pre")) {
      return null;
    }
    var kids = Array.prototype.slice.call(el.children || []);
    if (kids.length < 2) {
      return null;
    }
    var label = norm(kids[0].textContent).toLowerCase();
    if (!label || LANGS[label] !== 1) {
      return null;
    }
    var cls = (el.getAttribute("class") || "") + " " +
      (kids[1].getAttribute("class") || "");
    var codeish = /code|font-mono|whitespace-pre/i.test(cls) ||
      !!el.querySelector("code");
    if (!codeish) {
      return null;
    }
    var body = kids.slice(1).map(function (k) {
      return readText(k);
    }).join("\n").replace(/\s+$/, "");
    return body ? { lang: label, code: body } : null;
  }

  /** Serialize the children of `el`, honouring a detected code header. */
  function renderChildren(el, ctx) {
    var header = ctx.pre ? null : codeHeaderChild(el);
    var pre = header ? el.querySelector("pre") : null;
    var out = "";
    var nodes = Array.prototype.slice.call(el.childNodes);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (header && node === header.node) {
        // The header only held the language label; it is now the fence info.
        continue;
      }
      var childCtx = ctx;
      if (pre && node.nodeType === 1 && (node === pre || node.contains(pre))) {
        childCtx = { pre: ctx.pre, lang: header.lang };
      }
      out += render(node, childCtx);
    }
    return out;
  }

  function renderInlineWrap(el, ctx, marker) {
    var inner = renderChildren(el, ctx);
    if (!norm(inner)) {
      return inner;
    }
    // Keep surrounding spaces outside the emphasis markers or Markdown breaks.
    var lead = /^\s*/.exec(inner)[0];
    var tail = /\s*$/.exec(inner)[0];
    var core = inner.slice(lead.length, inner.length - tail.length);
    return lead + marker + core + marker + tail;
  }

  /** Recursive DOM -> Markdown. Blocks pad themselves with \n\n; collapsed later. */
  function render(node, ctx) {
    if (!node) {
      return "";
    }
    if (node.nodeType === 3) {
      var raw = node.nodeValue || "";
      return ctx.pre ? raw : raw.replace(/\s+/g, " ");
    }
    if (node.nodeType !== 1) {
      return "";
    }

    var el = node;
    var tag = el.tagName;
    if (SKIP_TAGS[tag] === 1) {
      return "";
    }
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") {
      return "";
    }

    switch (tag) {
      case "BR":
        return "\n";
      case "HR":
        return "\n\n---\n\n";

      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6": {
        var level = Number(tag.charAt(1));
        var head = norm(renderChildren(el, ctx));
        return head ? "\n\n" + new Array(level + 1).join("#") + " " + head + "\n\n" : "";
      }

      case "P":
        return "\n\n" + renderChildren(el, ctx) + "\n\n";

      case "BLOCKQUOTE": {
        // Block children pad themselves with blank lines, and real markup
        // indents its tags — both would otherwise become empty "> " lines
        // wrapping the quote. Drop whitespace-only lines, collapse the runs,
        // then trim (which clears leading/trailing newlines and spaces alike).
        var quoted = renderChildren(el, ctx)
          .replace(/\n[ \t]+(?=\n)/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (!norm(quoted)) {
          return "";
        }
        var lines = quoted.split("\n").map(function (l) {
          return l.trim() ? "> " + l : ">";
        });
        // Belt and braces — a quote never opens or closes on a bare ">".
        while (lines.length && lines[0] === ">") {
          lines.shift();
        }
        while (lines.length && lines[lines.length - 1] === ">") {
          lines.pop();
        }
        if (!lines.length) {
          return "";
        }
        return "\n\n" + lines.join("\n") + "\n\n";
      }

      case "UL":
      case "OL": {
        var items = Array.prototype.slice.call(el.children || []).filter(function (c) {
          return c.tagName === "LI";
        });
        if (!items.length) {
          return renderChildren(el, ctx);
        }
        var start = parseInt(el.getAttribute("start") || "1", 10);
        if (!isFinite(start)) {
          start = 1;
        }
        var rendered = items.map(function (li, i) {
          var marker = tag === "OL" ? start + i + ". " : "- ";
          var body = renderChildren(li, ctx)
            .replace(/^\n+|\n+$/g, "")
            .replace(/\n{3,}/g, "\n\n")
            // A nested list shouldn't inherit the blank line its block
            // padding added — keep sub-lists tight under their parent item.
            .replace(/\n\n(?=[-*+] |\d+\. )/g, "\n");
          var pad = new Array(marker.length + 1).join(" ");
          var parts = body.split("\n");
          var first = parts.shift() || "";
          var rest = parts.map(function (l) {
            return l ? pad + l : "";
          });
          return marker + first + (rest.length ? "\n" + rest.join("\n") : "");
        });
        return "\n\n" + rendered.join("\n") + "\n\n";
      }

      case "PRE": {
        var codeEl = el.querySelector("code");
        var lang = langFromClass(codeEl) || langFromClass(el) || ctx.lang || "";
        var body = readText(codeEl || el);
        return fencedBlock(lang, body);
      }

      case "CODE": {
        if (ctx.pre) {
          return renderChildren(el, ctx);
        }
        // Bare inline <code> — backticks, never a fenced block.
        var text = (el.textContent || "").replace(/\s*\n\s*/g, " ");
        if (!text) {
          return "";
        }
        var ticks = new Array(longestTickRun(text) + 2).join("`");
        var padded = /^`|`$/.test(text) ? " " + text + " " : text;
        return ticks + padded + ticks;
      }

      case "STRONG":
      case "B":
        return renderInlineWrap(el, ctx, "**");
      case "EM":
      case "I":
        return renderInlineWrap(el, ctx, "*");
      case "DEL":
      case "S":
      case "STRIKE":
        return renderInlineWrap(el, ctx, "~~");

      case "A": {
        var label = renderChildren(el, ctx);
        var href = el.getAttribute("href") || "";
        if (!href || /^javascript:/i.test(href) || href === "#") {
          return label;
        }
        if (!norm(label)) {
          return href;
        }
        if (norm(label) === href) {
          return href;
        }
        return "[" + norm(label) + "](" + href + ")";
      }

      case "IMG": {
        var alt = el.getAttribute("alt") || "";
        var src = el.getAttribute("src") || "";
        if (!src) {
          return alt ? "[image: " + alt + "]" : "";
        }
        // Data URIs would swamp the transcript; name them instead.
        return /^data:/i.test(src)
          ? "[image" + (alt ? ": " + alt : "") + "]"
          : "![" + alt + "](" + src + ")";
      }

      case "TABLE":
        return renderTable(el, ctx);

      case "LI":
        // Reached only for a stray <li> outside a list.
        return "\n\n- " + renderChildren(el, ctx).replace(/^\n+|\n+$/g, "") + "\n\n";

      default: {
        var custom = ctx.pre ? null : customCodeBlock(el);
        if (custom) {
          return fencedBlock(custom.lang, custom.code);
        }
        var inner = renderChildren(el, ctx);
        var display = "";
        try {
          display = (el.ownerDocument.defaultView || window)
            .getComputedStyle(el).display;
        } catch (e) {
          display = "";
        }
        var isBlock = /^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIGURE|FIGCAPTION|DL|DT|DD|ADDRESS|FORM|TBODY|THEAD|TFOOT)$/
          .test(tag) || /^(block|flex|grid|list-item|table)/.test(display);
        return isBlock ? "\n\n" + inner + "\n\n" : inner;
      }
    }
  }

  function renderTable(table, ctx) {
    var rows = qsa(table, "tr");
    if (!rows.length) {
      return "\n\n" + renderChildren(table, ctx) + "\n\n";
    }
    var grid = rows.map(function (tr) {
      return Array.prototype.slice.call(tr.children || []).map(function (cell) {
        return norm(renderChildren(cell, ctx)).replace(/\|/g, "\\|");
      });
    }).filter(function (cells) {
      return cells.length > 0;
    });
    if (!grid.length) {
      return "";
    }
    var width = grid.reduce(function (max, cells) {
      return Math.max(max, cells.length);
    }, 0);
    var pad = function (cells) {
      var copy = cells.slice();
      while (copy.length < width) {
        copy.push("");
      }
      return "| " + copy.join(" | ") + " |";
    };
    var out = [pad(grid[0]), "|" + new Array(width + 1).join(" --- |")];
    for (var i = 1; i < grid.length; i++) {
      out.push(pad(grid[i]));
    }
    return "\n\n" + out.join("\n") + "\n\n";
  }

  /** Entry point: clone, strip chrome, render, tidy blank lines. */
  function toMarkdown(el) {
    var clone;
    try {
      clone = el.cloneNode(true);
      stripChrome(clone);
    } catch (e) {
      clone = el;
    }
    var md = "";
    try {
      md = render(clone, { pre: false, lang: "" });
    } catch (e) {
      md = "";
    }

    // Park fenced blocks before tidying. Indentation and blank lines are
    // load-bearing inside code and must not be normalized away.
    var parked = [];
    // Private-use codepoint: it cannot occur in conversation text.
    var MARK = String.fromCharCode(0xe000);
    md = md.replace(
      /(`{3,})([^\n]*)\n([\s\S]*?)\n\1/g,
      function (match) {
        parked.push(match);
        return MARK + (parked.length - 1) + MARK;
      }
    );

    md = md
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      // Several widgets or repeated tool calls in a row say nothing extra.
      .replace(/(\[interactive widget\]|\[searched the web\])(\n+\1)+/g, "$1")
      .trim();

    md = md.replace(new RegExp(MARK + "(\\d+)" + MARK, "g"), function (_m, i) {
      return parked[Number(i)];
    });

    if (md) {
      return md;
    }
    // Last resort — never return nothing for a node that clearly has text.
    return readText(clone).trim();
  }

  /* ---------------------------------------------------------------------- */
  /* Turn extraction                                                        */
  /* ---------------------------------------------------------------------- */

  var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i;

  function attachmentsIn(root) {
    return qsa(root, '[data-testid="file-thumbnail"]').map(function (el) {
      var name =
        norm(el.getAttribute("title")) ||
        norm(el.getAttribute("aria-label")) ||
        norm(readText(el));
      var att = { kind: IMAGE_EXT.test(name) ? "image" : "file" };
      if (name) {
        att.name = name;
      }
      return att;
    });
  }

  /** User text is authored plain text — preserve its whitespace verbatim. */
  function userText(userEl) {
    var paras = qsa(userEl, "p.whitespace-pre-wrap");
    if (!paras.length) {
      paras = qsa(userEl, '[class*="whitespace-pre-wrap"]');
      paras = outermost(paras);
    }
    if (paras.length) {
      var joined = paras.map(function (p) {
        return readText(p).replace(/\s+$/, "");
      }).filter(function (s) {
        return s.trim();
      }).join("\n\n");
      if (joined.trim()) {
        return joined.trim();
      }
    }
    var clone = userEl.cloneNode(true);
    stripChrome(clone);
    return readText(clone).trim();
  }

  /**
   * Assistant content, tried in order of specificity. Each strategy degrades
   * into the next rather than throwing.
   */
  function assistantText(row) {
    var nodes = outermost(qsa(row, '[class*="standard-markdown"]'));
    if (!nodes.length) {
      nodes = outermost(qsa(row, '[class*="font-claude-response"]'));
    }
    if (!nodes.length) {
      var clone = row.cloneNode(true);
      stripChrome(clone);
      return toMarkdown(clone);
    }
    return nodes.map(toMarkdown).filter(Boolean).join("\n\n").trim();
  }

  function collectRows() {
    var rows = outermost(qsa(document, '[class*="group/message-row"]'));
    if (rows.length) {
      return rows;
    }
    // Degraded path: no row wrappers. Take user and assistant content nodes
    // directly and re-sort them into document order.
    var users = qsa(document, '[data-testid="user-message"]');
    var replies = outermost(qsa(document, '[class*="standard-markdown"]'));
    if (!replies.length) {
      replies = outermost(qsa(document, '[class*="font-claude-response"]'));
    }
    var all = outermost(users.concat(replies));
    all.sort(function (a, b) {
      var rel = a.compareDocumentPosition(b);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });
    return all;
  }

  function buildMessages(rows, warnings) {
    var messages = [];
    var seen = [];

    rows.forEach(function (row) {
      // Guard against a row being counted twice via a nested wrapper.
      if (seen.some(function (s) { return s === row || s.contains(row); })) {
        return;
      }
      seen.push(row);

      var userEl = row.querySelector
        ? row.querySelector('[data-testid="user-message"]')
        : null;
      var isUser = !!userEl ||
        (row.getAttribute && row.getAttribute("data-testid") === "user-message");
      var text = "";
      try {
        text = isUser ? userText(userEl || row) : assistantText(row);
      } catch (e) {
        warnings.push("A turn failed to convert and was captured as plain text.");
        try {
          text = readText(row).trim();
        } catch (e2) {
          text = "";
        }
      }

      var attachments = attachmentsIn(row);
      if (!text && !attachments.length) {
        return;
      }

      var message = {
        index: messages.length,
        role: isUser ? "user" : "assistant",
        text: text,
        contentType: "text",
        createdAt: null
      };
      if (attachments.length) {
        message.attachments = attachments;
      }
      messages.push(message);
    });

    return messages;
  }

  function conversationTitle() {
    var meta = document.querySelector('meta[property="og:title"]');
    var raw = (meta && meta.getAttribute("content")) || document.title || "";
    raw = norm(raw)
      .replace(/\s*[-–—|]\s*Claude$/i, "")
      .replace(/^Claude\s*[-–—|]\s*/i, "");
    return raw || "Untitled conversation";
  }

  function shareIdFromPath() {
    var parts = location.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "shared";
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering the transcript                                               */
  /* ---------------------------------------------------------------------- */

  var ROLE_LABEL = { user: "User", assistant: "Assistant" };

  function transcriptMarkdown(t) {
    var lines = ["# " + t.title, ""];
    var meta = ["**Source:** Claude"];
    if (t.updatedAt) {
      meta.push("**Updated:** " + t.updatedAt);
    }
    meta.push("**Messages:** " + t.messageCount);
    lines.push(meta.join(" · "), "", "[Original share link](" + t.url + ")", "", "---", "");

    t.messages.forEach(function (m) {
      lines.push("## " + (ROLE_LABEL[m.role] || m.role), "");
      if (m.text) {
        lines.push(m.text, "");
      }
      if (m.attachments && m.attachments.length) {
        lines.push("**Attachments:**", "");
        m.attachments.forEach(function (a) {
          lines.push("- " + a.kind + (a.name ? ": " + a.name : ""));
        });
        lines.push("");
      }
    });

    if (t.warnings.length) {
      lines.push("---", "", "> **Extraction notes**", ">");
      t.warnings.forEach(function (w) {
        lines.push("> - " + w);
      });
      lines.push("");
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function payloadFor(transcript) {
    var json = JSON.stringify(transcript, null, 2);
    var fence = fenceFor(json);
    return transcriptMarkdown(transcript) +
      "\n---\n\n" + fence + "json\n" + json + "\n" + fence + "\n";
  }

  /* ---------------------------------------------------------------------- */
  /* Clipboard + toast                                                      */
  /* ---------------------------------------------------------------------- */

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    if (ta.parentNode) {
      ta.parentNode.removeChild(ta);
    }
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }, function () {
        return legacyCopy(text);
      });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function toast(title, detail, tone) {
    var existing = document.getElementById("csr-claude-toast");
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    var accent = tone === "error" ? "#d9534f" : tone === "warn" ? "#c9862a" : "#2f855a";
    var box = document.createElement("div");
    box.id = "csr-claude-toast";
    box.setAttribute("role", "status");
    box.style.cssText = [
      "position:fixed", "z-index:2147483647", "right:20px", "bottom:20px",
      "max-width:360px", "padding:14px 16px", "border-radius:12px",
      "background:#1c1c1c", "color:#f5f5f5", "border-left:4px solid " + accent,
      "box-shadow:0 8px 28px rgba(0,0,0,.35)",
      "font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif",
      "white-space:normal", "pointer-events:auto", "cursor:pointer"
    ].join(";");

    var h = document.createElement("div");
    h.textContent = title;
    h.style.cssText = "font-weight:600;margin-bottom:4px";
    box.appendChild(h);

    if (detail) {
      var p = document.createElement("div");
      p.textContent = detail;
      p.style.cssText = "opacity:.8;font-size:13px";
      box.appendChild(p);
    }

    box.addEventListener("click", function () {
      if (box.parentNode) {
        box.parentNode.removeChild(box);
      }
    });
    document.body.appendChild(box);
    setTimeout(function () {
      if (box.parentNode) {
        box.parentNode.removeChild(box);
      }
    }, tone === "info" ? 5000 : 9000);
  }

  /* ---------------------------------------------------------------------- */
  /* Main                                                                   */
  /* ---------------------------------------------------------------------- */

  function main() {
    var host = location.hostname.replace(/^www\./, "");
    if (host !== "claude.ai" || !/^\/share\//.test(location.pathname)) {
      toast(
        "Not a Claude share page",
        "Open a claude.ai/share/... link and run this there. It reads the " +
          "rendered conversation, so it only works on the share page itself.",
        "error"
      );
      return;
    }

    var warnings = [];
    var rows = collectRows();
    if (!rows.length) {
      warnings.push("No message-row wrappers were found; used a fallback selector.");
    }

    var messages = buildMessages(rows, warnings);
    if (!messages.length) {
      toast(
        "Nothing found to copy",
        "No messages matched on this page. If the conversation is visible, " +
          "Claude's markup has changed — see bookmarklet/README.md, " +
          "\"What to do when it breaks\".",
        "error"
      );
      return;
    }

    // Key order mirrors the ChatGPT path in src/parsers/chatgpt.ts so both
    // sources serialize to the same schema.
    var transcript = {
      source: "claude",
      url: location.origin + location.pathname,
      shareId: shareIdFromPath(),
      title: conversationTitle(),
      model: undefined,
      updatedAt: null,
      messageCount: messages.length,
      messages: messages,
      warnings: warnings
    };

    var payload = payloadFor(transcript);
    try {
      window.__claudeTranscript = transcript;
      console.log("[chat-share-reader] transcript", transcript);
    } catch (e) {
      // Console access is a nicety, never a requirement.
    }

    var users = messages.filter(function (m) {
      return m.role === "user";
    }).length;
    var detail = messages.length + " messages (" + users + " user, " +
      (messages.length - users) + " assistant) — Markdown + JSON on the clipboard.";

    Promise.resolve(copyText(payload)).then(function (ok) {
      if (ok) {
        toast("Copied " + messages.length + " messages", detail, "info");
      } else {
        toast(
          "Couldn't reach the clipboard",
          "The transcript is in the console and on window.__claudeTranscript. " +
            "Click the page once, then run the bookmarklet again.",
          "warn"
        );
      }
    });
  }

  try {
    main();
  } catch (err) {
    try {
      toast("Export failed", String((err && err.message) || err), "error");
    } catch (e) {
      console.error("[chat-share-reader]", err);
    }
  }
})();
