import { ShareError } from "./types.js";

/**
 * Headers that mirror what a normal private browser tab sends. Share pages are
 * public, but some edge configs reject requests with no UA / no Accept header.
 * This is about looking like a normal client, not about evading bot detection —
 * if a platform returns a challenge page we surface the error rather than retry.
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Ch-Ua": '"Chromium";v="124", "Not:A-Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Upgrade-Insecure-Requests": "1",
};

/**
 * Only these hosts may ever be fetched. Prevents the tool being used as an SSRF
 * proxy. `claude.ai` stays on the list so its URLs reach the specific
 * `claude_not_supported` error in extract.ts, which explains why no server can
 * read them — it is rejected there, before any fetch happens.
 */
const ALLOWED_HOSTS = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
]);

export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ShareError("invalid_url", `Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "https:") {
    throw new ShareError("invalid_url", "Only https:// URLs are supported.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!ALLOWED_HOSTS.has(host)) {
    throw new ShareError(
      "unsupported_host",
      `Unsupported host "${url.hostname}". Supported: chatgpt.com/share/..., ` +
        `chat.openai.com/share/..., claude.ai/share/...`
    );
  }
  return url;
}

export async function fetchSharePage(
  url: URL,
  timeoutMs = 20_000
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { ...BROWSER_HEADERS, Referer: `${url.origin}/` },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new ShareError(
        "timeout",
        `Timed out after ${timeoutMs}ms fetching ${url.hostname}.`
      );
    }
    throw new ShareError(
      "network_error",
      `Could not reach ${url.hostname}: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    throw new ShareError(
      "not_found",
      "That share link doesn't exist (404). It may have been deleted or the " +
        "sharing link revoked by its owner."
    );
  }

  if (res.status === 403 || res.status === 401) {
    throw new ShareError(
      "not_public",
      "Access denied (" +
        res.status +
        "). This looks like a private conversation rather than a public share " +
        "link. Open it while logged in and use the 'Share' button to create a " +
        "public link (chatgpt.com/share/...)."
    );
  }

  if (res.status === 429) {
    throw new ShareError(
      "rate_limited",
      "Rate limited (429) by the platform. Wait a bit and try again."
    );
  }

  if (!res.ok) {
    throw new ShareError(
      "http_error",
      `Unexpected HTTP ${res.status} from ${url.hostname}.`
    );
  }

  const html = await res.text();

  // A challenge/interstitial page is short and has no conversation payload.
  if (/just a moment|checking your browser|cf-challenge|captcha/i.test(html) && html.length < 40_000) {
    throw new ShareError(
      "blocked",
      "The platform returned a bot-check page instead of the conversation. " +
        "This can happen from datacenter IPs. Try again later, or run the CLI " +
        "locally from your own machine."
    );
  }

  return html;
}
