import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttachFilter, uploadFiles } from "../src/slack/attach.js";
import { createLogger } from "../src/logger.js";

describe("AttachFilter", () => {
  it("strips ATTACH lines and collects paths, even when split across chunks", () => {
    const f = new AttachFilter();
    let out = "";
    out += f.feed("Here is the screenshot:\nATT");
    out += f.feed("ACH: /tmp/shot.png\nDone");
    out += f.feed(".\n  ATTACH:  ./report.pdf  ");
    out += f.finish();
    expect(out).toBe("Here is the screenshot:\nDone.\n");
    expect(f.paths).toEqual(["/tmp/shot.png", "./report.pdf"]);
  });
  it("passes ordinary text through without delay", () => {
    const f = new AttachFilter();
    expect(f.feed("hello")).toBe("hello");
    expect(f.feed(" world\nmore")).toBe(" world\nmore");
    expect(f.finish()).toBe("");
    expect(f.paths).toEqual([]);
  });
  it("holds back a possible ATTACH prefix until it resolves", () => {
    const f = new AttachFilter();
    expect(f.feed("ATTA")).toBe("");
    expect(f.feed("CKED the problem\n")).toBe("ATTACKED the problem\n");
  });
});

describe("uploadFiles", () => {
  it("uploads existing files and reports missing ones", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-up-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "hi");
    const calls: Record<string, unknown>[] = [];
    const client = { filesUploadV2: async (a: Record<string, unknown>) => void calls.push(a) };
    const problems = await uploadFiles(client, "C1", "1.0", ["a.txt", "/nope/missing.png"], dir, createLogger("t"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ channel_id: "C1", thread_ts: "1.0", filename: "a.txt" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing.png");
  });
});
