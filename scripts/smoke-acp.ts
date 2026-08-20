/**
 * Smoke test for the ACP host without Slack: spawns the bundled
 * claude-agent-acp, opens a session, sends one prompt, prints the events,
 * then re-attaches via session/load and sends a follow-up.
 *
 *   npx tsx scripts/smoke-acp.ts "what is 2+2? answer in one word"
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AgentHost } from "../src/host/host.js";
import { bundledClaudeAgent, SLACK_FORMATTING_PROMPT } from "../src/config.js";
import { createLogger, setLogLevel } from "../src/logger.js";

setLogLevel(process.env.LOG_LEVEL ?? "info");
const log = createLogger("smoke");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-acp-bridge-smoke-"));

const host = new AgentHost(
  {
    agents: { claude: bundledClaudeAgent() },
    defaultAgent: "claude",
    cwd: process.env.AGENT_CWD ?? os.homedir(),
    permissionMode: process.env.PERMISSION_MODE ?? "bypassPermissions",
    systemPromptAppend: SLACK_FORMATTING_PROMPT,
    stateDir,
    idleTimeoutS: 0,
    reapIntervalS: 60,
  },
  log,
);

async function turn(text: string) {
  const s = await host.getOrCreate("smoke:1", { channel: "C0", threadTs: "1.0" });
  let out = "";
  for await (const ev of s.send(text)) {
    if (ev.kind === "text") {
      out += ev.text;
      process.stdout.write(ev.text);
    } else if (ev.kind === "tool_call") process.stdout.write(`\n[tool] ${ev.title}\n`);
    else if (ev.kind === "done") process.stdout.write(`\n[done] ${ev.stopReason}\n`);
  }
  return out;
}

const prompt = process.argv[2] ?? "Reply with exactly: pong";
await turn(prompt);
// Simulate a reap/restart: forget the in-memory session, keep the row, load it back.
(host as unknown as { sessions: Map<string, unknown> }).sessions.clear();
log.info("re-attaching via session/load …");
await turn("What did I just ask you? One short sentence.");
await host.close();
fs.rmSync(stateDir, { recursive: true, force: true });
