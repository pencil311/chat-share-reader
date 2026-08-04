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
/* Modern format: React Flight (RSC) streaming payload                         */
/* -------------------------------------------------------------------------- */

/**
 * Modern chatgpt.com/share pages stream their data as React Flight chunks
 * pushed through `streamController.enqueue("...")`. Each chunk is a
 * JSON-encoded string; the one we want decodes to a flat array that acts as a
 * constant pool with integer back-references.
 */
function extractFlightPayload(html: string): Json[] | null {
  const MARKER = "streamController.enqueue(";

  for (const { text } of extractScripts(html)) {
    if (!text || !text.includes(MARKER)) continue;

    let cursor = 0;
    while (true) {
      const anchor = text.indexOf(MARKER, cursor);
      if (anchor === -1) break;
      const argStart = anchor + MARKER.length;

      const quotePos = text.indexOf('"', argStart);
      const closePos = text.indexOf(");", argStart);

      let chunk: string | null = null;
      if (quotePos !== -1 && (closePos === -1 || quotePos < closePos)) {
        const read = readJsonString(text, quotePos);
        if (!read) {
          cursor = argStart + 1;
          continue;
        }
        chunk = read.value;
        cursor = read.end;
      } else {
        if (closePos === -1) break;
        chunk = text.slice(argStart, closePos).trim();
        if (chunk.startsWith("(") && chunk.endsWith(")")) {
          chunk = chunk.slice(1, -1).trim();
        }
        cursor = closePos + 2;
      }

      const trimmed = chunk?.trim();
      if (trimmed?.startsWith("[")) {
        const parsed = safeParse(trimmed);
        if (Array.isArray(parsed)) return parsed as Json[];
      }
    }
  }
  return null;
}

/**
 * The Flight payload is a flattened constant pool: integers are indices back
 * into the same array, and keys shaped like "_12" also dereference. Rehydrate
 * it into ordinary nested objects.
 */
function decodeFlightPool(pool: Json[]): Record<string, Json> {
  const cache = new Map<number, Json>();

  const decodeKey = (rawKey: string): string => {
    if (/^_\d+$/.test(rawKey)) {
      const idx = Number(rawKey.slice(1));
      const candidate = pool[idx];
      if (typeof candidate === "string") return candidate;
    }
    return rawKey;
  };

  const resolve = (value: Json): Json => {
    if (typeof value === "number" && Number.isInteger(value)) {
      if (cache.has(value)) return cache.get(value)!;
      if (value < 0 || value >= pool.length) return value;
      cache.set(value, null); // cycle guard
      const resolved = resolve(pool[value]);
      cache.set(value, resolved);
      return resolved;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (isObj(value)) {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(value)) out[decodeKey(k)] = resolve(v);
      return out;
    }
    return value;
  };

  // Entries after index 0 are laid out as alternating key/value pairs.
  const result: Record<string, Json> = {};
  for (let i = 1; i + 1 < pool.length; i += 2) {
    const key = pool[i];
    if (typeof key === "string" && !(key in result)) {
      result[key] = resolve(pool[i + 1]);
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Message content flattening                                                  */
/* -------------------------------------------------------------------------- */

function shouldInclude(contentType: string | undefined, opts: Required<ExtractOptions>): boolean {
  if (contentType === "thoughts" || contentType === "reasoning_recap") {
    return opts.includeReasoning;
  }
  if (contentType === "tool_response" || contentType === "execution_output") {
    return opts.includeToolOutput;
  }
  if (contentType === "model_editable_context") return false;
  return true;
}

function flattenContent(
  content: Record<string, Json>,
  opts: Required<ExtractOptions>
): { text: string; attachments: Attachment[] } {
  const contentType = typeof content.content_type === "string" ? content.content_type : undefined;
  const attachments: Attachment[] = [];

  if (!shouldInclude(contentType, opts)) return { text: "", attachments };

  const partsToText = (parts: Json): string => {
    if (!Array.isArray(parts)) return "";
    const chunks: string[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        chunks.push(part);
      } else if (isObj(part)) {
        const partType = (part.content_type ?? part.type) as string | undefined;
        if (partType === "image_asset_pointer" || partType === "image") {
          attachments.push({
            kind: "image",
            name: typeof part.asset_pointer === "string" ? part.asset_pointer : undefined,
          });
          chunks.push("[image]");
        } else if (typeof part.text === "string") {
          chunks.push(part.text);
        }
      }
    }
    return chunks.join("\n\n");
  };

  switch (contentType) {
    case "text":
    case "multimodal_text":
      return { text: partsToText(content.parts).trim(), attachments };

    case "code": {
      const lang = typeof content.language === "string" && content.language !== "unknown"
        ? content.language
        : "";
      const body = typeof content.text === "string" ? content.text : "";
      return { text: body ? "```" + lang + "\n" + body + "\n```" : "", attachments };
    }

    case "thoughts": {
      const thoughts = content.thoughts;
      if (!Array.isArray(thoughts)) return { text: "", attachments };
      const rendered = thoughts
        .filter(isObj)
        .map((t) => {
          const summary = typeof t.summary === "string" ? t.summary : "";
          const body = typeof t.content === "string" ? t.content : "";
          return summary ? `**${summary}**\n\n${body}` : body;
        })
        .filter(Boolean)
        .join("\n\n");
      return { text: rendered, attachments };
    }

    case "reasoning_recap":
    case "tool_response":
    case "execution_output":
      return {
        text: typeof content.text === "string" ? content.text : "",
        attachments,
      };

    default: {
      // Unknown/new content type — fall back to whatever text-ish fields exist
      // rather than silently dropping the message.
      if (typeof content.text === "string") return { text: content.text, attachments };
      if (Array.isArray(content.parts)) {
        return { text: partsToText(content.parts).trim(), attachments };
      }
      return { text: "", attachments };
    }
  }
}

function normalizeRole(raw: unknown): Role {
  if (raw === "user" || raw === "assistant" || raw === "system" || raw === "tool") return raw;
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Conversation assembly                                                       */
/* -------------------------------------------------------------------------- */

/** Shape shared by modern + legacy: a `mapping` and/or `linear_conversation`. */
function isConversationData(node: Record<string, Json>): boolean {
  return (
    ("linear_conversation" in node && Array.isArray(node.linear_conversation)) ||
    ("mapping" in node && isObj(node.mapping))
  );
}

function buildMessages(
  data: Record<string, Json>,
  opts: Required<ExtractOptions>,
  warnings: string[]
): ChatMessage[] {
  const mapping = isObj(data.mapping) ? data.mapping : {};
  const linear = Array.isArray(data.linear_conversation) ? data.linear_conversation : [];

  // Prefer linear_conversation (already the displayed branch); fall back to
  // walking the mapping tree if the platform stops sending it.
  let nodes: Json[] = [];
  if (linear.length > 0) {
    nodes = linear.map((entry) => {
      if (!isObj(entry)) return null;
      if (isObj(entry.message)) return entry;
      const id = typeof entry.id === "string" ? entry.id : null;
      return id && isObj(mapping[id]) ? mapping[id] : null;
    });
  } else if (Object.keys(mapping).length > 0) {
    warnings.push(
      "No linear_conversation found; reconstructed order by walking the message tree."
    );
    nodes = walkMappingTree(mapping);
  }

  const messages: ChatMessage[] = [];
  for (const node of nodes) {
    if (!isObj(node)) continue;
    const message = node.message;
    if (!isObj(message)) continue;

    const author = isObj(message.author) ? message.author : {};
    const role = normalizeRole(author.role);
    if (role === "system" && !opts.includeSystem) continue;
    if (role === "tool" && !opts.includeToolOutput) continue;

    const content = isObj(message.content) ? message.content : {};
    const { text, attachments } = flattenContent(content, opts);
    if (!text && attachments.length === 0) continue;

    messages.push({
      index: messages.length,
      role,
      text,
      contentType: typeof content.content_type === "string" ? content.content_type : undefined,
      createdAt: toIso(message.create_time),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
  return messages;
}

/** Depth-first walk from the root node, following the first child each time. */
function walkMappingTree(mapping: Record<string, Json>): Json[] {
  const rootId = Object.keys(mapping).find((id) => {
    const n = mapping[id];
    return isObj(n) && (n.parent === null || n.parent === undefined);
  });
  if (!rootId) return Object.values(mapping);

  const ordered: Json[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = rootId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const node: Json = mapping[currentId];
    if (!isObj(node)) break;
    ordered.push(node);
    const children: Json = node.children;
    currentId =
      Array.isArray(children) && typeof children[children.length - 1] === "string"
        ? (children[children.length - 1] as string)
        : undefined;
  }
  return ordered;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function parseChatGPT(
  html: string,
  url: string,
  options: ExtractOptions = {}
): ChatTranscript {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];

  let data: Record<string, Json> | undefined;
  let shareId = "";

  // Strategy 1 — modern React Flight payload.
  const pool = extractFlightPayload(html);
  if (pool) {
    const decoded = decodeFlightPool(pool);
    const candidates = findAll(decoded as Json, isConversationData, 5);
    if (candidates.length > 0) data = candidates[0];

    const routeNodes = findAll(
      decoded as Json,
      (n) => typeof n.sharedConversationId === "string",
      1
    );
    if (routeNodes.length > 0 && typeof routeNodes[0].sharedConversationId === "string") {
      shareId = routeNodes[0].sharedConversationId;
    }
  }

  // Strategy 2 — legacy Next.js hydration blob (chat.openai.com era).
  if (!data) {
    const nextData = extractScripts(html).find((s) => s.attrs.id === "__NEXT_DATA__");
    if (nextData?.text) {
      const parsed = safeParse(nextData.text);
      if (parsed) {
        const candidates = findAll(parsed, isConversationData, 5);
        if (candidates.length > 0) {
          data = candidates[0];
          warnings.push("Parsed using the legacy __NEXT_DATA__ format.");
        }
      }
    }
  }

  if (!data) {
    throw new ShareError(
      "parse_failed",
      "Couldn't find a conversation payload in that ChatGPT page. Either the " +
        "link isn't a public share link (it should look like " +
        "https://chatgpt.com/share/...), or OpenAI changed the page format — " +
        "please open an issue with the link if it's public."
    );
  }

  const messages = buildMessages(data, opts, warnings);
  if (messages.length === 0) {
    warnings.push(
      "Conversation payload was found but contained no renderable messages " +
        "under the current options."
    );
  }

  const model = isObj(data.model) && typeof data.model.slug === "string" ? data.model.slug : undefined;

  if (!shareId) {
    shareId =
      (typeof data.conversation_id === "string" && data.conversation_id) ||
      url.split("/").filter(Boolean).pop() ||
      "shared";
  }

  return {
    source: "chatgpt",
    url,
    shareId,
    title: typeof data.title === "string" ? data.title : "Untitled conversation",
    model,
    updatedAt: toIso(data.update_time),
    messageCount: messages.length,
    messages,
    warnings,
  };
}
