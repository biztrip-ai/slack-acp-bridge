import path from "node:path";
import type { SessionNotification, StopReason } from "@agentclientprotocol/sdk";
import type { Logger } from "../logger.js";
import { isDebug, truncate } from "../logger.js";
import { AgentProcess } from "./agent-process.js";
import { AsyncQueue } from "./async-queue.js";
import { SessionStore } from "./session-store.js";
import {
  allowAllPolicy,
  type AgentConfig,
  type ModeState,
  type PermissionDecision,
  type PermissionRequest,
  type PromptBlock,
  type TurnEvent,
} from "./types.js";

export interface HostConfig {
  agents: Record<string, AgentConfig>;
  defaultAgent: string;
  /** Per-channel default agent overrides (channel id → agent name). */
  channelAgents?: Record<string, string>;
  cwd: string;
  permissionMode?: string;
  systemPromptAppend?: string;
  claude?: { model?: string; settingSources?: string[]; chrome?: boolean };
  stateDir: string;
  idleTimeoutS: number; // 0 = no reaper
  reapIntervalS: number;
}

export interface ThreadRef {
  channel: string;
  threadTs: string | null;
}

/** Asked when an agent needs a permission decision for a live session. */
export type PermissionHandler = (
  session: Session,
  req: PermissionRequest,
  signal: AbortSignal,
) => Promise<PermissionDecision>;

/** One Slack thread ↔ one ACP session. Turns are serialized per session. */
export class Session {
  readonly key: string;
  readonly agentName: string;
  readonly agent: AgentProcess;
  readonly sessionId: string;
  readonly ref: ThreadRef;
  modes?: ModeState;
  private readonly log: Logger;
  private turn = 0;
  private chain: Promise<void> = Promise.resolve();
  private active = 0;
  private cancelEpoch = 0;
  lastUsedAt = Date.now();
  /** Set when the agent reported this session can no longer take prompts. */
  dead = false;

  constructor(key: string, agentName: string, agent: AgentProcess, sessionId: string, ref: ThreadRef, log: Logger) {
    this.key = key;
    this.agentName = agentName;
    this.agent = agent;
    this.sessionId = sessionId;
    this.ref = ref;
    this.log = log;
  }

  get busy(): boolean {
    return this.active > 0;
  }

  /**
   * Queue a prompt. Events start flowing once earlier turns on this session
   * finish; the first event is always `turn_start`.
   */
  send(prompt: string | PromptBlock[]): AsyncIterable<TurnEvent> {
    const blocks: PromptBlock[] = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
    const preview = blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
    const q = new AsyncQueue<TurnEvent>();
    const epoch = this.cancelEpoch;
    this.active++;
    const run = async () => {
      this.lastUsedAt = Date.now();
      const turn = ++this.turn;
      q.push({ kind: "turn_start", turn });
      if (this.cancelEpoch > epoch) {
        // A /stop arrived while this turn was queued: never send it.
        this.log.info(`turn ${turn}: dropped (cancelled while queued)`);
        q.push({ kind: "done", stopReason: "cancelled" });
        q.close();
        this.active--;
        return;
      }
      this.log.info(`turn ${turn}: user prompt (${preview.length} chars): ${JSON.stringify(truncate(preview, 200))}`);
      if (isDebug()) this.log.debug(`turn ${turn}: full prompt:\n${preview}`);

      const sink = (n: SessionNotification) => {
        for (const ev of this.toEvents(n, turn)) q.push(ev);
      };
      this.agent.bindSink(this.sessionId, sink);
      try {
        const res = await this.agent.prompt({ sessionId: this.sessionId, prompt: blocks });
        this.log.info(`turn ${turn}: stop=${res.stopReason}` + (res.usage ? ` usage=${JSON.stringify(res.usage)}` : ""));
        q.push({ kind: "done", stopReason: res.stopReason as StopReason, usage: res.usage ?? undefined });
        q.close();
      } catch (e) {
        this.log.error(`turn ${turn}: prompt failed`, e);
        this.dead = true;
        q.fail(e);
      } finally {
        this.agent.bindSink(this.sessionId, undefined);
        this.lastUsedAt = Date.now();
        this.active--;
      }
    };
    this.chain = this.chain.then(run, run);
    return q;
  }

  /** Cancel the in-flight turn and drop anything queued behind it. */
  async cancel(): Promise<boolean> {
    if (!this.busy) return false;
    this.cancelEpoch++;
    try {
      await this.agent.cancel(this.sessionId);
    } catch (e) {
      this.log.warn("cancel failed", e);
    }
    return true;
  }

  private *toEvents(n: SessionNotification, turn: number): Iterable<TurnEvent> {
    const u = n.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          this.log.debug(`turn ${turn}: text (${u.content.text.length} chars)`);
          yield { kind: "text", text: u.content.text };
        }
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") {
          this.log.debug(`turn ${turn}: thinking: ${truncate(u.content.text, 300)}`);
          yield { kind: "thought", text: u.content.text };
        }
        break;
      case "tool_call": {
        const meta = (u._meta as { claudeCode?: { toolName?: string } } | null)?.claudeCode;
        this.log.info(
          `turn ${turn}: tool_call ${meta?.toolName ?? u.kind ?? "?"} id=${u.toolCallId} ${truncate(u.title, 200)}` +
            (u.rawInput ? ` input=${truncate(JSON.stringify(u.rawInput), 400)}` : ""),
        );
        yield { kind: "tool_call", id: u.toolCallId, title: u.title, toolName: meta?.toolName, kind_: u.kind ?? undefined, input: u.rawInput };
        break;
      }
      case "tool_call_update": {
        const isError = u.status === "failed";
        const summary = u.content
          ?.map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
          .filter(Boolean)
          .join("\n");
        if (u.status === "completed" || u.status === "failed") {
          const line = `turn ${turn}: tool_result id=${u.toolCallId} status=${u.status}` +
            (summary ? ` (${summary.length} chars): ${JSON.stringify(truncate(summary, 200))}` : "");
          if (isError) this.log.warn(line);
          else this.log.info(line);
          if (isDebug() && summary) this.log.debug(`turn ${turn}: tool_result full:\n${summary}`);
        }
        yield { kind: "tool_update", id: u.toolCallId, status: u.status ?? undefined, title: u.title ?? undefined, isError, summary };
        break;
      }
      case "current_mode_update":
        if (this.modes) this.modes = { ...this.modes, currentModeId: u.currentModeId };
        this.log.info(`turn ${turn}: mode → ${u.currentModeId}`);
        break;
      case "usage_update":
        this.log.debug(`turn ${turn}: usage`, u);
        break;
      default:
        this.log.debug(`turn ${turn}: ${u.sessionUpdate}`);
    }
  }

  /** Wait for any in-flight turns to finish (used by /clear). */
  async idle(): Promise<void> {
    await this.chain.catch(() => {});
  }
}

export type DropResult = "absent" | "cleared" | "deferred";

/**
 * Owns agent processes and the thread→session map. Agent-agnostic; nothing in
 * here knows about Slack beyond the opaque session key + ThreadRef metadata.
 */
export class AgentHost {
  private readonly cfg: HostConfig;
  private readonly log: Logger;
  private readonly store: SessionStore;
  private readonly agents = new Map<string, AgentProcess>();
  private readonly sessions = new Map<string, Session>();
  private readonly creating = new Map<string, Promise<Session>>();
  private reaper?: NodeJS.Timeout;
  private permissionHandler?: PermissionHandler;

  constructor(cfg: HostConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child("host");
    this.store = new SessionStore(path.join(cfg.stateDir, "sessions.db"));
  }

  agentNames(): string[] {
    return Object.keys(this.cfg.agents);
  }

  /** Install the interactive permission handler (e.g. Slack buttons). */
  onPermission(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  private async routePermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const session = [...this.sessions.values()].find((s) => s.sessionId === req.sessionId);
    if (!session || !this.permissionHandler) return allowAllPolicy(req, signal);
    try {
      return await this.permissionHandler(session, req, signal);
    } catch (e) {
      this.log.warn(`permission handler failed for ${session.key}; cancelling`, e);
      return { cancelled: true };
    }
  }

  private agentFor(name: string): AgentProcess {
    let a = this.agents.get(name);
    if (!a) {
      const conf = this.cfg.agents[name];
      if (!conf) throw new Error(`unknown agent "${name}"`);
      a = new AgentProcess(conf, this.log, (req, signal) => this.routePermission(req, signal));
      a.onExit(() => {
        // In-memory sessions died with the process; rows stay so they can be loaded again.
        for (const [key, s] of this.sessions) {
          if (s.agent === a) {
            s.dead = true;
            this.sessions.delete(key);
          }
        }
      });
      this.agents.set(name, a);
    }
    return a;
  }

  /** Has this thread ever had a session (memory or disk)? */
  knownThread(channel: string, threadTs: string): boolean {
    return this.store.hasThread(channel, threadTs);
  }

  get(key: string): Session | undefined {
    const s = this.sessions.get(key);
    return s && !s.dead ? s : undefined;
  }

  /** Agent a new session for this thread would use. */
  agentNameFor(key: string, channel: string): string {
    return (
      this.store.getPrefs(key).agent ??
      this.cfg.channelAgents?.[channel] ??
      this.cfg.defaultAgent
    );
  }

  async getOrCreate(key: string, ref: ThreadRef): Promise<Session> {
    const live = this.get(key);
    if (live) return live;
    let p = this.creating.get(key);
    if (!p) {
      p = this.create(key, ref).finally(() => this.creating.delete(key));
      this.creating.set(key, p);
    }
    return p;
  }

  private sessionMeta(): Record<string, unknown> {
    const c = this.cfg.claude ?? {};
    const options: Record<string, unknown> = {};
    if (c.model) options.model = c.model;
    if (c.settingSources) options.settingSources = c.settingSources;
    if (c.chrome) options.extraArgs = { chrome: null };
    const meta: Record<string, unknown> = { claudeCode: { options } };
    if (this.cfg.systemPromptAppend) meta.systemPrompt = { append: this.cfg.systemPromptAppend };
    return meta;
  }

  private async create(key: string, ref: ThreadRef): Promise<Session> {
    const slog = this.log.child(`session[${key}]`);
    const prefs = this.store.getPrefs(key);
    const row = this.store.get(key);
    let agentName = this.agentNameFor(key, ref.channel);
    // A persisted session pins its agent unless the user explicitly changed it.
    if (row && !prefs.agent && row.agent in this.cfg.agents) agentName = row.agent;
    const agent = this.agentFor(agentName);
    await agent.ensureStarted();

    const cwd = this.cfg.cwd;
    const mcpServers: never[] = [];
    let sessionId: string | undefined;
    let modes: ModeState | null | undefined;

    if (row && row.agent === agentName && agent.caps.loadSession) {
      slog.info(`loading prior session ${row.sessionId}`);
      // History replay arrives as session/update before load resolves; discard it.
      agent.bindSink(row.sessionId, () => {});
      try {
        const res = await agent.loadSession({ sessionId: row.sessionId, cwd, mcpServers, _meta: this.sessionMeta() });
        sessionId = row.sessionId;
        modes = (res as { modes?: ModeState | null } | void)?.modes;
        slog.info("loaded");
      } catch (e) {
        slog.warn(`load failed; starting fresh`, e);
      } finally {
        agent.bindSink(row.sessionId, undefined);
      }
    }

    if (!sessionId) {
      slog.info(`creating new session (agent=${agentName})`);
      const res = await agent.newSession({ cwd, mcpServers, _meta: this.sessionMeta() });
      sessionId = res.sessionId;
      modes = res.modes as ModeState | null | undefined;
      slog.info(`created ${sessionId}`);
    }

    const s = new Session(key, agentName, agent, sessionId, ref, slog);
    s.modes = modes ?? undefined;
    await this.applyMode(s, prefs.mode ?? this.cfg.permissionMode);

    const now = Date.now();
    this.store.put({
      key,
      agent: agentName,
      sessionId,
      cwd,
      channel: ref.channel,
      threadTs: ref.threadTs,
      createdAt: row?.createdAt ?? now,
      lastUsedAt: now,
    });
    this.sessions.set(key, s);
    return s;
  }

  private async applyMode(s: Session, want: string | undefined): Promise<string | undefined> {
    const modes = s.modes;
    if (!want || !modes) return undefined;
    if (modes.currentModeId === want) return want;
    if (!modes.availableModes.some((m) => m.id === want)) {
      const msg = `mode "${want}" not offered (available: ${modes.availableModes.map((m) => m.id).join(", ")}); keeping "${modes.currentModeId}"`;
      this.log.warn(`${s.key}: ${msg}`);
      throw new Error(msg);
    }
    await s.agent.setMode(s.sessionId, want);
    s.modes = { ...modes, currentModeId: want };
    this.log.info(`${s.key}: mode set to ${want}`);
    return want;
  }

  /** Set (and remember) the permission mode for a thread. Returns the resulting mode state. */
  async setMode(key: string, ref: ThreadRef, modeId: string): Promise<ModeState | undefined> {
    const s = await this.getOrCreate(key, ref);
    await this.applyMode(s, modeId);
    this.store.setPrefs(key, { mode: modeId });
    return s.modes;
  }

  /** Switch a thread's agent. Any existing session is dropped; returns true if one was. */
  async setAgent(key: string, name: string): Promise<boolean> {
    if (!this.cfg.agents[name]) throw new Error(`unknown agent "${name}" (known: ${this.agentNames().join(", ")})`);
    this.store.setPrefs(key, { agent: name });
    const had = !!this.sessions.get(key) || !!this.store.get(key);
    if (had) await this.drop(key, { keepPrefs: true });
    return had;
  }

  /** Cancel the running turn on a thread (and anything queued behind it). */
  async cancel(key: string): Promise<boolean> {
    const s = this.get(key);
    return s ? s.cancel() : false;
  }

  /** Forget a thread's session entirely (the /clear semantics). */
  async drop(key: string, opts: { keepPrefs?: boolean } = {}): Promise<DropResult> {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    const hadRow = this.store.delete(key);
    if (!opts.keepPrefs) this.store.setPrefs(key, {});
    if (!s) return hadRow ? "cleared" : "absent";
    if (s.busy) {
      void s.idle().then(() => this.closeQuietly(s));
      return "deferred";
    }
    await this.closeQuietly(s);
    return "cleared";
  }

  private async closeQuietly(s: Session): Promise<void> {
    try {
      if (s.agent.alive && !s.dead) await s.agent.closeSession(s.sessionId);
    } catch (e) {
      this.log.debug(`close ${s.key} failed`, e);
    }
  }

  startReaper(): void {
    if (this.cfg.idleTimeoutS <= 0 || this.reaper) return;
    this.log.info(`session reaper: idle_timeout=${this.cfg.idleTimeoutS}s interval=${this.cfg.reapIntervalS}s`);
    this.reaper = setInterval(() => void this.reapIdle(), this.cfg.reapIntervalS * 1000);
    this.reaper.unref();
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.cfg.idleTimeoutS * 1000;
    for (const [key, s] of [...this.sessions]) {
      if (s.busy || s.lastUsedAt > cutoff) continue;
      // Drop the in-memory binding and the agent-side session (frees the
      // subprocess). The store row stays so the next message re-loads it.
      this.sessions.delete(key);
      await this.closeQuietly(s);
      this.log.info(`reaped idle session ${key} idle=${Math.round((Date.now() - s.lastUsedAt) / 1000)}s`);
    }
  }

  async close(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.sessions.clear();
    await Promise.all([...this.agents.values()].map((a) => a.stop()));
    this.store.close();
  }
}
