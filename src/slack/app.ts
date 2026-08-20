import bolt from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { BridgeConfig } from "../config.js";
import type { AgentHost } from "../host/host.js";
import type { Logger } from "../logger.js";
import { SlackStreamer } from "./streamer.js";

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
}

export function sessionKey(ev: InboundMessage): string {
  if (ev.channel_type === "im") return `dm:${ev.channel}`;
  return `thread:${ev.channel}:${ev.thread_ts ?? ev.ts}`;
}

export function threadTsForReply(ev: InboundMessage): string | undefined {
  if (ev.channel_type === "im") return undefined; // DMs don't need threading
  return ev.thread_ts ?? ev.ts;
}

export class SlackBridge {
  private readonly app: InstanceType<typeof App>;
  private readonly log: Logger;
  private botUserId?: string;
  /** Threads we've confirmed the bot has posted in (per process; survives /clear). */
  private readonly botThreads = new Set<string>();

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
    this.register();
  }

  get client(): WebClient {
    return this.app.client;
  }

  private register(): void {
    this.app.event("app_mention", async ({ event, client }) => {
      await this.handleUserMessage(event as unknown as InboundMessage, client);
    });

    this.app.event("message", async ({ event, client }) => {
      const ev = event as unknown as InboundMessage;
      // Skip bot's own messages, edits, joins, etc.
      if (ev.bot_id || ev.subtype) return;
      const botId = await this.getBotUserId(client);

      // In channels: respond to any reply inside a thread the bot has
      // participated in. `app_mention` covers the opening message, so skip
      // messages that mention the bot here to avoid double-handling.
      if (ev.channel_type !== "im") {
        if (!ev.thread_ts) return;
        if ((ev.text ?? "").includes(`<@${botId}>`)) return;
        const key = sessionKey(ev);
        if (!this.host.get(key) && !(await this.botParticipatesInThread(client, ev.channel, ev.thread_ts, botId))) {
          return;
        }
      }
      await this.handleUserMessage(ev, client);
    });

    this.app.command("/clear", async ({ command, ack, client }) => {
      await ack();
      const channelId = command.channel_id;
      const threadTs = (command as unknown as { thread_ts?: string }).thread_ts;
      const userId = command.user_id;

      let key: string;
      let replyThread: string | undefined;
      if (channelId.startsWith("D")) {
        key = `dm:${channelId}`;
      } else if (threadTs) {
        key = `thread:${channelId}:${threadTs}`;
        replyThread = threadTs;
      } else {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "Run `/clear` inside a thread with me, or in our DM.",
        });
        return;
      }
      this.log.info(`/clear user=${userId} channel=${channelId} session=${key}`);
      const status = await this.host.drop(key);
      this.log.info(`/clear result session=${key} status=${status}`);
      const text = {
        cleared: "🧹 Session cleared.",
        deferred: "🧹 A turn is still running — I'll reset this thread's session as soon as it finishes.",
        absent: "_No active session here._",
      }[status];
      await client.chat.postMessage({ channel: channelId, thread_ts: replyThread, text });
    });

    this.app.error(async (err) => {
      this.log.error("bolt error", err);
    });
  }

  private async getBotUserId(client: WebClient): Promise<string> {
    if (!this.botUserId) {
      const auth = await client.auth.test();
      this.botUserId = auth.user_id as string;
    }
    return this.botUserId;
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

  private async handleUserMessage(ev: InboundMessage, client: WebClient): Promise<void> {
    const botId = await this.getBotUserId(client);
    const text = (ev.text ?? "").replaceAll(`<@${botId}>`, "").trim();
    if (!text) return;

    const channel = ev.channel;
    const user = ev.user ?? "?";
    const replyThread = threadTsForReply(ev);
    const key = sessionKey(ev);
    const isNew = !this.host.get(key);
    this.log.info(`incoming message channel=${channel} user=${user} session=${key} new=${isNew} len=${text.length}`);
    this.log.debug(`incoming text: ${text}`);

    // If a turn on this thread is already running, ours queues behind it
    // inside session.send(). Reflect that in the placeholder.
    const existing = this.host.get(key);
    const queued = !!existing?.busy;
    const streamer = new SlackStreamer(client, channel, replyThread, this.log, { queued });
    await streamer.open();
    if (replyThread) this.botThreads.add(`${channel}:${replyThread}`);

    try {
      const session = await this.host.getOrCreate(key, { channel, threadTs: replyThread ?? null });
      for await (const ev of session.send(text)) {
        if (ev.kind === "turn_start") await streamer.markActive();
        else if (ev.kind === "text") await streamer.append(ev.text);
      }
      await streamer.flush(true);
    } catch (e) {
      this.log.error(`session error on ${key}`, e);
      const msg = e instanceof Error ? e.message : String(e);
      await streamer.replaceWith(`:warning: error: \`${msg}\``);
    }
  }

  async start(): Promise<void> {
    await this.app.start();
    const id = await this.getBotUserId(this.app.client);
    this.log.info(`connected; bot user ${id}; waiting for events`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}
