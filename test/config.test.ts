import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, readConfigFile, redactConfig, configTemplate } from "../src/config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sab-cfg-"));
function write(name: string, obj: unknown): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
const base = { slack: { botToken: "xoxb-file", appToken: "xapp-file" } };

describe("config.json loading", () => {
  it("reads the file and applies defaults", () => {
    const c = loadConfig({ configPath: write("a.json", { ...base, agent: "claude" }), env: {} });
    expect(c.slackBotToken).toBe("xoxb-file");
    expect(c.cwd).toBe(process.cwd());
    expect(c.permissionMode).toBe("bypassPermissions");
    expect(c.claude.chrome).toBe(true);
    expect(c.sessionIdleTimeoutS).toBe(14400);
    expect(c.configPath).toContain("a.json");
  });

  it("environment variables override file values", () => {
    const c = loadConfig({
      configPath: write("b.json", { ...base, permissionMode: "default", ambient: true }),
      env: { SLACK_BOT_TOKEN: "xoxb-env", PERMISSION_MODE: "plan", AMBIENT: "0", SESSION_IDLE_TIMEOUT_S: "0" },
    });
    expect(c.slackBotToken).toBe("xoxb-env");
    expect(c.slackAppToken).toBe("xapp-file");
    expect(c.permissionMode).toBe("plan");
    expect(c.ambient).toBe(false);
    expect(c.sessionIdleTimeoutS).toBe(0);
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => readConfigFile(write("c.json", { ...base, permisionMode: "x" }))).toThrow(/unknown key "permisionMode"/);
    expect(() => readConfigFile(write("d.json", { ...base, slack: { botToken: "x", token: "y" } }))).toThrow(/slack\.token/);
    expect(() => loadConfig({ configPath: write("e.json", { ...base, agent: "codex" }), env: {} })).toThrow(/not defined/);
    expect(() => loadConfig({ configPath: write("f.json", { slack: { botToken: "nope", appToken: "xapp-x" } }), env: {} })).toThrow(/xoxb-/);
  });

  it("defines extra agents and channel defaults", () => {
    const c = loadConfig({
      configPath: write("g.json", { ...base, agents: { codex: { command: "codex-acp" } }, channelAgents: { C1: "codex" } }),
      env: {},
    });
    expect(Object.keys(c.agents)).toEqual(["claude", "codex"]);
    expect(c.channelAgents.C1).toBe("codex");
  });

  it("requires tokens unless allowed, and redacts them", () => {
    expect(() => loadConfig({ configPath: write("h.json", {}), env: {} })).toThrow(/tokens missing/);
    const c = loadConfig({ configPath: write("h.json", {}), env: {}, allowMissingTokens: true });
    expect(redactConfig(c).slackBotToken).toBe("(unset)");
    expect(redactConfig(loadConfig({ configPath: write("i.json", base), env: {} })).slackBotToken).toMatch(/^xoxb-…/);
    expect(configTemplate().slack?.botToken).toMatch(/REPLACE/);
  });
});
