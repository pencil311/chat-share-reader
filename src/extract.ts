import { assertAllowedUrl, fetchSharePage } from "./fetchPage.js";
import { parseChatGPT } from "./parsers/chatgpt.js";
import {
  ShareError,
  type ChatTranscript,
  type ExtractOptions,
  type Platform,
} from "./types.js";

export function detectPlatform(url: URL): Platform {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "chatgpt.com" || host === "chat.openai.com") return "chatgpt";
  if (host === "claude.ai") return "claude";
  throw new ShareError("unsupported_host", `No parser for host "${host}".`);
}

/**
 * Fetch and parse a public shared conversation into the normalized schema.
 * Throws ShareError with an explainable message for all expected failures.
 */
export async function extractTranscript(
  rawUrl: string,
  options: ExtractOptions = {}
): Promise<ChatTranscript> {
  const url = assertAllowedUrl(rawUrl.trim());
  const platform = detectPlatform(url);

  // Claude share pages cannot be read server-side at all — see the note on
  // parsers/claude.ts. Fail here, before the fetch, so the error explains the
  // real reason instead of surfacing as a generic 403 or an empty parse.
  if (platform === "claude") {
    throw new ShareError(
      "claude_not_supported",
      `Claude share links can't be read programmatically. Two independent ` +
        `blockers: Cloudflare answers every non-browser client with 403 ` +
        `(cf-mitigated: challenge), and the page is client-side rendered, so ` +
        `even the HTML behind the challenge contains only meta tags — no ` +
        `conversation. This is a platform limitation, not a bug in this tool, ` +
        `and no amount of retrying or header tweaking gets around it.\n\n` +
        `Use the browser bookmarklet instead: it runs on the share page you ` +
        `already have open and copies the transcript as Markdown + JSON in ` +
        `this tool's schema. See bookmarklet/README.md.`
    );
  }

  // Nudge users who paste a private conversation URL rather than a share link.
  if (!/\/share\//.test(url.pathname)) {
    throw new ShareError(
      "not_a_share_link",
      `That looks like a private conversation URL, not a public share link. ` +
        `Open the chat, click Share, copy the generated link (it contains ` +
        `"/share/"), and try that instead.`
    );
  }

  const html = await fetchSharePage(url);

  return parseChatGPT(html, url.toString(), options);
}
