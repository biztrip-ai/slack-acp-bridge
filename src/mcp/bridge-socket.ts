import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "../logger.js";

/**
 * Tiny line-delimited JSON-RPC server on a unix socket. The per-session Slack
 * MCP server (spawned by the agent) connects here and asks the bridge to act
 * on its thread, so the agent process never holds Slack credentials.
 */
export interface BridgeRequest {
  id: number;
  session: string; // thread key
  method: "upload_file" | "post_message";
  params: Record<string, unknown>;
}

export type BridgeHandler = (req: BridgeRequest) => Promise<unknown>;

export class BridgeSocketServer {
  private server?: net.Server;
  readonly socketPath: string;

  constructor(stateDir: string, private readonly handler: BridgeHandler, private readonly log: Logger) {
    this.socketPath = path.join(stateDir, "bridge.sock");
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* no stale socket */
    }
    this.server = net.createServer((conn) => {
      const rl = readline.createInterface({ input: conn });
      rl.on("line", async (line) => {
        let req: BridgeRequest | undefined;
        try {
          req = JSON.parse(line) as BridgeRequest;
          const result = await this.handler(req);
          conn.write(JSON.stringify({ id: req.id, result }) + "\n");
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          conn.write(JSON.stringify({ id: req?.id ?? null, error: message }) + "\n");
        }
      });
      conn.on("error", (e) => this.log.debug("bridge socket conn error", e));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.log.info(`bridge socket listening at ${this.socketPath}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* ignore */
    }
  }
}

/** Client side used by the MCP server process. One request per call; simple and robust. */
export function callBridge(socketPath: string, session: string, method: BridgeRequest["method"], params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    const rl = readline.createInterface({ input: conn });
    const id = Date.now();
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("bridge did not answer within 60s"));
    }, 60_000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      conn.end();
      try {
        const res = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        if (res.error) reject(new Error(res.error));
        else resolve(res.result);
      } catch (e) {
        reject(e);
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    conn.write(JSON.stringify({ id, session, method, params } satisfies BridgeRequest) + "\n");
  });
}
