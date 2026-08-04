/**
 * Normalized schema returned for every supported platform.
 * Keeping one shape means consumers (AI agents, scripts) never branch on source.
 */

export type Role = "user" | "assistant" | "system" | "tool" | "unknown";

export type Platform = "chatgpt" | "claude";

export interface ChatMessage {
  /** 0-based position in the linear conversation. */
  index: number;
  /** Normalized speaker role. */
  role: Role;
  /** Plain-text / Markdown body of the message. */
  text: string;
  /**
   * Original platform-specific content type, when known
   * (e.g. "text", "code", "thoughts", "multimodal_text").
   */
  contentType?: string;
  /** ISO-8601 timestamp, when the platform exposes one. */
  createdAt?: string | null;
  /** Non-text attachments referenced by the message (images, files). */
  attachments?: Attachment[];
}

export interface Attachment {
  kind: "image" | "file";
  name?: string;
  url?: string;
}

export interface ChatTranscript {
  source: Platform;
  url: string;
  /** Share identifier parsed out of the URL / payload. */
  shareId: string;
  title: string;
  /** Model slug, when the platform exposes it. */
  model?: string;
  /** ISO-8601 timestamp of last update, when available. */
  updatedAt?: string | null;
  messageCount: number;
  messages: ChatMessage[];
  /** Notes about degraded parsing, skipped content, etc. */
  warnings: string[];
}

export interface ExtractOptions {
  /** Include chain-of-thought / reasoning blocks. Default false. */
  includeReasoning?: boolean;
  /** Include tool call results. Default false. */
  includeToolOutput?: boolean;
  /** Include system messages. Default false. */
  includeSystem?: boolean;
}

export const DEFAULT_OPTIONS: Required<ExtractOptions> = {
  includeReasoning: false,
  includeToolOutput: false,
  includeSystem: false,
};

/** Thrown for user-facing, explainable failures (bad link, expired, private). */
export class ShareError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShareError";
    this.code = code;
  }
}
