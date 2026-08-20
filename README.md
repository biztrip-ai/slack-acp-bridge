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

- One persistent agent session per Slack thread (or per DM). Multiple people and
  threads at once.
- Streaming replies: a single message edited in place (1 update/s), rolling over
  to a new message near Slack's length limit.
- Turns on the same thread are **queued**, not cancelled — a "thanks" mid-task
  won't kill a PR review. A queued message shows a "⏳ queued" placeholder.
- **Survives restarts.** The thread→session map is in SQLite; the next reply in
  an old thread re-attaches with `session/load`, history intact.
- Idle sessions are reaped (default 4h) to free memory; they re-load on demand.
- **Permission prompts in Slack.** Run a thread in `acceptEdits`/`default`/`plan`
  mode and tool approvals show up as buttons in the thread (one click, with a
  timeout). `bypassPermissions` skips them.
- **Commands**: `/clear`, `/stop`, `/agent [name]`, `/mode [id]`, `/help` — also
  accepted as `!clear`, `!stop`, … in a message, so they work even without the
  `commands` scope.
- **Multiple agents**: switch per thread with `!agent codex`, or set a per-channel
  default with `CHANNEL_AGENTS`.
- **Attachments**: images go to the agent inline; other files are saved and
  passed as `resource_link`s it can read.
- **Ambient mode** (`AMBIENT=1`): the bot follows every reply in threads it's part
  of, sees who said what, and can stay silent by answering `<<SILENT>>`.
- Agent-agnostic core: the Slack layer only sees a normalized event stream.

## Setup

### Slack app

1. Print the manifest (`npx slack-acp-bridge manifest --name mybot --steps`, or
   use [`docs/slack-app-manifest.json`](docs/slack-app-manifest.json)), then at
   <https://api.slack.com/apps> → **Create New App** → **From a manifest** →
   paste it. It enables Socket Mode, interactivity (for permission buttons), the
   DM tab, the slash commands, and these bot scopes: `app_mentions:read`, `chat:write`,
   `commands`, `channels:history`, `groups:history`, `im:history`,
   `mpim:history`, `im:read`, `im:write`, `users:read`, `files:read`.
2. **Basic Information → App-Level Tokens** → create one with
   `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → `SLACK_BOT_TOKEN` (`xoxb-…`). Invite the bot to channels.

Changing scopes or events later requires reinstalling the app.

### Run

Requires Node ≥ 22.13 and a logged-in `claude` CLI on the host.

```bash
npm install && npm run build
node dist/index.js init      # writes ~/.config/slack-acp-bridge/config.json (mode 600)
$EDITOR ~/.config/slack-acp-bridge/config.json   # tokens, cwd, …
node dist/index.js config    # show the resolved configuration (tokens redacted)
npm start                    # process title is "slack-acp-bridge" (pkill -f slack-acp-bridge)
```

On macOS run under `caffeinate -dimsu -- npm start` so App Nap doesn't pause
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
| `agents` | `{}` | — | extra agents: `{ name: { command, args, env } }`; `claude` is built in |
| `channelAgents` | `{}` | `CHANNEL_AGENTS` (JSON) | channel id → agent name |
| `cwd` | `$HOME` | `AGENT_CWD` | working directory for every session |
| `permissionMode` | `bypassPermissions` | `PERMISSION_MODE` | default ACP session mode; per thread with `!mode` |
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

## Development

```bash
npm test          # vitest unit tests (streamer, store, turn queue)
npm run smoke     # spawns the real claude-agent-acp, prompts it, re-attaches via session/load
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
- A Slack MCP server so agents can upload files/screenshots into their thread
- Backfill of messages missed while the bridge was down

## License

MIT
