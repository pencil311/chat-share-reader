/**
 * The one and only HTTP entrypoint. Everything else in this repo is library
 * code — see the filename note in src/mcpServer.ts for why that file must not
 * be called `server.ts`.
 *
 * HANDLER SIGNATURE: this is a Node-style `(req, res)` handler, which is the
 * long-standing @vercel/node contract. Vercel's Node runtime also accepts a
 * web-standard handler, but only in the shapes it actually looks for —
 * `export default { fetch(request) {...} }` or per-method exports like
 * `export function GET(request) {...}`. A bare `export default function
 * handler(request: Request)` is NOT one of them: the builder sees a
 * default-exported function and invokes it with Node's `(req, res)`, so the
 * "Request" arriving is really an IncomingMessage and the returned Response is
 * dropped on the floor. That mismatch is what made the previous version fail.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

import { UNAUTHORIZED_BODY, authRequired, checkAuth } from "../src/auth.js";
import { LIMITS, utf8Bytes } from "../src/limits.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "../src/mcpServer.js";
import { callerKey, checkRateLimit, rateLimitBody } from "../src/rateLimit.js";

export const config = { runtime: "nodejs" };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

function applyCors(res: VercelResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

/**
 * Stateless MCP endpoint.
 *
 * Each request builds a fresh server + transport. That's the right model for
 * serverless: there's no shared memory between invocations, so trying to keep
 * sessions alive across cold starts would break unpredictably. The tools here
 * are pure request/response with no per-session state, so nothing is lost.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  applyCors(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // People will paste this URL into a browser. Tell them what it is rather
  // than letting the transport reject a GET with an opaque error.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    // Crawlers and pasted-in-a-browser visits all land here. Let the CDN hold
    // the answer so repeat GETs stop reaching the function at all; a 405 is
    // the same for everyone and never goes stale.
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
    res.status(405).json({
      error: "method_not_allowed",
      message:
        `This is a Model Context Protocol (MCP) endpoint, not a web page. ` +
        `It speaks JSON-RPC 2.0 over HTTP POST, so there is nothing to see ` +
        `in a browser. Add this URL as a custom MCP connector in your AI ` +
        `client, or POST to it directly.`,
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      example:
        `curl -X POST <this-url> ` +
        `-H 'Content-Type: application/json' ` +
        `-H 'Accept: application/json, text/event-stream' ` +
        `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      docs: "https://modelcontextprotocol.io",
    });
    return;
  }

  // --- Admission checks, cheapest first -----------------------------------
  //
  // Everything here runs before the MCP server is constructed and before any
  // outbound fetch. Each rejection still costs one invocation and a few hundred
  // bytes of Fast Origin Transfer, so the bodies are deliberately terse. The
  // only control that costs nothing at all is a Vercel WAF rule, which rejects
  // at the edge — see README.

  const auth = checkAuth(req.headers.authorization);
  if (!auth.ok) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json(UNAUTHORIZED_BODY);
    return;
  }

  // Oversized bodies are incoming transfer and a parse cost; a legitimate call
  // here is a URL and a few flags.
  const rawBody = req.body;
  if (rawBody !== undefined) {
    const approxBytes =
      typeof rawBody === "string"
        ? utf8Bytes(rawBody)
        : utf8Bytes(JSON.stringify(rawBody ?? null));
    if (approxBytes > LIMITS.maxRequestBodyBytes) {
      res.status(413).json({
        error: "payload_too_large",
        message: `Request body exceeds ${LIMITS.maxRequestBodyBytes} bytes.`,
      });
      return;
    }
  }

  const verdict = await checkRateLimit(callerKey(req.headers, auth.subject));
  if (!verdict.allowed) {
    res.setHeader("Retry-After", String(verdict.retryAfterSec ?? 60));
    res.status(429).json(rateLimitBody(verdict));
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    // Vercel has already consumed and parsed the body for known content types;
    // hand it over explicitly so the transport doesn't wait on a drained stream.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // The transport may have started (or finished) the response already —
    // writing a second set of headers would throw over the original error.
    if (res.headersSent) {
      res.end();
    } else {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal server error: ${message}` },
        id: null,
      });
    }
  } finally {
    // Serverless invocations shouldn't leak handles between requests.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
