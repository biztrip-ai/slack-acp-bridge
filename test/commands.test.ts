import { describe, it, expect } from "vitest";
import { parseBangCommand } from "../src/slack/commands.js";

describe("parseBangCommand", () => {
  it("parses known commands with args", () => {
    expect(parseBangCommand("!agent codex")).toEqual({ name: "agent", args: "codex" });
    expect(parseBangCommand("  !STOP ")).toEqual({ name: "stop", args: "" });
    expect(parseBangCommand("!mode  acceptEdits")).toEqual({ name: "mode", args: "acceptEdits" });
  });
  it("ignores non-commands and unknown commands", () => {
    expect(parseBangCommand("hello !stop")).toBeUndefined();
    expect(parseBangCommand("!deploy now")).toBeUndefined();
    expect(parseBangCommand("! stop")).toBeUndefined();
  });
});
