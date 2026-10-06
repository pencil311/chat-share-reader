/**
 * Keeps a tool result inside a byte budget by returning a window of messages
 * instead of the whole conversation.
 *
 * Before this existed, `read_shared_chat` serialised every message every time.
 * A 120-message conversation rendered to roughly 295 KB, so a few tens of
 * thousands of reads cleared a 10 GB monthly allowance on their own. Paging is
 * also better for the caller: an unbounded transcript lands straight in a
 * model's context window.
 *
 * Shrinking is iterative rather than arithmetic because rendered size is not
 * proportional to message count — headers, attachment lists and warnings all
 * add weight, and one long message can dominate the rest put together.
 */

import { LIMITS, utf8Bytes } from "./limits.js";
import { toMarkdown, toPlainText } from "./markdown.js";
import type { ChatTranscript } from "./types.js";

export type Format = "markdown" | "json" | "text";

export interface WindowRequest {
  offset?: number;
  limit?: number;
  format: Format;
}

export interface WindowResult {
  text: string;
  /** Index of the first message included. */
  offset: number;
  /** How many were included after budget shrinking. */
  returned: number;
  /** Total in the conversation, so the caller knows what it hasn't seen. */
  total: number;
  truncated: boolean;
}

/** Clamp a single oversized message so it can't eat the whole budget alone. */
function clampMessages(t: ChatTranscript): ChatTranscript {
  let clamped = false;
  const messages = t.messages.map((m) => {
    if (m.text.length <= LIMITS.maxMessageChars) return m;
    clamped = true;
    return {
      ...m,
      text:
        m.text.slice(0, LIMITS.maxMessageChars) +
        `\n\n…[message truncated at ${LIMITS.maxMessageChars} characters]`,
    };
  });
  if (!clamped) return t;
  return { ...t, messages };
}

function render(t: ChatTranscript, format: Format): string {
  if (format === "json") return JSON.stringify(t, null, 2);
  if (format === "text") return toPlainText(t);
  return toMarkdown(t);
}

export function buildWindow(
  transcript: ChatTranscript,
  req: WindowRequest
): WindowResult {
  const total = transcript.messages.length;

  const offset = Math.max(0, Math.min(Math.floor(req.offset ?? 0), Math.max(0, total - 1)));
  const requested = Math.floor(req.limit ?? LIMITS.defaultMessageLimit);
  const limit = Math.max(1, Math.min(requested, LIMITS.maxMessageLimit));

  const clamped = clampMessages(transcript);

  let count = Math.min(limit, Math.max(0, total - offset));
  let text = "";
  let slice: ChatTranscript = clamped;

  // Shrink until it fits. `count` can reach 1 and still overflow only if a
  // single clamped message exceeds the budget, which the clamp above prevents.
  for (;;) {
    slice = {
      ...clamped,
      messages: clamped.messages.slice(offset, offset + count),
      // messageCount stays the conversation total: a caller reading a window
      // should still see how much conversation exists.
      messageCount: total,
    };
    text = render(slice, req.format);
    if (utf8Bytes(text) <= LIMITS.maxResponseBytes || count <= 1) break;
    count = Math.max(1, Math.floor(count * 0.7));
  }

  const returned = slice.messages.length;
  const truncated = offset > 0 || offset + returned < total;

  if (truncated) {
    const last = offset + returned - 1;
    const more =
      offset + returned < total
        ? ` Call read_shared_chat again with offset=${offset + returned} for the next page.`
        : "";
    const note =
      `\n\n---\n_Showing messages ${offset}–${last} of ${total}.${more}_\n`;

    // JSON callers get a field, not prose glued onto their document.
    if (req.format === "json") {
      text = JSON.stringify(
        {
          ...slice,
          window: {
            offset,
            returned,
            total,
            nextOffset: offset + returned < total ? offset + returned : null,
          },
        },
        null,
        2
      );
    } else {
      text += note;
    }
  }

  return { text, offset, returned, total, truncated };
}
