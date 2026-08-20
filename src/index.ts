#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  configTemplate,
  defaultConfigPath,
  loadConfig,
  redactConfig,
  type BridgeConfig,
} from "./config.js";
import { AgentHost } from "./host/host.js";
import { createLogger, setLogLevel } from "./logger.js";
import { buildManifest, SETUP_STEPS } from "./manifest.js";
import { SlackBridge } from "./slack/app.js";

process.title = "slack-acp-bridge";

const USAGE = `Usage: slack-acp-bridge [--config <path>] [command]

Configuration: ~/.config/slack-acp-bridge/config.json (or --config / $SLACK_ACP_BRIDGE_CONFIG).
Environment variables override individual keys (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, AGENT, AGENT_CWD,
PERMISSION_MODE, LOG_LEVEL, …).

Commands:
  (none)      run the bridge
  init        write a config.json template (--bot-token, --app-token, --force)
  config      print the resolved configuration (tokens redacted) and paths
  manifest    print the Slack app manifest JSON (--name <app name>, --description <text>, --steps)
  help        show this message
`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

async function cli(argv: string[]): Promise<BridgeConfig | undefined> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      steps: { type: "boolean" },
      "bot-token": { type: "string" },
      "app-token": { type: "string" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0];
  if (values.help || cmd === "help") {
    process.stdout.write(USAGE);
    return undefined;
  }
  switch (cmd) {
    case undefined:
      return loadConfig({ configPath: values.config });
    case "manifest":
      process.stdout.write(JSON.stringify(buildManifest({ name: values.name, description: values.description }), null, 2) + "\n");
      if (values.steps) process.stderr.write("\n" + SETUP_STEPS);
      return undefined;
    case "config": {
      const cfg = loadConfig({ configPath: values.config, allowMissingTokens: true });
      process.stdout.write(
        JSON.stringify({ configPath: cfg.configPath ?? `(none; defaults + env — would read ${defaultConfigPath()})`, ...redactConfig(cfg) }, null, 2) + "\n",
      );
      return undefined;
    }
    case "init": {
      const file = values.config ?? defaultConfigPath();
      if (fs.existsSync(file) && !values.force) fail(`${file} already exists (use --force to overwrite)`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(configTemplate({ botToken: values["bot-token"], appToken: values["app-token"] }), null, 2) + "\n", { mode: 0o600 });
      process.stdout.write(`wrote ${file}\n`);
      if (!values["bot-token"] || !values["app-token"]) {
        process.stdout.write(`edit it and fill in slack.botToken / slack.appToken (run \`slack-acp-bridge manifest --steps\` to create the Slack app)\n`);
      }
      return undefined;
    }
    default:
      fail(`unknown command: ${cmd}\n${USAGE}`);
  }
}

async function run(cfg: BridgeConfig): Promise<void> {
  setLogLevel(cfg.logLevel);
  const log = createLogger("slack-acp-bridge");
  log.info(`config=${cfg.configPath ?? "(env only)"} agent=${cfg.defaultAgent} cwd=${cfg.cwd} mode=${cfg.permissionMode} ambient=${cfg.ambient} state=${cfg.stateDir}`);

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

cli(process.argv.slice(2))
  .then((cfg) => (cfg ? run(cfg) : undefined))
  .catch((e) => {
    const debug = (process.env.LOG_LEVEL ?? "").toLowerCase() === "debug";
    const text = e instanceof Error ? (debug ? (e.stack ?? e.message) : e.message) : String(e);
    process.stderr.write(`fatal: ${text}\n`);
    process.exit(1);
  });
