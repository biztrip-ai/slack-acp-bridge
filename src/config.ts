import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AgentConfig } from "./host/types.js";

export interface BridgeConfig {
  slackBotToken: string;
  slackAppToken: string;
  /** Slack-compatible API base (e.g. Flow). Undefined = real Slack. */
  slackApiUrl?: string;

  /** Name of the agent (key in `agents`) used for new sessions. */
  defaultAgent: string;
  agents: Record<string, AgentConfig>;
  /** Per-channel default agent (channel id → agent name). */
  channelAgents: Record<string, string>;

  /** Working directory every session runs in. */
  cwd: string;
  /** ACP session mode id requested after session creation (claude: default|acceptEdits|plan|bypassPermissions|auto). */
  permissionMode: string;

  /** Claude-specific passthrough (sent as _meta.claudeCode.options; other agents ignore it). */
  claude: {
    model?: string;
    settingSources: string[];
    chrome: boolean;
  };
  /** Appended to the agent's system prompt (Slack mrkdwn guidance). Set "" to disable. */
  systemPromptAppend: string;

  /**
   * Ambient mode: un-mentioned replies in a thread the bot is part of are
   * forwarded with the sender's name, and the agent may stay silent by
   * replying with exactly `silentSentinel`.
   */
  ambient: boolean;
  silentSentinel: string;
  /** How long a permission prompt waits for a click before cancelling. */
  permissionTimeoutS: number;

  sessionIdleTimeoutS: number; // 0 disables the reaper
  sessionReapIntervalS: number;

  /** Directory holding the sqlite session map. */
  stateDir: string;
  logLevel: string;
}

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

function floatEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function splitList(raw: string | undefined, def: string[]): string[] {
  if (raw === undefined) return def;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Resolve the bundled claude-agent-acp entry point so we can run it under the current node. */
export function bundledClaudeAgent(): AgentConfig {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
  const entry = path.join(path.dirname(pkg), "dist", "index.js");
  return { name: "claude", command: process.execPath, args: [entry] };
}

function loadAgentsFile(file: string | undefined): Record<string, AgentConfig> {
  if (!file) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
    string,
    Omit<AgentConfig, "name">
  >;
  const out: Record<string, AgentConfig> = {};
  for (const [name, a] of Object.entries(raw)) {
    if (!a.command) throw new Error(`agents file: ${name} is missing "command"`);
    out[name] = { name, command: a.command, args: a.args ?? [], env: a.env };
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const slackBotToken = env.SLACK_BOT_TOKEN ?? "";
  const slackAppToken = env.SLACK_APP_TOKEN ?? "";
  if (!slackBotToken || !slackAppToken) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
  }

  const agents: Record<string, AgentConfig> = {
    claude: bundledClaudeAgent(),
    ...loadAgentsFile(env.AGENTS_FILE),
  };
  const defaultAgent = env.AGENT ?? "claude";
  if (!agents[defaultAgent]) {
    throw new Error(`AGENT=${defaultAgent} is not defined (known: ${Object.keys(agents).join(", ")})`);
  }

  const channelAgents = env.CHANNEL_AGENTS ? (JSON.parse(env.CHANNEL_AGENTS) as Record<string, string>) : {};
  for (const [ch, a] of Object.entries(channelAgents)) {
    if (!agents[a]) throw new Error(`CHANNEL_AGENTS: ${ch} → ${a} is not a defined agent`);
  }
  const ambient = truthy(env.AMBIENT);
  const silentSentinel = env.SILENT_SENTINEL ?? "<<SILENT>>";
  let systemPromptAppend = env.SYSTEM_PROMPT_APPEND ?? SLACK_FORMATTING_PROMPT;
  if (ambient && systemPromptAppend !== "") systemPromptAppend += "\n\n" + ambientPrompt(silentSentinel);

  const idle = floatEnv("SESSION_IDLE_TIMEOUT_S", 14400);
  const stateDir =
    env.STATE_DIR ??
    path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "slack-acp-bridge");

  return {
    slackBotToken,
    slackAppToken,
    slackApiUrl: env.SLACK_API_URL || undefined,
    defaultAgent,
    agents,
    channelAgents,
    cwd: env.AGENT_CWD ?? env.CLAUDE_CWD ?? os.homedir(),
    permissionMode: env.PERMISSION_MODE ?? env.CLAUDE_PERMISSION_MODE ?? "bypassPermissions",
    claude: {
      model: env.CLAUDE_MODEL || undefined,
      settingSources: splitList(env.CLAUDE_SETTING_SOURCES, ["user", "project", "local"]),
      chrome: truthy(env.CLAUDE_CHROME),
    },
    systemPromptAppend,
    ambient,
    silentSentinel,
    permissionTimeoutS: floatEnv("PERMISSION_TIMEOUT_S", 600),
    sessionIdleTimeoutS: idle > 0 ? idle : 0,
    sessionReapIntervalS: floatEnv("SESSION_REAP_INTERVAL_S", 300),
    stateDir,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

/**
 * Slack renders its own "mrkdwn" dialect, not GitHub-flavored Markdown.
 * Appended to the agent's system prompt so replies render correctly.
 */
export const SLACK_FORMATTING_PROMPT = `Your replies are posted directly to Slack. Format every response in Slack's
"mrkdwn" dialect, not standard or GitHub-flavored Markdown:

- Bold: *single asterisks* (NOT **double**).
- Italic: _underscores_ (NOT *single asterisks*).
- Strikethrough: ~tildes~.
- Inline code: \`backticks\`. Code blocks: triple backticks (no language tag).
- Links: <https://example.com|label> — NEVER use [label](url) syntax.
- Bullets: a leading "• " or "- " on each line.
- Block quotes: a leading "> ".
- Headings (#, ##, ###) do not render — use a *bold* line instead.
- Tables (| col | col |) do not render — use a bulleted list, one row per
  bullet, with fields separated by " — " or "·". Never emit pipe-and-dash
  table syntax.

Keep output tight: Slack threads are narrow. Prefer short bulleted lists over
long paragraphs.`;

export function ambientPrompt(sentinel: string): string {
  return `You are a participant in a shared Slack thread with several people. Each
message is prefixed with the sender's name in square brackets. Messages are
forwarded to you whether or not they are addressed to you. If a message is
not for you, or you have nothing useful to add, reply with exactly
${sentinel} and nothing else — the reply will be suppressed. When you are
addressed directly, always answer.`;
}
