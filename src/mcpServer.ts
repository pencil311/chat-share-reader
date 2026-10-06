/**
 * Builds the MCP server and registers its tools. Internal library code — it
 * exports a factory, not an HTTP handler. The only HTTP entrypoint is api/mcp.ts.
 *
 * NOTE ON THE FILENAME: this must not be called `server.ts`. Vercel treats a
 * file named `server.*` as a server entrypoint, compiles it to
 * `/var/task/src/server.mjs`, and tries to launch it as the function entry —
 * which fails with "Invalid export found in module ... The default export must
 * be a function or server", because `buildServer()` is an McpServer factory.
 * Renaming it keeps this file off Vercel's entrypoint heuristic entirely.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildWindow } from "./budget.js";
import { extractTranscript } from "./extract.js";
import { LIMITS } from "./limits.js";
import { ShareError } from "./types.js";

export const SERVER_NAME = "chat-share-reader";
export const SERVER_VERSION = "0.1.0";

const urlSchema = z
  .string()
  .describe(
    "Public ChatGPT share link — chatgpt.com/share/... or " +
      "chat.openai.com/share/... . claude.ai/share/... links are NOT " +
      "readable by any server (Cloudflare challenge + client-side rendering) " +
      "and will return an error pointing to the browser bookmarklet."
  );

const formatSchema = z
  .enum(["markdown", "json", "text"])
  .default("markdown")
  .describe(
    "markdown = readable transcript (default); json = full structured schema; " +
      "text = minimal plain text."
  );

function errorResult(err: unknown) {
  const message =
    err instanceof ShareError
      ? err.message
      : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Reads publicly shared ChatGPT conversations. When a user pastes a " +
        "chatgpt.com/share or chat.openai.com/share link, call " +
        "read_shared_chat to load the actual conversation instead of guessing " +
        "at its contents.\n\n" +
        "Claude share links (claude.ai/share/...) are not supported and cannot " +
        "be: Cloudflare blocks non-browser clients and the page is rendered " +
        "client-side, so there is no conversation in the HTML for any server " +
        "to read. Calling these tools with a claude.ai URL returns a " +
        "claude_not_supported error. Don't retry it — tell the user to use " +
        "the browser bookmarklet in bookmarklet/README.md, which exports the " +
        "same transcript format from the page they already have open.",
    }
  );

  server.registerTool(
    "read_shared_chat",
    {
      title: "Read a shared ChatGPT conversation",
      description:
        "Fetch and parse a public ChatGPT share link (chatgpt.com/share/... or " +
        "chat.openai.com/share/...) into a readable transcript. Use this " +
        "whenever the user pastes one and wants it read, summarized, " +
        "continued, or analyzed. Returns the conversation with roles, message " +
        "order, and metadata, a page at a time — long chats are split across " +
        "pages and the result tells you the next offset. ChatGPT only — " +
        "claude.ai/share links return claude_not_supported and need the " +
        "browser bookmarklet instead.",
      inputSchema: {
        url: urlSchema,
        format: formatSchema,
        include_reasoning: z
          .boolean()
          .default(false)
          .describe("Include the model's internal reasoning/thinking blocks."),
        include_tool_output: z
          .boolean()
          .default(false)
          .describe("Include tool calls and their results."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Index of the first message to return. Long conversations come " +
              "back a page at a time; the result says what the next offset is."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIMITS.maxMessageLimit)
          .default(LIMITS.defaultMessageLimit)
          .describe(
            `Maximum messages to return (default ${LIMITS.defaultMessageLimit}, ` +
              `hard cap ${LIMITS.maxMessageLimit}). A response byte budget ` +
              `applies on top, so a page of very long messages may return fewer.`
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, format, include_reasoning, include_tool_output, offset, limit }) => {
      try {
        const transcript = await extractTranscript(url, {
          includeReasoning: include_reasoning,
          includeToolOutput: include_tool_output,
        });

        // Never serialise the whole conversation: see budget.ts.
        const { text } = buildWindow(transcript, { offset, limit, format });

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_shared_chat_metadata",
    {
      title: "Preview a shared ChatGPT conversation",
      description:
        "Cheaply inspect a ChatGPT share link: title, model, message count, " +
        "and a short preview of the opening messages, without pulling the " +
        "whole transcript. Useful before deciding to read a long chat. " +
        "ChatGPT only — claude.ai/share links return claude_not_supported.",
      inputSchema: { url: urlSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const t = await extractTranscript(url);
        const preview = t.messages.slice(0, 2).map((m) => ({
          role: m.role,
          excerpt: m.text.slice(0, 280) + (m.text.length > 280 ? "…" : ""),
        }));

        const summary = {
          source: t.source,
          title: t.title,
          model: t.model ?? null,
          updatedAt: t.updatedAt ?? null,
          messageCount: t.messageCount,
          approxWords: t.messages.reduce(
            (n, m) => n + m.text.split(/\s+/).filter(Boolean).length,
            0
          ),
          preview,
          warnings: t.warnings,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
