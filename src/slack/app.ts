import path from "node:path";
import { fileURLToPath } from "node:url";
import bolt from "@slack/bolt";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { WebClient } from "@slack/web-api";
import type { BridgeConfig } from "../config.js";
import type { AgentHost, Session, ThreadRef } from "../host/host.js";
import type { PromptBlock } from "../host/types.js";
import type { Logger } from "../logger.js";
import { BridgeSocketServer, type BridgeRequest } from "../mcp/bridge-socket.js";
import { AbstainBuffer } from "./abstain.js";
import { AttachFilter, uploadFiles } from "./attach.js";
import { HELP_TEXT, parseBangCommand, type CommandName } from "./commands.js";
import { attachmentsToBlocks, type SlackFile } from "./files.js";
import { PERMISSION_ACTION_PREFIX, PermissionPrompter } from "./permissions.js";
import { SlackStreamer } from "./streamer.js";
import { toolLabel } from "./tool-label.js";

const { App, LogLevel } = bolt;

interface InboundMessage {
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
}

/** Message subtypes that still carry a user message we should act on. */
const ALLOWED_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);

export function sessionKey(ev: InboundMessage): string {
  if (ev.channel_type === "im") return `dm:${ev.channel}`;
  return `thread:${ev.channel}:${ev.thread_ts ?? ev.ts}`;
}

export function threadTsForReply(ev: InboundMessage): string | undefined {
  if (ev.channel_type === "im") return undefined; // DMs don't need threading
  return ev.thread_ts ?? ev.ts;
}

interface CommandCtx {
  key: string;
  ref: ThreadRef;
  channel: string;
  replyThread?: string;
  userId: string;
}

export class SlackBridge {
  private readonly app: InstanceType<typeof App>;
  private readonly log: Logger;
  private readonly prompter: PermissionPrompter;
  private readonly socket?: BridgeSocketServer;
  private botUserId?: string;
  /** Threads we've confirmed the bot has posted in (per process; survives /clear). */
  private readonly botThreads = new Set<string>();
  private readonly userNames = new Map<string, string>();

  constructor(
    private readonly cfg: BridgeConfig,
    private readonly host: AgentHost,
    log: Logger,
  ) {
    this.log = log.child("slack");
    this.app = new App({
      token: cfg.slackBotToken,
      appToken: cfg.slackAppToken,
      socketMode: true,
      logLevel: cfg.logLevel.toLowerCase() === "debug" ? LogLevel.DEBUG : LogLevel.WARN,
      clientOptions: cfg.slackApiUrl ? { slackApiUrl: cfg.slackApiUrl } : undefined,
    });
    this.prompter = new PermissionPrompter(this.app.client, this.log, cfg.permissionTimeoutS * 1000);
    host.onPermission((session, req, signal) =>
      this.prompter.ask(session.ref.channel, session.ref.threadTs ?? undefined, req, signal),
    );
    if (cfg.slackMcp) {
      this.socket = new BridgeSocketServer(cfg.stateDir, (req) => this.handleBridgeRequest(req), this.log);
      host.setMcpServers((key) => this.mcpServersFor(key));
    }
    this.register();
  }

  /** The per-session Slack MCP server spec handed to the agent via ACP. */
  private mcpServersFor(key: string): McpServer[] {
    if (!this.socket) return [];
    const serverJs = fileURLToPath(new URL("../mcp/server.js", import.meta.url));
    return [
      {
        name: "slack",
        command: process.execPath,
        args: [serverJs],
        env: [
          { name: "SLACK_ACP_BRIDGE_SOCK", value: this.socket.socketPath },
          { name: "SLACK_ACP_BRIDGE_SESSION", value: key },
        ],
      },
    ];
  }

  /** Requests from per-session MCP servers: act on that session's thread. */
  private async handleBridgeRequest(req: BridgeRequest): Promise<unknown> {
    const session = this.host.get(req.session);
    if (!session) throw new Error(`unknown session ${req.session}`);
    const { channel, threadTs } = session.ref;
    switch (req.method) {
      case "upload_file": {
        const p = String(req.params.path ?? "");
        if (!p) throw new Error("path is required");
        const problems = await uploadFiles(this.app.client, channel, threadTs ?? undefined, [p], this.cfg.cwd, this.log, {
          title: req.params.title ? String(req.params.title) : undefined,
          comment: req.params.comment ? String(req.params.comment) : undefined,
        });
        return problems.length ? { ok: false, error: problems[0] } : { ok: true };
      }
      case "post_message": {
        const text = String(req.params.text ?? "").trim();
        if (!text) throw new Error("text is required");
        const r = await this.app.client.chat.postMessage({ channel, thread_ts: threadTs ?? undefined, text });
        return { ok: true, ts: r.ts };
      }
      default:
        throw new Error(`unknown method ${String(req.method)}`);
    }
  }

  get client(): WebClient {
    return this.app.client;
  }

  private register(): void {
    this.app.event("app_mention", async ({ event, client }) => {
      await this.handleUserMessage(event as unknown as InboundMessage, client, true);
    });

    this.app.event("message", async ({ event, client }) => {
      const ev = event as unknown as InboundMessage;
      // Skip bot's own messages, edits, joins, etc.
      if (ev.bot_id || !ALLOWED_SUBTYPES.has(ev.subtype)) return;
      const botId = await this.getBotUserId(client);
      const mentioned = (ev.text ?? "").includes(`<@${botId}>`);

      // In channels: respond to any reply inside a thread the bot has
      // participated in. `app_mention` covers mentions, so skip those here.
      if (ev.channel_type !== "im") {
        if (!ev.thread_ts) return;
        if (mentioned) return;
        const key = sessionKey(ev);
        if (!this.host.get(key) && !(await this.botParticipatesInThread(client, ev.channel, ev.thread_ts, botId))) {
          return;
        }
      }
      await this.handleUserMessage(ev, client, mentioned);
    });

    for (const name of ["clear", "stop", "agent", "mode", "help"] as const) {
      this.app.command(`/${name}`, async ({ command, ack, client }) => {
        await ack();
        const channel = command.channel_id;
        const threadTs = (command as unknown as { thread_ts?: string }).thread_ts;
        let ctx: CommandCtx;
        if (channel.startsWith("D")) {
          ctx = { key: `dm:${channel}`, ref: { channel, threadTs: null }, channel, userId: command.user_id };
        } else if (threadTs) {
          ctx = { key: `thread:${channel}:${threadTs}`, ref: { channel, threadTs }, channel, replyThread: threadTs, userId: command.user_id };
        } else {
          await client.chat.postEphemeral({ channel, user: command.user_id, text: `Run \`/${name}\` inside a thread with me, or in our DM.` });
          return;
        }
        const text = await this.runCommand(name, command.text ?? "", ctx);
        await client.chat.postMessage({ channel, thread_ts: ctx.replyThread, text });
      });
    }

    this.app.action({ action_id: new RegExp(`^${PERMISSION_ACTION_PREFIX}`) }, async ({ ack, body }) => {
      await ack();
      const b = body as { actions?: { value?: string }[]; user?: { id?: string } };
      const value = b.actions?.[0]?.value;
      if (!value || !this.prompter.resolve(value, b.user?.id)) {
        this.log.debug("stale or unknown permission action", value);
      }
    });

    this.app.error(async (err) => {
      this.log.error("bolt error", err);
    });
  }

  private async runCommand(name: CommandName, rawArgs: string, ctx: CommandCtx): Promise<string> {
    // Only the first token is meaningful for every command that takes one.
    const args = rawArgs.trim().split(/\s+/)[0] ?? "";
    this.log.info(`!${name} ${args} user=${ctx.userId} session=${ctx.key}`);
    switch (name) {
      case "help":
        return HELP_TEXT;
      case "clear": {
        const status = await this.host.drop(ctx.key);
        this.log.info(`clear result session=${ctx.key} status=${status}`);
        return {
          cleared: "🧹 Session cleared.",
          deferred: "🧹 A turn is still running — I'll reset this thread's session as soon as it finishes.",
          absent: "_No active session here._",
        }[status];
      }
      case "stop": {
        const did = await this.host.cancel(ctx.key);
        return did ? "⏹ Stopping…" : "_Nothing is running in this thread._";
      }
      case "agent": {
        const names = this.host.agentNames();
        if (!args) {
          const cur = this.host.get(ctx.key)?.agentName ?? this.host.agentNameFor(ctx.key, ctx.channel);
          return `Agent for this thread: *${cur}*\nAvailable: ${names.map((n) => `\`${n}\``).join(", ")}\nSwitch with \`!agent <name>\` (resets the session).`;
        }
        if (!names.includes(args)) return `Unknown agent \`${args}\`. Available: ${names.map((n) => `\`${n}\``).join(", ")}`;
        const reset = await this.host.setAgent(ctx.key, args);
        return `🤖 Agent set to *${args}*${reset ? " — previous session dropped; the next message starts fresh." : "."}`;
      }
      case "mode": {
        if (!args) {
          const s = this.host.get(ctx.key);
          if (!s?.modes) return `No session yet. Default mode: \`${this.cfg.permissionMode}\`. Set with \`!mode <id>\`.`;
          return `Mode: *${s.modes.currentModeId}*\nAvailable: ${s.modes.availableModes.map((m) => `\`${m.id}\``).join(", ")}`;
        }
        try {
          const modes = await this.host.setMode(ctx.key, ctx.ref, args);
          return `🔐 Mode set to *${modes?.currentModeId ?? args}*.`;
        } catch (e) {
          return `:warning: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
  }

  private async getBotUserId(client: WebClient): Promise<string> {
    if (!this.botUserId) {
      const auth = await client.auth.test();
      this.botUserId = auth.user_id as string;
    }
    return this.botUserId;
  }

  private async userName(client: WebClient, userId: string): Promise<string> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    let name = userId;
    try {
      const r = await client.users.info({ user: userId });
      name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || userId;
    } catch (e) {
      this.log.debug(`users.info ${userId} failed`, e);
    }
    this.userNames.set(userId, name);
    return name;
  }

  /**
   * True iff the bot has at least one message in this thread. Positive results
   * are cached; we also trust the host's persistent map (threads we held a
   * session for before a restart) so reconnects don't cost an API call.
   */
  private async botParticipatesInThread(client: WebClient, channel: string, threadTs: string, botId: string): Promise<boolean> {
    const cacheKey = `${channel}:${threadTs}`;
    if (this.botThreads.has(cacheKey)) return true;
    if (this.host.knownThread(channel, threadTs)) {
      this.botThreads.add(cacheKey);
      return true;
    }
    try {
      const resp = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
      for (const m of resp.messages ?? []) {
        if (m.user === botId) {
          this.botThreads.add(cacheKey);
          return true;
        }
      }
      return false;
    } catch (e) {
      this.log.warn(`conversations.replies failed for ${channel}/${threadTs}`, e);
      return false;
    }
  }

  private async handleUserMessage(ev: InboundMessage, client: WebClient, addressed: boolean): Promise<void> {
    const botId = await this.getBotUserId(client);
    const text = (ev.text ?? "").replaceAll(`<@${botId}>`, "").trim();
    const files = ev.files ?? [];
    if (!text && files.length === 0) return;

    const channel = ev.channel;
    const user = ev.user ?? "?";
    const replyThread = threadTsForReply(ev);
    const key = sessionKey(ev);
    const ref: ThreadRef = { channel, threadTs: replyThread ?? null };
    const isDm = ev.channel_type === "im";

    const cmd = parseBangCommand(text);
    if (cmd) {
      const reply = await this.runCommand(cmd.name, cmd.args, { key, ref, channel, replyThread, userId: user });
      await client.chat.postMessage({ channel, thread_ts: replyThread, text: reply });
      return;
    }

    const isNew = !this.host.get(key);
    this.log.info(`incoming message channel=${channel} user=${user} session=${key} new=${isNew} len=${text.length} files=${files.length} addressed=${addressed}`);
    this.log.debug(`incoming text: ${text}`);

    // Ambient: an un-addressed reply in a shared thread may be ignored by the
    // agent, so don't post a placeholder — create the message on first text.
    const ambient = this.cfg.ambient && !isDm && !addressed;
    const existing = this.host.get(key);
    const streamer = new SlackStreamer(client, channel, replyThread, this.log, { queued: !!existing?.busy, lazy: ambient });
    await streamer.open();
    if (replyThread) this.botThreads.add(`${channel}:${replyThread}`);

    try {
      const session = await this.host.getOrCreate(key, ref);
      const prompt = await this.buildPrompt(client, session, ev, text, user, isDm);
      const abstain = ambient ? new AbstainBuffer(this.cfg.silentSentinel) : undefined;
      const attach = this.cfg.attachMarker ? new AttachFilter() : undefined;
      const pipe = (t: string) => {
        if (attach) t = attach.feed(t);
        if (abstain) t = abstain.feed(t);
        return t;
      };
      let stop = "end_turn";
      const labels = new Map<string, string>(); // tool call id → label (titles can arrive in updates)
      for await (const e of session.send(prompt)) {
        if (e.kind === "turn_start") await streamer.markActive();
        else if (e.kind === "text") await streamer.append(pipe(e.text));
        else if (e.kind === "tool_call") {
          const label = toolLabel(e);
          labels.set(e.id, label);
          await streamer.setStatus(label);
        } else if (e.kind === "tool_update" && e.title && labels.has(e.id)) {
          // The agent refined the title (e.g. the actual command) after the call started.
          const label = toolLabel({ kind: "tool_call", id: e.id, title: e.title });
          if (label !== labels.get(e.id)) {
            labels.set(e.id, label);
            await streamer.setStatus(label);
          }
        } else if (e.kind === "done") stop = e.stopReason;
      }
      streamer.clearStatus(); // the turn is over; the final flush renders text only
      if (attach) await streamer.append(abstain ? abstain.feed(attach.finish()) : attach.finish());
      if (abstain) {
        const { abstained, tail } = abstain.finish();
        if (abstained) {
          this.log.info(`session ${key}: agent abstained`);
          return;
        }
        await streamer.append(tail);
      }
      if (stop === "cancelled") await streamer.append("\n_(stopped)_");
      else if (stop !== "end_turn") await streamer.append(`\n_(stopped: ${stop})_`);
      await streamer.flush(true);
      if (attach?.paths.length) {
        const problems = await uploadFiles(client, channel, replyThread, attach.paths, this.cfg.cwd, this.log);
        if (problems.length) {
          await client.chat.postMessage({ channel, thread_ts: replyThread, text: `:warning: could not attach: ${problems.join("; ")}` });
        }
      }
    } catch (e) {
      this.log.error(`session error on ${key}`, e);
      const msg = e instanceof Error ? e.message : String(e);
      await streamer.replaceWith(`:warning: error: \`${msg}\``);
    }
  }

  private async buildPrompt(client: WebClient, session: Session, ev: InboundMessage, text: string, user: string, isDm: boolean): Promise<PromptBlock[]> {
    let body = text;
    if (this.cfg.ambient && !isDm) body = `[${await this.userName(client, user)}] ${text}`;
    const blocks: PromptBlock[] = [];
    const files = ev.files ?? [];
    if (files.length) {
      const { blocks: fileBlocks, notes } = await attachmentsToBlocks(files, {
        token: this.cfg.slackBotToken,
        uploadDir: path.join(this.cfg.stateDir, "uploads", ev.channel, ev.ts),
        allowImages: session.agent.caps.image,
        log: this.log,
      });
      if (notes.length) body = [body, ...notes].filter(Boolean).join("\n");
      blocks.push(...fileBlocks);
    }
    return [{ type: "text", text: body || "(see attached)" }, ...blocks];
  }

  async start(): Promise<void> {
    await this.socket?.start();
    await this.app.start();
    const id = await this.getBotUserId(this.app.client);
    this.log.info(`connected; bot user ${id}; waiting for events` + (this.cfg.ambient ? " (ambient mode)" : ""));
  }

  async stop(): Promise<void> {
    await this.app.stop();
    await this.socket?.stop();
  }
}
