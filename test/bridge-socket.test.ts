import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeSocketServer, callBridge } from "../src/mcp/bridge-socket.js";
import { createLogger } from "../src/logger.js";

describe("BridgeSocketServer", () => {
  it("round-trips requests and errors over the unix socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sab-sock-"));
    const srv = new BridgeSocketServer(dir, async (req) => {
      if (req.method === "post_message") return { ok: true, echoed: req.params.text, session: req.session };
      throw new Error(`nope: ${req.method}`);
    }, createLogger("t"));
    await srv.start();
    expect((fs.statSync(srv.socketPath).mode & 0o777).toString(8)).toBe("600");
    const r = await callBridge(srv.socketPath, "thread:C1:1.0", "post_message", { text: "hi" });
    expect(r).toEqual({ ok: true, echoed: "hi", session: "thread:C1:1.0" });
    await expect(callBridge(srv.socketPath, "s", "upload_file", {})).rejects.toThrow(/nope: upload_file/);
    await srv.stop();
    expect(fs.existsSync(srv.socketPath)).toBe(false);
  });
});
