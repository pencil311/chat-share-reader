/**
 * UNREACHABLE FROM THE FETCH PATH — kept deliberately, not dead-by-accident.
 *
 * `extractTranscript` throws `claude_not_supported` for claude.ai URLs before it
 * ever fetches, so nothing calls `parseClaude` anymore. Two blockers, either of
 * which alone would be fatal:
 *
 *   1. Cloudflare returns 403 with `cf-mitigated: challenge` to every
 *      non-browser client. Confirmed in open issues on anthropics/claude-code —
 *      Claude Code can't read these links either. Do not try to work around
 *      this: no header spoofing, no proxy services, no retry loops.
 *   2. Even past the challenge, claude.ai/share is client-side rendered. The
 *      served HTML carries meta tags and nothing else; the conversation is
 *      fetched and rendered by JS after load, so there is no payload in the
 *      document for this file to find.
 *
 * Claude users get `bookmarklet/` instead, which runs in their own browser
 * against the already-rendered page.
 *
 * This file survives because blocker 2 is what makes it useless, and blocker 2
 * is a rendering choice. If Anthropic ever exposes a public share API or ships
 * server-rendered share pages with an embedded payload, the shape-matching logic
 * below is the starting point — reconnect it in `extractTranscript` rather than
 * rewriting it from scratch.
 */

import {
  extractScripts,
  readJsonString,
  safeParse,
  isObj,
  findAll,
  toIso,
  type Json,
} from "../htmlJson.js";
import {
  ShareError,
  DEFAULT_OPTIONS,
  type ChatMessage,
  type ChatTranscript,
  type ExtractOptions,
  type Role,
  type Attachment,
} from "../types.js";

/* -------------------------------------------------------------------------- */
/* Payload harvesting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Claude.ai ships hydration data as RSC chunks pushed onto `self.__next_f`.
 * Concatenating the decoded chunk strings reconstructs the Flight stream, which
 * contains the conversation JSON inline.
 */
function collectRscText(html: string): string {
  const parts: string[] = [];
  const MARKER = "__next_f.push(";

  for (const { text } of extractScripts(html)) {
    if (!text.includes(MARKER)) continue;
    let cursor = 0;
    while (true) {
      const anchor = text.indexOf(MARKER, cursor);
      if (anchor === -1) break;
      // Payload form: __next_f.push([1,"<json-encoded chunk>"])
      const quotePos = text.indexOf('"', anchor);
      if (quotePos === -1) break;
      const read = readJsonString(text, quotePos);
      if (read) {
        parts.push(read.value);
        cursor = read.end;
      } else {
        cursor = anchor + MARKER.length;
      }
    }
  }
  return parts.join("");
}

/**
 * Scan text for balanced JSON objects/arrays and return the ones that parse.
 * Used when the payload isn't reachable by a known key path — we look for the
 * data by shape instead, so a front-end redesign doesn't break extraction.
 */
function findBalancedJson(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function harvestJsonCandidates(text: string, markers: string[], maxAttempts = 4000): Json[] {
  const results: Json[] = [];
  if (!markers.some((m) => text.includes(m))) return results;

  let attempts = 0;
  for (let i = 0; i < text.length && attempts < maxAttempts; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    // Cheap prefilter: only bother where an object/array of substance begins.
    const peek = text.slice(i, i + 3);
    if (!/^[[{]\s*["[{]/.test(peek)) continue;

    attempts++;
    const slice = findBalancedJson(text, i);
    if (!slice) continue;
    if (!markers.some((m) => slice.includes(m))) continue;

    const parsed = safeParse(slice);
    if (parsed !== undefined) {
      results.push(parsed);
      i += slice.length - 1; // skip past what we consumed
    }
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Shape detection                                                             */
/* -------------------------------------------------------------------------- */

const MESSAGE_ARRAY_KEYS = ["chat_messages", "messages"];

function looksLikeMessage(node: unknown): boolean {
  if (!isObj(node)) return false;
  const hasSpeaker =
    typeof node.sender === "string" || typeof node.role === "string";
  const hasBody =
    typeof node.text === "string" ||
    Array.isArray(node.content) ||
    typeof node.content === "string";
  return hasSpeaker && hasBody;
}

/** A conversation node has an array of things that look like messages. */
function isConversationNode(node: Record<string, Json>): boolean {
  for (const key of MESSAGE_ARRAY_KEYS) {
    const arr = node[key];
    if (Array.isArray(arr) && arr.length > 0 && arr.some(looksLikeMessage)) {
      return true;
    }
  }
  return false;
}

function getMessageArray(node: Record<string, Json>): Json[] {
  for (const key of MESSAGE_ARRAY_KEYS) {
    const arr = node[key];
    if (Array.isArray(arr) && arr.some(looksLikeMessage)) return arr;
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function normalizeRole(raw: unknown): Role {
  if (raw === "human" || raw === "user") return "user";
  if (raw === "assistant" || raw === "ai") return "assistant";
  if (raw === "system") return "system";
  if (raw === "tool") return "tool";
  return "unknown";
}

function flattenClaudeContent(
  msg: Record<string, Json>,
  opts: Required<ExtractOptions>
): { text: string; attachments: Attachment[]; contentType?: string } {
  const attachments: Attachment[] = [];

  // Files attached to the turn.
  for (const key of ["files", "attachments"]) {
    const arr = msg[key];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (!isObj(f)) continue;
      const name =
        (typeof f.file_name === "string" && f.file_name) ||
        (typeof f.name === "string" && f.name) ||
        undefined;
      attachments.push({ kind: "file", name });
    }
  }

  const content = msg.content;

  // Modern form: an array of typed blocks.
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    const types: string[] = [];

    for (const block of content) {
      if (typeof block === "string") {
        chunks.push(block);
        continue;
      }
      if (!isObj(block)) continue;
      const type = typeof block.type === "string" ? block.type : "text";
      types.push(type);

      switch (type) {
        case "text":
          if (typeof block.text === "string") chunks.push(block.text);
          break;
        case "thinking":
        case "redacted_thinking":
          if (opts.includeReasoning && typeof block.thinking === "string") {
            chunks.push(`> **Thinking**\n>\n> ${block.thinking.replace(/\n/g, "\n> ")}`);
          }
          break;
        case "tool_use":
          if (opts.includeToolOutput) {
            const name = typeof block.name === "string" ? block.name : "tool";
            chunks.push(
              "```json\n" +
                JSON.stringify({ tool: name, input: block.input ?? null }, null, 2) +
                "\n```"
            );
          }
          break;
        case "tool_result":
          if (opts.includeToolOutput) {
            const inner = block.content;
            const rendered =
              typeof inner === "string" ? inner : JSON.stringify(inner ?? null, null, 2);
            chunks.push("```\n" + rendered + "\n```");
          }
          break;
        case "image":
          attachments.push({ kind: "image" });
          chunks.push("[image]");
          break;
        default:
          if (typeof block.text === "string") chunks.push(block.text);
      }
    }

    const joined = chunks.filter(Boolean).join("\n\n").trim();
    if (joined) return { text: joined, attachments, contentType: types[0] };
  }

  // Simpler forms: a plain string body.
  if (typeof content === "string" && content.trim()) {
    return { text: content.trim(), attachments, contentType: "text" };
  }
  if (typeof msg.text === "string" && msg.text.trim()) {
    return { text: msg.text.trim(), attachments, contentType: "text" };
  }

  return { text: "", attachments };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function parseClaude(
  html: string,
  url: string,
  options: ExtractOptions = {}
): ChatTranscript {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];
  const markers = ['"chat_messages"', '"sender"', '"messages"'];

  const candidates: Json[] = [];

  // Strategy 1 — Next.js hydration blob.
  const nextData = extractScripts(html).find((s) => s.attrs.id === "__NEXT_DATA__");
  if (nextData?.text) {
    const parsed = safeParse(nextData.text);
    if (parsed !== undefined) candidates.push(parsed);
  }

  // Strategy 2 — any application/json script tag.
  for (const s of extractScripts(html)) {
    if (s.attrs.type === "application/json" && s.text.trim()) {
      const parsed = safeParse(s.text);
      if (parsed !== undefined) candidates.push(parsed);
    }
  }

  // Strategy 3 — RSC flight stream, harvested by shape.
  const rsc = collectRscText(html);
  if (rsc) candidates.push(...harvestJsonCandidates(rsc, markers));

  // Strategy 4 — last resort, scan the raw HTML for inline JSON.
  if (candidates.length === 0) {
    candidates.push(...harvestJsonCandidates(html, markers));
  }

  let conversation: Record<string, Json> | undefined;
  for (const candidate of candidates) {
    const hits = findAll(candidate, isConversationNode, 3);
    if (hits.length > 0) {
      conversation = hits[0];
      break;
    }
  }

  if (!conversation) {
    throw new ShareError(
      "parse_failed",
      "Couldn't find a conversation payload in that Claude page. Either the " +
        "link isn't a public share link (it should look like " +
        "https://claude.ai/share/...), the share was revoked, or the page " +
        "format changed — please open an issue with the link if it's public."
    );
  }

  const rawMessages = getMessageArray(conversation);
  const messages: ChatMessage[] = [];

  for (const raw of rawMessages) {
    if (!isObj(raw)) continue;
    const role = normalizeRole(raw.sender ?? raw.role);
    if (role === "system" && !opts.includeSystem) continue;

    const { text, attachments, contentType } = flattenClaudeContent(raw, opts);
    if (!text && attachments.length === 0) continue;

    messages.push({
      index: messages.length,
      role,
      text,
      contentType,
      createdAt: toIso(raw.created_at ?? raw.timestamp),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  if (messages.length === 0) {
    warnings.push(
      "Conversation payload was found but contained no renderable messages " +
        "under the current options."
    );
  }

  const title =
    (typeof conversation.name === "string" && conversation.name) ||
    (typeof conversation.title === "string" && conversation.title) ||
    "Untitled conversation";

  const shareId =
    (typeof conversation.uuid === "string" && conversation.uuid) ||
    url.split("/").filter(Boolean).pop() ||
    "shared";

  const model =
    typeof conversation.model === "string" ? conversation.model : undefined;

  return {
    source: "claude",
    url,
    shareId,
    title,
    model,
    updatedAt: toIso(conversation.updated_at ?? conversation.created_at),
    messageCount: messages.length,
    messages,
    warnings,
  };
}
