import { describe, it, expect } from "vitest";
import { toolLabel } from "../src/slack/tool-label.js";

const call = (o: Record<string, unknown>) => toolLabel({ kind: "tool_call", id: "t", title: "", ...o } as never);

describe("toolLabel", () => {
  it("uses Claude tool names and inputs when available", () => {
    expect(call({ toolName: "Bash", input: { command: "npm test" } })).toBe("💻 npm test");
    expect(call({ toolName: "Read", input: { file_path: "/a/b/app.ts" } })).toBe("📄 Read app.ts");
    expect(call({ toolName: "WebSearch", input: { query: "acp spec" } })).toBe("🔎 searching acp spec");
    expect(call({ toolName: "Task", input: { description: "review the diff" } })).toBe("🤖 review the diff");
    expect(call({ toolName: "Skill", input: { skill: "review-pr" } })).toBe("🔧 Skill review-pr");
    expect(call({ toolName: "mcp__slack__slack_upload_file" })).toBe("🔧 slack:slack_upload_file");
  });
  it("falls back to ACP kind + title for other agents, clipped", () => {
    expect(call({ kind_: "execute", title: "Terminal" })).toBe("💻 Terminal");
    expect(call({ kind_: "read", title: "Read " + "x".repeat(200) })).toMatch(/^📄 Read x+…$/);
    expect(call({ title: "" })).toBe("🔧 tool");
  });
});
