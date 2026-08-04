#!/usr/bin/env node
/**
 * Dual-purpose CLI.
 *
 *   chat-share-reader <share-url> [--json|--text] [--reasoning] [--tools]
 *       Print a transcript to stdout. Good for testing parsers against real
 *       links before deploying.
 *
 *   chat-share-reader --stdio
 *       Run as a local stdio MCP server (for Claude Desktop's local server
 *       config, Cursor, Cline, etc. — no hosting required).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { extractTranscript } from "./extract.js";
import { toMarkdown, toPlainText } from "./markdown.js";
import { buildServer } from "./server.js";
import { ShareError } from "./types.js";

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stays alive on the transport; nothing further to do here.
}

async function runOnce(argv: string[]): Promise<void> {
  const url = argv.find((a) => !a.startsWith("--"));
  if (!url) {
    console.error(
      "Usage: chat-share-reader <share-url> [--json|--text] [--reasoning] [--tools]\n" +
        "       chat-share-reader --stdio"
    );
    process.exitCode = 1;
    return;
  }

  const transcript = await extractTranscript(url, {
    includeReasoning: argv.includes("--reasoning"),
    includeToolOutput: argv.includes("--tools"),
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(transcript, null, 2));
  } else if (argv.includes("--text")) {
    console.log(toPlainText(transcript));
  } else {
    console.log(toMarkdown(transcript));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes("--stdio")) {
      await runStdio();
    } else {
      await runOnce(argv);
    }
  } catch (err) {
    if (err instanceof ShareError) {
      console.error(`\n✖ ${err.code}: ${err.message}\n`);
    } else {
      console.error(`\n✖ ${(err as Error).message}\n`);
    }
    // Not process.exit(): tearing down mid-teardown trips libuv's
    // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` on Node 24 /
    // Windows when a socket from the fetch is still closing. Setting the code
    // lets the loop drain and the process end on its own with status 1.
    process.exitCode = 1;
  }
}

void main();
