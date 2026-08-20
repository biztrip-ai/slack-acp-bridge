import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AgentConfig } from "./host/types.js";

/* ------------------------------------------------------------------ paths */

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "slack-acp-bridge");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultConfigDir(env), "config.json");
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "slack-acp-bridge");
}

/* ------------------------------------------------------------- file shape */

/** Shape of config.json. Every key is optional; see `DEFAULTS`. */
export interface ConfigFile {
  slack?: {
    botToken?: string;
    appToken?: string;
    /** Slack-compatible API base (e.g. Flow). Omit for real Slack. */
    apiUrl?: string;
  };
  /** Agent used for new sessions (a key of `agents`; "claude" is built in). */
  agent?: string;
  agents?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Per-channel default agent: channel id → agent name. */
  channelAgents?: Record<string, string>;
  /** Working directory every session runs in. */
  cwd?: string;
  /** Default ACP session mode (claude: default | acceptEdits | plan | bypassPermissions | auto). */
  permissionMode?: string;
  /** Unanswered permission prompts are cancelled after this many seconds. */
  permissionTimeoutS?: number;
  /** Claude-specific passthrough (ignored by other agents). */
  claude?: { model?: string; settingSources?: string[]; chrome?: boolean };
  /** Appended to the agent system prompt. null/omitted = built-in Slack mrkdwn guidance; "" disables. */
  systemPromptAppend?: string | null;
  ambient?: boolean;
  silentSentinel?: string;
  session?: { idleTimeoutS?: number; reapIntervalS?: number };
  stateDir?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

const KNOWN_KEYS: Record<string, string[] | null> = {
  slack: ["botToken", "appToken", "apiUrl"],
  agent: null,
  agents: null,
  channelAgents: null,
  cwd: null,
  permissionMode: null,
  permissionTimeoutS: null,
  claude: ["model", "settingSources", "chrome"],
  systemPromptAppend: null,
  ambient: null,
  silentSentinel: null,
  session: ["idleTimeoutS", "reapIntervalS"],
  stateDir: null,
  logLevel: null,
};

/** Resolved, validated configuration used by the runtime. */
export interface BridgeConfig {
  configPath?: string;
  slackBotToken: string;
  slackAppToken: string;
  slackApiUrl?: string;
  defaultAgent: string;
  agents: Record<string, AgentConfig>;
  channelAgents: Record<string, string>;
  cwd: string;
  permissionMode: string;
  permissionTimeoutS: number;
  claude: { model?: string; settingSources: string[]; chrome: boolean };
  systemPromptAppend: string;
  ambient: boolean;
  silentSentinel: string;
  sessionIdleTimeoutS: number; // 0 disables the reaper
  sessionReapIntervalS: number;
  stateDir: string;
  logLevel: string;
}

/* --------------------------------------------------------------- helpers */

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
}

function num(v: unknown, name: string, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: ${name} must be a number (got ${JSON.stringify(v)})`);
  return n;
}

function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Resolve the bundled claude-agent-acp entry point so we can run it under the current node. */
export function bundledClaudeAgent(): AgentConfig {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
  const entry = path.join(path.dirname(pkg), "dist", "index.js");
  return { name: "claude", command: process.execPath, args: [entry] };
}

export function readConfigFile(file: string): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`config: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`config: ${file} must contain a JSON object`);
  const obj = raw as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in KNOWN_KEYS)) throw new Error(`config: unknown key "${k}" in ${file}`);
    const sub = KNOWN_KEYS[k];
    if (sub && v && typeof v === "object") {
      for (const sk of Object.keys(v as object)) {
        if (!sub.includes(sk)) throw new Error(`config: unknown key "${k}.${sk}" in ${file}`);
      }
    }
  }
  return obj as ConfigFile;
}

/* ------------------------------------------------------------------ load */

export interface LoadOptions {
  /** Explicit path; otherwise $SLACK_ACP_BRIDGE_CONFIG, then the XDG default (if it exists). */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip the token requirement (for `config` / `init` subcommands). */
  allowMissingTokens?: boolean;
}

/**
 * Precedence: built-in defaults < config.json < environment variables.
 */
export function loadConfig(opts: LoadOptions = {}): BridgeConfig {
  const env = opts.env ?? process.env;
  let file: ConfigFile = {};
  let configPath = opts.configPath ?? env.SLACK_ACP_BRIDGE_CONFIG;
  if (configPath) {
    configPath = expandHome(configPath);
    file = readConfigFile(configPath);
  } else if (fs.existsSync(defaultConfigPath(env))) {
    configPath = defaultConfigPath(env);
    file = readConfigFile(configPath);
  }

  const slackBotToken = env.SLACK_BOT_TOKEN ?? file.slack?.botToken ?? "";
  const slackAppToken = env.SLACK_APP_TOKEN ?? file.slack?.appToken ?? "";
  if (!opts.allowMissingTokens && (!slackBotToken || !slackAppToken)) {
    throw new Error(
      `Slack tokens missing. Put slack.botToken (xoxb-…) and slack.appToken (xapp-…) in ${configPath ?? defaultConfigPath(env)} ` +
        `(run \`slack-acp-bridge init\` to create it) or set SLACK_BOT_TOKEN / SLACK_APP_TOKEN.`,
    );
  }
  if (slackBotToken && !slackBotToken.startsWith("xoxb-")) throw new Error("config: slack.botToken should start with xoxb-");
  if (slackAppToken && !slackAppToken.startsWith("xapp-")) throw new Error("config: slack.appToken should start with xapp-");

  const agents: Record<string, AgentConfig> = { claude: bundledClaudeAgent() };
  for (const [name, a] of Object.entries(file.agents ?? {})) {
    if (!a || typeof a.command !== "string" || !a.command) throw new Error(`config: agents.${name}.command is required`);
    agents[name] = { name, command: a.command, args: a.args ?? [], env: a.env };
  }
  const defaultAgent = env.AGENT ?? file.agent ?? "claude";
  if (!agents[defaultAgent]) {
    throw new Error(`config: agent "${defaultAgent}" is not defined (known: ${Object.keys(agents).join(", ")})`);
  }
  const channelAgents = env.CHANNEL_AGENTS ? (JSON.parse(env.CHANNEL_AGENTS) as Record<string, string>) : (file.channelAgents ?? {});
  for (const [ch, a] of Object.entries(channelAgents)) {
    if (!agents[a]) throw new Error(`config: channelAgents.${ch} → "${a}" is not a defined agent`);
  }

  const ambient = env.AMBIENT !== undefined ? truthy(env.AMBIENT) : (file.ambient ?? false);
  const silentSentinel = env.SILENT_SENTINEL ?? file.silentSentinel ?? "<<SILENT>>";
  const appendRaw = env.SYSTEM_PROMPT_APPEND ?? file.systemPromptAppend;
  let systemPromptAppend = appendRaw === undefined || appendRaw === null ? SLACK_FORMATTING_PROMPT : appendRaw;
  if (ambient && systemPromptAppend !== "") systemPromptAppend += "\n\n" + ambientPrompt(silentSentinel);

  const idle = num(env.SESSION_IDLE_TIMEOUT_S ?? file.session?.idleTimeoutS, "session.idleTimeoutS", 14400);
  const logLevel = env.LOG_LEVEL ?? file.logLevel ?? "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error(`config: logLevel must be debug|info|warn|error`);

  return {
    configPath,
    slackBotToken,
    slackAppToken,
    slackApiUrl: env.SLACK_API_URL || file.slack?.apiUrl || undefined,
    defaultAgent,
    agents,
    channelAgents,
    cwd: expandHome(env.AGENT_CWD ?? env.CLAUDE_CWD ?? file.cwd ?? os.homedir()),
    permissionMode: env.PERMISSION_MODE ?? env.CLAUDE_PERMISSION_MODE ?? file.permissionMode ?? "bypassPermissions",
    permissionTimeoutS: num(env.PERMISSION_TIMEOUT_S ?? file.permissionTimeoutS, "permissionTimeoutS", 600),
    claude: {
      model: env.CLAUDE_MODEL || file.claude?.model || undefined,
      settingSources: splitList(env.CLAUDE_SETTING_SOURCES) ?? file.claude?.settingSources ?? ["user", "project", "local"],
      chrome: env.CLAUDE_CHROME !== undefined ? truthy(env.CLAUDE_CHROME) : (file.claude?.chrome ?? false),
    },
    systemPromptAppend,
    ambient,
    silentSentinel,
    sessionIdleTimeoutS: idle > 0 ? idle : 0,
    sessionReapIntervalS: num(env.SESSION_REAP_INTERVAL_S ?? file.session?.reapIntervalS, "session.reapIntervalS", 300),
    stateDir: expandHome(env.STATE_DIR ?? file.stateDir ?? defaultStateDir(env)),
    logLevel,
  };
}

/** Redacted view for `slack-acp-bridge config`. */
export function redactConfig(c: BridgeConfig): Record<string, unknown> {
  const mask = (t: string) => (t ? `${t.slice(0, 5)}…(${t.length} chars)` : "(unset)");
  const { slackBotToken, slackAppToken, agents, ...rest } = c;
  return {
    ...rest,
    slackBotToken: mask(slackBotToken),
    slackAppToken: mask(slackAppToken),
    agents: Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, { command: a.command, args: a.args }])),
  };
}

/** Template written by `slack-acp-bridge init`. */
export function configTemplate(tokens: { botToken?: string; appToken?: string } = {}): ConfigFile {
  return {
    slack: { botToken: tokens.botToken ?? "xoxb-REPLACE-ME", appToken: tokens.appToken ?? "xapp-REPLACE-ME" },
    agent: "claude",
    agents: {},
    channelAgents: {},
    cwd: os.homedir(),
    permissionMode: "bypassPermissions",
    permissionTimeoutS: 600,
    claude: { settingSources: ["user", "project", "local"], chrome: false },
    ambient: false,
    silentSentinel: "<<SILENT>>",
    session: { idleTimeoutS: 14400, reapIntervalS: 300 },
    stateDir: defaultStateDir(),
    logLevel: "info",
  };
}

/* ----------------------------------------------------------------- prompts */

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
