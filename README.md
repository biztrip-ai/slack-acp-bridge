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
- `/clear` resets a thread's session.
- Agent-agnostic core: the Slack layer only sees a normalized event stream.

## Setup

### Slack app

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. **Socket Mode** → on. **Basic Information → App-Level Tokens** → create one
   with `connections:write` → `SLACK_APP_TOKEN` (`xapp-…`).
3. **OAuth & Permissions → Bot Token Scopes**: `app_mentions:read`, `chat:write`,
   `channels:history`, `groups:history`, `im:history`, `mpim:history`, `im:read`,
   `im:write`, `users:read`, `commands`.
4. **Event Subscriptions** → subscribe to bot events `app_mention`,
   `message.channels`, `message.groups`, `message.im`, `message.mpim`.
5. **Slash Commands** → create `/clear` (any placeholder URL; Socket Mode ignores it).
6. **Install App** → `SLACK_BOT_TOKEN` (`xoxb-…`). Invite the bot to channels.

Changing scopes later requires reinstalling the app.

### Run

Requires Node ≥ 22.13 and a logged-in `claude` CLI on the host.

```bash
npm install
cp .env.example .env   # fill in tokens, AGENT_CWD
npm run build
npm start          # process title is "slack-acp-bridge" (pkill -f slack-acp-bridge)
```

On macOS run under `caffeinate -dimsu -- npm start` so App Nap doesn't pause
the Socket Mode heartbeat.

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | — | required |
| `SLACK_API_URL` | — | point at a Slack-compatible server (e.g. Flow) |
| `AGENT` | `claude` | agent used for new sessions |
| `AGENTS_FILE` | — | JSON `{ name: { command, args, env } }` adding more agents (see `agents.example.json`) |
| `AGENT_CWD` (`CLAUDE_CWD`) | `$HOME` | working directory for every session |
| `PERMISSION_MODE` (`CLAUDE_PERMISSION_MODE`) | `bypassPermissions` | ACP session mode requested after creation |
| `CLAUDE_MODEL` | agent default | Claude only |
| `CLAUDE_SETTING_SOURCES` | `user,project,local` | which `~/.claude` / project config layers Claude loads |
| `CLAUDE_CHROME` | `0` | `1` spawns Claude with `--chrome` |
| `SYSTEM_PROMPT_APPEND` | Slack-mrkdwn guidance | appended to the agent system prompt; `""` disables |
| `SESSION_IDLE_TIMEOUT_S` | `14400` | `0` disables the reaper |
| `SESSION_REAP_INTERVAL_S` | `300` | |
| `STATE_DIR` | `~/.local/state/slack-acp-bridge` | holds `sessions.db` |
| `LOG_LEVEL` | `info` | `debug` logs full prompts, tool results, thinking |

### About `PERMISSION_MODE`

There is no approval UI in Slack yet, so the default mode lets the agent run any
tool without a human in the loop. Treat the bot as a remote-code-execution
surface scoped to the account it runs under, and lock down `AGENT_CWD`
accordingly. Permission requests that do arrive are auto-approved.

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

- Block Kit permission prompts (so `acceptEdits`/`default` modes become usable from Slack)
- `/agent <name>` per-thread agent switching; `/stop` (ACP `session/cancel`)
- Image and file attachments → ACP content blocks
- Ambient mode (follow a thread without re-mentioning) with an abstain sentinel

## License

MIT
