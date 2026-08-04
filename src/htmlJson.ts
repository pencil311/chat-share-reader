/**
 * Low-level helpers for pulling JSON payloads back out of server-rendered HTML.
 *
 * ChatGPT embeds the full conversation in the initial HTML response (React
 * Server Components / Next.js hydration data), so no headless browser is
 * needed — the data is there, just encoded awkwardly.
 *
 * Claude does not: its share pages are client-side rendered, which is half of
 * why they're unreadable server-side. See parsers/claude.ts.
 */

export interface ScriptTag {
  attrs: Record<string, string>;
  text: string;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

export function extractScripts(html: string): ScriptTag[] {
  const out: ScriptTag[] = [];
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? "").matchAll(ATTR_RE)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? "";
    }
    out.push({ attrs, text: m[2] ?? "" });
  }
  return out;
}

/**
 * Read a JSON string literal beginning at `start` (which must point at a `"`).
 * Returns the decoded string and the index just past the closing quote.
 * Needed because RSC payloads arrive as JSON-encoded strings inside JS calls.
 */
export function readJsonString(
  text: string,
  start: number
): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  let i = start + 1;
  let out = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      switch (next) {
        case '"': out += '"'; i += 2; break;
        case "\\": out += "\\"; i += 2; break;
        case "/": out += "/"; i += 2; break;
        case "b": out += "\b"; i += 2; break;
        case "f": out += "\f"; i += 2; break;
        case "n": out += "\n"; i += 2; break;
        case "r": out += "\r"; i += 2; break;
        case "t": out += "\t"; i += 2; break;
        case "u": {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          break;
        }
        default:
          return null;
      }
    } else if (ch === '"') {
      return { value: out, end: i + 1 };
    } else {
      out += ch;
      i += 1;
    }
  }
  return null;
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function safeParse(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

/**
 * Walk an arbitrary decoded payload and return every object that satisfies
 * `predicate`. Used as a resilient fallback: rather than hard-coding one route
 * key that breaks on the next redesign, we go looking for the shape we need.
 */
export function findAll(
  root: Json,
  predicate: (node: Record<string, Json>) => boolean,
  limit = 50
): Record<string, Json>[] {
  const found: Record<string, Json>[] = [];
  const seen = new Set<unknown>();

  const walk = (node: Json): void => {
    if (found.length >= limit) return;
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (predicate(node)) found.push(node);
    for (const v of Object.values(node)) walk(v);
  };

  walk(root);
  return found;
}

/** Convert a unix seconds/millis timestamp to ISO-8601, tolerating both. */
export function toIso(value: unknown): string | null {
  if (typeof value !== "number" || !isFinite(value)) {
    if (typeof value === "string") {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d.toISOString();
    }
    return null;
  }
  const ms = value > 1e12 ? value : value * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
