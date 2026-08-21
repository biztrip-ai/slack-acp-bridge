# slack-acp-bridge

A Slack bot that turns any [ACP](https://agentclientprotocol.com)-speaking coding
agent into an AI teammate. Mention it in a channel to start a thread; every reply
in that thread continues the same agent session. Runs over Slack **Socket Mode**
(no public URL) on a machine you control, so the agent has your full dev
environment: repos, CLIs, MCP servers, browser automation.

Ships with Claude Code (via
[`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp))
built in; any other ACP agent (`codex-acp`, Gemini CLI, OpenCode, …) is one line
of JSON away.

```
Slack ──Socket Mode──▶ slack-acp-bridge ──stdio/ACP──▶ claude-agent-acp ──▶ claude
                              │                                           ──▶ claude
                              └── sqlite: thread → session                ──▶ claude
```

## Features

### Conversations

- **One thread, one agent session.** An `@mention` starts a thread and an ACP
  session; every reply in that thread — from anyone, with or without re-mentioning
  the bot — continues it. DMs get a session per conversation. Any number of
  threads and people run at once, each with an isolated agent session.
- **Queued, never cancelled.** A second message while the agent is working is
  queued (with a "⏳ queued" placeholder) and runs next. Nobody's "thanks!" kills
  a PR review halfway through. `/stop` cancels explicitly, dropping the queue.
- **Survives restarts and idle eviction.** The thread→session map lives in
  SQLite; when the bridge restarts or an idle session is reaped (default 4h, to
  free the agent subprocess), the next reply re-attaches via ACP `session/load`
  with the full conversation history intact.

### Streaming and Slack UX

- **Live streaming** into a single message edited in place, throttled to Slack's
  ~1 update/s limit, with a random "thinking…" placeholder while the agent starts.
- **Long replies roll over** into follow-up messages well before Slack's real
  `msg_too_long` threshold (not just the documented one), and recover if Slack
  rejects an update anyway.
- **Slack mrkdwn out of the box.** The agent's system prompt is extended with
  Slack's formatting dialect (no `**bold**`, no tables, `<url|label>` links), so
  replies render cleanly.
- **Media in and out.** Files posted in Slack reach the agent (images inline,
  other files as readable `resource_link`s), and the agent can send screenshots,
  PDFs, logs and progress notes back into the thread via its per-session Slack
  MCP tools or an `ATTACH: /path` line in its reply.

### Safety and permissions

- **Permission prompts as Slack buttons.** Run a thread in `default`,
  `acceptEdits` or `plan` mode and each tool approval the agent asks for is
  posted in the thread with one button per option. Anyone in the thread can
  click; unanswered prompts time out (default 10 min); `/stop` cancels them.
  `bypassPermissions` (the default) skips prompts entirely for trusted setups.
- **Per-thread modes**, persisted: `/mode acceptEdits` in one thread doesn't
  affect others, and survives restarts and agent switches.

### Commands

`/clear` (reset the thread's session), `/stop` (cancel the running turn),
`/agent [name]`, `/mode [id]`, `/help`. Every command is also accepted as
`!clear`, `!stop`, … inside a message, so they work without the `commands`
scope and in Slack-compatible servers that lack slash commands.

### Multiple agents

- **Any ACP agent.** Claude Code is bundled (via `claude-agent-acp`); add Codex,
  Gemini CLI, OpenCode or any other [ACP](https://agentclientprotocol.com) agent
  with one config entry. Agent-specific extras (Claude's model, setting sources,
  `--chrome`) are passed through when the agent is Claude and ignored otherwise.
- **Per-thread and per-channel selection.** `/agent codex` switches a thread
  (starting a fresh session); `channelAgents` sets a default per channel.

### Ambient mode

With `ambient: true` the bot behaves like a teammate who is *in* the thread: every
reply is forwarded with the sender's name, the agent decides whether it has
something to add, and it stays silent by answering `<<SILENT>>` — nothing is
posted, no placeholder flickers. `@mention` is a summons, not a gate.

### Operations

- **Socket Mode** — no public URL, runs on a laptop or a box behind a firewall.
- **One JSON config file** (`~/.config/slack-acp-bridge/config.json`) with
  environment-variable overrides, strict key validation, and `init` / `config`
  subcommands; `manifest` prints the Slack app manifest so app setup is a paste.
- **Slack-compatible servers**: point `slack.apiUrl` at a Flow-style server.
- **Observable**: one log line per incoming message, tool call, tool result and
  turn end; `logLevel: debug` adds full prompts, results and thinking.
- **Usable as a library** — the ACP host (agents, sessions, re-attach, turn
  queue, permission routing) has no Slack dependency; see [Library use](#library-use).

## Setup

### Slack app

1. Print the manifest (`npx slack-acp-bridge manifest --name mybot --steps`, or
   use [`docs/slack-app-manifest.json`](docs/slack-app-manifest.json)), then at
   <https://api.slack.com/apps> → **Create New App** → **From a manifest** →
   paste it. It enables Socket Mode, interactivity (for permission buttons), the
   DM tab, the slash commands, and these bot scopes: `app_mentions:read`, `chat:write`,
   `commands`, `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, `im:read`, `im:write`, `users:read`, `files:read`, `files:write`.
2. **Basic Information → App-Level Tokens** → create one with
   `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → `SLACK_BOT_TOKEN` (`xoxb-…`). Invite the bot to channels.

Changing scopes or events later requires reinstalling the app.

### Install & run

Requires Node ≥ 22.13 and a logged-in `claude` CLI on the host (`claude` must
run from your shell without prompting).

```bash
npm install -g slack-acp-bridge
slack-acp-bridge manifest --steps          # create the Slack app from this
slack-acp-bridge init                      # writes ~/.config/slack-acp-bridge/config.json (mode 600)
$EDITOR ~/.config/slack-acp-bridge/config.json   # tokens, cwd, …
slack-acp-bridge config                    # resolved configuration, tokens redacted
slack-acp-bridge                           # run (process title "slack-acp-bridge")
```

Or without installing: `npx slack-acp-bridge …`. From a checkout:
`npm install && npm run build && npm start`.

On macOS run under `caffeinate -dimsu -- slack-acp-bridge` so App Nap doesn't pause
the Socket Mode heartbeat.

### Configuration

Configuration lives in **`~/.config/slack-acp-bridge/config.json`**
(`$XDG_CONFIG_HOME` respected; override with `--config <path>` or
`$SLACK_ACP_BRIDGE_CONFIG`). Unknown keys are rejected. Every key is optional
except the Slack tokens. See [`config.example.json`](config.example.json).

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `slack.botToken`, `slack.appToken` | — | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | required |
| `slack.apiUrl` | real Slack | `SLACK_API_URL` | Slack-compatible server (e.g. Flow) |
| `agent` | `claude` | `AGENT` | agent used for new sessions |
| `agents` | `{}` | — | extra agents: `{ name: { command, args, env, permissionMode } }`; `claude` is built in |
| `channelAgents` | `{}` | `CHANNEL_AGENTS` (JSON) | channel id → agent name |
| `cwd` | `$HOME` | `AGENT_CWD` | working directory for every session |
| `permissionMode` | `bypassPermissions` | `PERMISSION_MODE` | default ACP session mode; per agent via `agents.<name>.permissionMode`, per thread with `!mode`. Modes the agent doesn't offer are ignored with a warning |
| `permissionTimeoutS` | `600` | `PERMISSION_TIMEOUT_S` | unanswered prompts are cancelled after this |
| `claude.model` | agent default | `CLAUDE_MODEL` | Claude only |
| `claude.settingSources` | `["user","project","local"]` | `CLAUDE_SETTING_SOURCES` | which `~/.claude` / project config layers Claude loads |
| `claude.chrome` | `false` | `CLAUDE_CHROME` | spawn Claude with `--chrome` |
| `systemPromptAppend` | Slack-mrkdwn guidance | `SYSTEM_PROMPT_APPEND` | `""` disables |
| `ambient` | `false` | `AMBIENT` | follow un-addressed thread replies; agent may abstain |
| `silentSentinel` | `<<SILENT>>` | `SILENT_SENTINEL` | |
| `session.idleTimeoutS` | `14400` | `SESSION_IDLE_TIMEOUT_S` | `0` disables the reaper |
| `session.reapIntervalS` | `300` | `SESSION_REAP_INTERVAL_S` | |
| `stateDir` | `~/.local/state/slack-acp-bridge` | `STATE_DIR` | holds `sessions.db` and uploads |
| `logLevel` | `info` | `LOG_LEVEL` | `debug` logs full prompts, tool results, thinking |
| `slackMcp` | `true` | `SLACK_MCP` | give each session the Slack MCP server (`slack_upload_file`, `slack_post_message`) |
| `attachMarker` | `true` | `ATTACH_MARKER` | upload files named on `ATTACH: <path>` lines of the reply |

Environment variables override file values, which override defaults.

Runtime state (not configuration) lives in `stateDir`: `sessions.db` (thread →
session map and per-thread `!agent`/`!mode` preferences) and `uploads/`.

### About `PERMISSION_MODE`

The default, `bypassPermissions`, lets the agent run any tool with no human in
the loop — treat the bot as a remote-code-execution surface scoped to the
account it runs under, and lock down `AGENT_CWD` accordingly. For a tighter
blast radius use `acceptEdits` or `default` (globally, or per thread with
`!mode`): the agent's permission requests are posted in the thread as buttons;
anyone in the thread can click; unanswered prompts cancel after
`PERMISSION_TIMEOUT_S`. Requests for threads the bridge can't map (shouldn't
happen) fall back to auto-allow.

## Agent instructions

Setting this up is a good job for a coding agent running on the machine that will
host the bridge. Paste the block below into it; the only steps a human must do by
hand involve Slack tokens.

````text
Set up slack-acp-bridge on this machine (a Slack bot that relays Slack threads to
a local coding agent over ACP). Verify each step before moving on.

1. Install: Node >= 22.13, then `npm install -g slack-acp-bridge`. The agent the
   bridge will run must already work non-interactively on this machine (Claude
   Code by default: `claude -p "say ok"`); if it doesn't, ask me to log in first.

2. Slack app: run `slack-acp-bridge manifest --name <bot name> --steps` (ask me for
   the name). The steps are: api.slack.com/apps -> Create New App -> From a
   manifest -> paste the JSON -> Create; Basic Information -> App-Level Tokens ->
   generate one with scope connections:write (xapp-...); Install App -> Install to
   Workspace (xoxb-...). If you have browser control, offer to drive these steps
   yourself in my logged-in browser; otherwise give me the JSON and the steps.
   Either way, leave copying the tokens to me.

3. Config: run `slack-acp-bridge init`, then ask me to put the two tokens into
   ~/.config/slack-acp-bridge/config.json myself (slack.botToken, slack.appToken).
   Never take tokens through the chat or a command line. Set cwd to the directory
   the agent should work in (ask me). Check with `slack-acp-bridge config`:
   tokens must not show "(unset)".

4. Run: `slack-acp-bridge > ~/slack-acp-bridge.log 2>&1 &` (on macOS wrap it in
   `caffeinate -dimsu --`). Wait for "connected; bot user U..." in the log.
   invalid_auth = wrong token; missing_scope = reinstall the app.

5. Verify: ask me to `/invite` the bot to a channel and mention it. Confirm the
   log shows a session created and `stop=end_turn`, and the reply is in Slack.

Finish by telling me the config and log paths, how to restart
(`pkill -f slack-acp-bridge`, then the run command), and the thread commands:
/clear, /stop, /agent [name], /mode [id], /help (or !clear, !stop, ... in a message).
````

## Rich media from the agent

Two mechanisms, both on by default and both explained to the agent in its
system prompt:

- **Slack MCP server** (`slackMcp`). Every session is handed a stdio MCP server
  (via ACP `mcpServers`) exposing `slack_upload_file(path, title?, comment?)`
  and `slack_post_message(text)`, scoped to that session's thread. The MCP
  process holds no Slack credentials: it forwards calls over a unix socket
  (`<stateDir>/bridge.sock`, mode 600) and the bridge performs the API call.
- **`ATTACH:` marker** (`attachMarker`). A reply line `ATTACH: /abs/or/relative/path`
  is stripped from the streamed message and the file is uploaded when the turn
  ends — works with any agent, no tool support needed. (Bizzybot's protocol.)

Uploads need the `files:write` bot scope.

## Library use

The ACP host is usable without Slack:

```ts
import { AgentHost, bundledClaudeAgent, createLogger } from "slack-acp-bridge";

const host = new AgentHost(
  { agents: { claude: bundledClaudeAgent() }, defaultAgent: "claude", cwd: process.cwd(),
    stateDir: "/tmp/acp-state", idleTimeoutS: 0, reapIntervalS: 60 },
  createLogger("demo"),
);
const session = await host.getOrCreate("demo:1", { channel: "demo", threadTs: null });
for await (const ev of session.send("say hi")) if (ev.kind === "text") process.stdout.write(ev.text);
await host.close();
```

`AgentHost` spawns agents, maps keys to sessions (SQLite, `session/load` on
re-attach), serializes turns per session and emits a normalized `TurnEvent`
stream. `host.onPermission(...)` receives permission requests; without a
handler they are auto-allowed.

## Development

```bash
npm test          # vitest unit tests (streamer, store, turn queue)
npm run smoke     # spawns the real claude-agent-acp, prompts it, re-attaches via session/load
npm run smoke:mcp # agent calls slack_post_message through the MCP server → bridge socket
npm run dev       # tsx src/index.ts
```

Layout:

```
src/host/     ACP side: agent subprocess, session/turn queue, sqlite map, reaper. No Slack.
src/slack/    Bolt Socket Mode app, streaming, thread routing, /clear. No ACP.
src/config.ts env → config
```

## Roadmap

- `AskUserQuestion` as a Block Kit form (ACP form elicitation)
- Tool-call progress in the thread (collapsed), diffs
- Backfill of messages missed while the bridge was down

## License

MIT
