import path from "node:path";
import type { TurnEvent } from "../host/types.js";

function clip(s: string, n = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n - 1) + "…";
}

const KIND_EMOJI: Record<string, string> = {
  read: "📄",
  edit: "✏️",
  delete: "🗑️",
  move: "📦",
  search: "🔎",
  execute: "💻",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔐",
  other: "🔧",
};

/**
 * A short, human-friendly status line for a tool call, shown under the streamed
 * reply while the tool runs (e.g. "💻 npm test", "📄 Read app.ts").
 * Uses the agent's native tool name + input when the agent exposes them (Claude
 * does via _meta), otherwise the ACP kind/title.
 */
export function toolLabel(ev: Extract<TurnEvent, { kind: "tool_call" }>): string {
  const name = ev.toolName ?? "";
  const a = (ev.input && typeof ev.input === "object" ? ev.input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");

  if (str("description")) return `🔧 ${clip(str("description"))}`;
  if (name === "Bash" && str("command")) return `💻 ${clip(str("command"))}`;
  if (["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name)) {
    const p = str("file_path") || str("notebook_path");
    if (p) return `📄 ${name} ${clip(path.basename(p))}`;
  }
  if (name === "WebFetch" && str("url")) return `🌐 fetching ${clip(str("url"))}`;
  if (name === "WebSearch" && str("query")) return `🔎 searching ${clip(str("query"))}`;
  if ((name === "Grep" || name === "Glob") && (str("pattern") || str("query"))) return `🔎 ${name} ${clip(str("pattern") || str("query"))}`;
  if ((name === "Task" || name === "Agent") && str("description")) return `🤖 ${clip(str("description"))}`;
  if (name === "Skill") return `🔧 Skill${str("skill") ? " " + clip(str("skill")) : ""}`;
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return `🔧 ${parts.slice(1).join(":")}`;
  }

  const emoji = KIND_EMOJI[ev.kind_ ?? "other"] ?? "🔧";
  const title = ev.title && ev.title !== name ? ev.title : name || "tool";
  return `${emoji} ${clip(title)}`;
}
