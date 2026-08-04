import type { ChatTranscript, Role } from "./types.js";

const ROLE_LABEL: Record<Role, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
  unknown: "Unknown",
};

const SOURCE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
};

export function toMarkdown(t: ChatTranscript): string {
  const lines: string[] = [];

  lines.push(`# ${t.title}`, "");

  const meta: string[] = [`**Source:** ${SOURCE_LABEL[t.source] ?? t.source}`];
  if (t.model) meta.push(`**Model:** ${t.model}`);
  if (t.updatedAt) meta.push(`**Updated:** ${t.updatedAt}`);
  meta.push(`**Messages:** ${t.messageCount}`);
  lines.push(meta.join(" · "), "", `[Original share link](${t.url})`, "", "---", "");

  for (const m of t.messages) {
    lines.push(`## ${ROLE_LABEL[m.role]}`, "");
    if (m.text) lines.push(m.text, "");
    if (m.attachments?.length) {
      const rendered = m.attachments
        .map((a) => `- ${a.kind}${a.name ? `: ${a.name}` : ""}`)
        .join("\n");
      lines.push("**Attachments:**", "", rendered, "");
    }
  }

  if (t.warnings.length > 0) {
    lines.push("---", "", "> **Extraction notes**", ">");
    for (const w of t.warnings) lines.push(`> - ${w}`);
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Compact plain-text rendering, useful when an agent wants minimal tokens. */
export function toPlainText(t: ChatTranscript): string {
  const body = t.messages
    .map((m) => `${ROLE_LABEL[m.role].toUpperCase()}: ${m.text}`)
    .join("\n\n");
  return `${t.title}\n\n${body}\n`;
}
