/**
 * End-to-end check of the Slack MCP path without Slack: bridge socket server ←
 * per-session MCP server ← claude-agent-acp (via ACP mcpServers). The agent is
 * asked to call slack_post_message; we verify the call reaches our handler.
 *
 *   npx tsx scripts/smoke-mcp.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentHost } from "../src/host/host.js";
import { BridgeSocketServer } from "../src/mcp/bridge-socket.js";
import { bundledClaudeAgent, SLACK_FORMATTING_PROMPT, mediaPrompt } from "../src/config.js";
import { createLogger, setLogLevel } from "../src/logger.js";

setLogLevel(process.env.LOG_LEVEL ?? "info");
const log = createLogger("smoke-mcp");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-mcp-"));
const received: unknown[] = [];
const sock = new BridgeSocketServer(stateDir, async (req) => {
  received.push({ method: req.method, session: req.session, params: req.params });
  log.info(`bridge got ${req.method} from ${req.session}: ${JSON.stringify(req.params)}`);
  return { ok: true };
}, log);
await sock.start();

const serverJs = fileURLToPath(new URL("../dist/mcp/server.js", import.meta.url));
const host = new AgentHost(
  {
    agents: { claude: bundledClaudeAgent() },
    defaultAgent: "claude",
    cwd: os.homedir(),
    permissionMode: "bypassPermissions",
    systemPromptAppend: SLACK_FORMATTING_PROMPT + "\n\n" + mediaPrompt(true, true),
    stateDir,
    idleTimeoutS: 0,
    reapIntervalS: 60,
    mcpServers: (key) => [
      {
        name: "slack",
        command: process.execPath,
        args: [serverJs],
        env: [
          { name: "SLACK_ACP_BRIDGE_SOCK", value: sock.socketPath },
          { name: "SLACK_ACP_BRIDGE_SESSION", value: key },
        ],
      },
    ],
  },
  log,
);

const s = await host.getOrCreate("smoke:mcp", { channel: "C0", threadTs: "1.0" });
let out = "";
for await (const ev of s.send("Call the slack_post_message tool once with text exactly 'hello from mcp', then reply with exactly: posted")) {
  if (ev.kind === "text") out += ev.text;
  else if (ev.kind === "tool_call") log.info(`tool_call: ${ev.title}`);
}
log.info(`agent said: ${out.trim()}`);
await host.close();
await sock.stop();
fs.rmSync(stateDir, { recursive: true, force: true });
const ok = received.some((r) => (r as { method: string; params: { text?: string } }).method === "post_message" && /hello from mcp/i.test(String((r as { params: { text?: string } }).params.text)));
log.info(ok ? "PASS: MCP → bridge socket round trip works" : `FAIL: bridge received ${JSON.stringify(received)}`);
process.exit(ok ? 0 : 1);
