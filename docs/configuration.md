# Configuration

Configuration lives in **`~/.config/slack-acp-bridge/config.json`**
(`$XDG_CONFIG_HOME` respected; override with `--config <path>` or
`$SLACK_ACP_BRIDGE_CONFIG`). Unknown keys are rejected. Every key is optional
except the Slack tokens. See [`config.example.json`](../config.example.json).

| Key | Default | Env override | Notes |
| --- | --- | --- | --- |
| `slack.botToken`, `slack.appToken` | — | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | required |
| `slack.apiUrl` | real Slack | `SLACK_API_URL` | Slack-compatible server (e.g. Flow) |
| `agent` | `claude` | `AGENT` | agent used for new sessions |
| `agents` | `{}` | — | extra agents: `{ name: { command, args, env, permissionMode } }`; `claude` is built in |
| `channelAgents` | `{}` | `CHANNEL_AGENTS` (JSON) | channel id → agent name |
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

The agent's **working directory is the directory the bridge is started from** —
`cd` into the repo (or wherever the agent should work) before running
`slack-acp-bridge`. It is not a config key.

Runtime state (not configuration) lives in `stateDir`: `sessions.db` (thread →
session map and per-thread `!agent`/`!mode` preferences) and `uploads/`.

## About `PERMISSION_MODE`

The default, `bypassPermissions`, lets the agent run any tool with no human in
the loop — treat the bot as a remote-code-execution surface scoped to the
account it runs under, and lock down `AGENT_CWD` accordingly. For a tighter
blast radius use `acceptEdits` or `default` (globally, or per thread with
`!mode`): the agent's permission requests are posted in the thread as buttons;
anyone in the thread can click; unanswered prompts cancel after
`PERMISSION_TIMEOUT_S`. Requests for threads the bridge can't map (shouldn't
happen) fall back to auto-allow.
