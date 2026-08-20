import path from "node:path";
import type { SessionNotification, StopReason } from "@agentclientprotocol/sdk";
import type { Logger } from "../logger.js";
import { isDebug, truncate } from "../logger.js";
import { AgentProcess } from "./agent-process.js";
import { AsyncQueue } from "./async-queue.js";
import { SessionStore } from "./session-store.js";
import type { AgentConfig, PermissionPolicy, TurnEvent } from "./types.js";

export interface HostConfig {
  agents: Record<string, AgentConfig>;
  defaultAgent: string;
  cwd: string;
  permissionMode?: string;
  systemPromptAppend?: string;
  claude?: { model?: string; settingSources?: string[]; chrome?: boolean };
  stateDir: string;
  idleTimeoutS: number; // 0 = no reaper
  reapIntervalS: number;
  permissionPolicy?: PermissionPolicy;
}

export interface ThreadRef {
  channel: string;
  threadTs: string | null;
}

/** One Slack thread ↔ one ACP session. Turns are serialized per session. */
export class Session {
  readonly key: string;
  readonly agent: AgentProcess;
  readonly sessionId: string;
  private readonly log: Logger;
  private turn = 0;
  private chain: Promise<void> = Promise.resolve();
  private active = 0;
  lastUsedAt = Date.now();
  /** Set when the agent reported this session can no longer take prompts. */
  dead = false;

  constructor(key: string, agent: AgentProcess, sessionId: string, log: Logger) {
    this.key = key;
    this.agent = agent;
    this.sessionId = sessionId;
    this.log = log;
  }

  get busy(): boolean {
    return this.active > 0;
  }

  get nextTurnNumber(): number {
    return this.turn + 1;
  }

  /**
   * Queue a prompt. Events start flowing once earlier turns on this session
   * finish; the first event is always `turn_start`.
   */
  send(text: string): AsyncIterable<TurnEvent> {
    const q = new AsyncQueue<TurnEvent>();
    this.active++;
    const run = async () => {
      this.lastUsedAt = Date.now();
      const turn = ++this.turn;
      this.log.info(`turn ${turn}: user prompt (${text.length} chars): ${JSON.stringify(truncate(text, 200))}`);
      if (isDebug()) this.log.debug(`turn ${turn}: full prompt:\n${text}`);
      q.push({ kind: "turn_start", turn });

      const sink = (n: SessionNotification) => {
        for (const ev of this.toEvents(n, turn)) q.push(ev);
      };
      this.agent.bindSink(this.sessionId, sink);
      try {
        const res = await this.agent.prompt({
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
        });
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

  constructor(cfg: HostConfig, log: Logger) {
    this.cfg = cfg;
    this.log = log.child("host");
    this.store = new SessionStore(path.join(cfg.stateDir, "sessions.db"));
  }

  agentNames(): string[] {
    return Object.keys(this.cfg.agents);
  }

  private agentFor(name: string): AgentProcess {
    let a = this.agents.get(name);
    if (!a) {
      const conf = this.cfg.agents[name];
      if (!conf) throw new Error(`unknown agent "${name}"`);
      a = new AgentProcess(conf, this.log, this.cfg.permissionPolicy);
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

  async getOrCreate(key: string, ref: ThreadRef, agentName = this.cfg.defaultAgent): Promise<Session> {
    const live = this.get(key);
    if (live) return live;
    let p = this.creating.get(key);
    if (!p) {
      p = this.create(key, ref, agentName).finally(() => this.creating.delete(key));
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

  private async create(key: string, ref: ThreadRef, agentName: string): Promise<Session> {
    const slog = this.log.child(`session[${key}]`);
    const row = this.store.get(key);
    if (row) agentName = row.agent in this.cfg.agents ? row.agent : agentName;
    const agent = this.agentFor(agentName);
    await agent.ensureStarted();

    const cwd = this.cfg.cwd;
    const mcpServers: never[] = [];
    let sessionId: string | undefined;
    let modes: { currentModeId: string; availableModes: { id: string }[] } | null | undefined;

    if (row && row.agent === agentName && agent.caps.loadSession) {
      slog.info(`loading prior session ${row.sessionId}`);
      // History replay arrives as session/update before load resolves; discard it.
      agent.bindSink(row.sessionId, () => {});
      try {
        const res = await agent.loadSession({ sessionId: row.sessionId, cwd, mcpServers, _meta: this.sessionMeta() });
        sessionId = row.sessionId;
        modes = (res as { modes?: typeof modes } | void)?.modes;
        slog.info("loaded");
      } catch (e) {
        slog.warn(`load failed; starting fresh`, e);
      } finally {
        agent.bindSink(row.sessionId, undefined);
      }
    }

    if (!sessionId) {
      slog.info("creating new session");
      const res = await agent.newSession({ cwd, mcpServers, _meta: this.sessionMeta() });
      sessionId = res.sessionId;
      modes = res.modes;
      slog.info(`created ${sessionId}`);
    }

    await this.applyMode(agent, sessionId, modes, slog);

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
    const s = new Session(key, agent, sessionId, slog);
    this.sessions.set(key, s);
    return s;
  }

  private async applyMode(
    agent: AgentProcess,
    sessionId: string,
    modes: { currentModeId: string; availableModes: { id: string }[] } | null | undefined,
    slog: Logger,
  ): Promise<void> {
    const want = this.cfg.permissionMode;
    if (!want || !modes) return;
    if (modes.currentModeId === want) return;
    if (!modes.availableModes.some((m) => m.id === want)) {
      slog.warn(`permission mode "${want}" not offered (available: ${modes.availableModes.map((m) => m.id).join(", ")}); keeping "${modes.currentModeId}"`);
      return;
    }
    try {
      await agent.setMode(sessionId, want);
      slog.info(`mode set to ${want}`);
    } catch (e) {
      slog.warn(`set_mode ${want} failed`, e);
    }
  }

  /** Forget a thread's session entirely (the /clear semantics). */
  async drop(key: string): Promise<DropResult> {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    const hadRow = this.store.delete(key);
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
