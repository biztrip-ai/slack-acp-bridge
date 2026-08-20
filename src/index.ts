#!/usr/bin/env node
import "dotenv/config";
process.title = "slack-acp-bridge";
import { loadConfig } from "./config.js";
import { AgentHost } from "./host/host.js";
import { createLogger, setLogLevel } from "./logger.js";
import { SlackBridge } from "./slack/app.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const log = createLogger("slack-acp-bridge");
  log.info(`agent=${cfg.defaultAgent} cwd=${cfg.cwd} mode=${cfg.permissionMode} ambient=${cfg.ambient} state=${cfg.stateDir}`);

  const host = new AgentHost(
    {
      agents: cfg.agents,
      defaultAgent: cfg.defaultAgent,
      channelAgents: cfg.channelAgents,
      cwd: cfg.cwd,
      permissionMode: cfg.permissionMode,
      systemPromptAppend: cfg.systemPromptAppend,
      claude: cfg.claude,
      stateDir: cfg.stateDir,
      idleTimeoutS: cfg.sessionIdleTimeoutS,
      reapIntervalS: cfg.sessionReapIntervalS,
    },
    log,
  );
  const bridge = new SlackBridge(cfg, host, log);

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: shutting down`);
    try {
      await bridge.stop();
    } catch (e) {
      log.warn("slack stop failed", e);
    }
    await host.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  host.startReaper();
  log.info("connecting to slack via socket mode");
  await bridge.start();
}

main().catch((e) => {
  const debug = (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";
  const text = e instanceof Error ? (debug ? (e.stack ?? e.message) : e.message) : String(e);
  process.stderr.write(`fatal: ${text}\n`);
  process.exit(1);
});
