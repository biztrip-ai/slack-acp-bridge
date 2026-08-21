import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client as acpClient,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Logger } from "../logger.js";
import { truncate } from "../logger.js";
import { allowAllPolicy, type AgentConfig, type PermissionPolicy } from "./types.js";

export type UpdateSink = (n: SessionNotification) => void;

export interface AgentCaps {
  loadSession: boolean;
  image: boolean;
  agentName?: string;
  agentVersion?: string;
  /** Raw initialize response for capability checks on `_meta` extensions. */
  raw: InitializeResponse;
}

/**
 * One long-lived ACP agent subprocess speaking JSON-RPC over stdio.
 * Multiplexes many sessions; routes `session/update` to a per-session sink.
 */
export class AgentProcess {
  readonly config: AgentConfig;
  private readonly log: Logger;
  private readonly policy: PermissionPolicy;
  private child?: ChildProcess;
  private conn?: ClientConnection;
  private capsValue?: AgentCaps;
  private sinks = new Map<string, UpdateSink>();
  private exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private starting?: Promise<void>;
  private stopping = false;

  constructor(config: AgentConfig, log: Logger, policy: PermissionPolicy = allowAllPolicy) {
    this.config = config;
    this.log = log.child(`agent[${config.name}]`);
    this.policy = policy;
  }

  get alive(): boolean {
    return !!this.conn && !this.conn.signal.aborted && !!this.child && this.child.exitCode === null;
  }

  get caps(): AgentCaps {
    if (!this.capsValue) throw new Error("agent not initialized");
    return this.capsValue;
  }

  onExit(fn: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.push(fn);
  }

  /** Spawn + initialize if not already running. Safe to call concurrently. */
  ensureStarted(): Promise<void> {
    if (this.alive) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    const { command, args = [], env } = this.config;
    this.log.info("spawning", command, args.join(" "));
    // Own process group: some agents are launched through a shim (e.g. the
    // codex-acp npm wrapper) whose native child would otherwise outlive it and
    // keep our pipes open. stop() kills the whole group.
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.sinks.clear();

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      for (const line of d.split("\n")) if (line.trim()) this.log.debug("stderr:", line);
    });
    child.stdin?.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") this.log.warn("stdin error", e);
    });
    child.on("exit", (code, signal) => {
      (this.stopping ? this.log.info : this.log.warn).call(this.log, `agent exited code=${code} signal=${signal}`);
      this.conn?.close(new Error(`agent exited (code=${code}, signal=${signal})`));
      this.conn = undefined;
      this.capsValue = undefined;
      this.sinks.clear();
      for (const h of this.exitHandlers) h(code, signal);
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );

    const conn = acpClient({ name: "slack-acp-bridge" })
      .onNotification(methods.client.session.update, (ctx) => {
        const n = ctx.params;
        const sink = this.sinks.get(n.sessionId);
        if (sink) sink(n);
        else this.log.debug(`update for idle session ${n.sessionId}: ${n.update.sessionUpdate}`);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const req = ctx.params;
        const decision = await this.policy(
          { sessionId: req.sessionId, toolCall: req.toolCall, options: req.options },
          ctx.signal,
        );
        const title = req.toolCall.title ?? "(tool)";
        if ("cancelled" in decision) {
          this.log.info(`permission cancelled: ${title}`);
          return { outcome: { outcome: "cancelled" as const } };
        }
        this.log.info(`permission ${decision.optionId}: ${truncate(title, 120)}`);
        return { outcome: { outcome: "selected" as const, optionId: decision.optionId } };
      })
      .onRequest(methods.client.fs.readTextFile, () => {
        throw new Error("fs/read_text_file not supported by this client");
      })
      .onRequest(methods.client.fs.writeTextFile, () => {
        throw new Error("fs/write_text_file not supported by this client");
      })
      .connect(stream);
    this.conn = conn;

    const init = await conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "slack-acp-bridge", version: "0.1.0" },
    });
    this.capsValue = {
      loadSession: init.agentCapabilities?.loadSession === true,
      image: init.agentCapabilities?.promptCapabilities?.image === true,
      agentName: init.agentInfo?.name,
      agentVersion: init.agentInfo?.version,
      raw: init,
    };
    this.log.info(
      `initialized ${init.agentInfo?.name ?? "agent"} ${init.agentInfo?.version ?? ""} ` +
        `loadSession=${this.capsValue.loadSession} image=${this.capsValue.image}`,
    );
  }

  private agent() {
    if (!this.conn || this.conn.signal.aborted) throw new Error("agent connection is closed");
    return this.conn.agent;
  }

  bindSink(sessionId: string, sink: UpdateSink | undefined): void {
    if (sink) this.sinks.set(sessionId, sink);
    else this.sinks.delete(sessionId);
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.agent().request(methods.agent.session.new, params);
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse | void> {
    return this.agent().request(methods.agent.session.load, params);
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.agent().request(methods.agent.session.prompt, params);
  }

  cancel(sessionId: string): Promise<void> {
    return this.agent().notify(methods.agent.session.cancel, { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.agent().request(methods.agent.session.setMode, { sessionId, modeId });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sinks.delete(sessionId);
    await this.agent().request(methods.agent.session.close, { sessionId });
  }

  /** Terminate the subprocess. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => signalGroup("SIGTERM"), 2000);
    const k = setTimeout(() => signalGroup("SIGKILL"), 6000);
    await exited;
    clearTimeout(t);
    clearTimeout(k);
    // Make sure nothing in the group survives and release our pipe ends so the
    // event loop can drain even if a grandchild lingered.
    signalGroup("SIGKILL");
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  }
}
