import type { Logger } from "../logger.js";
import { randomPhrase } from "./phrases.js";

/**
 * Slack rejects chat.update with `msg_too_long` well below the documented
 * 40k-char limit (heavy mrkdwn pushes it down further). Cap each message at
 * this many chars and roll over to a new follow-up message when we hit it.
 */
export const MAX_MSG_CHARS = 2800;
/** chat.update is rate-limited at ~1/sec per message. */
export const MIN_UPDATE_INTERVAL_MS = 1000;
/** Don't bother flushing for fewer new chars than this unless forced. */
const MIN_FLUSH_DELTA = 120;

/** The subset of the Slack WebClient we use — keeps the streamer testable. */
export interface ChatClient {
  chat: {
    postMessage(args: { channel: string; thread_ts?: string; text: string }): Promise<{ ts?: string }>;
    update(args: { channel: string; ts: string; text: string }): Promise<unknown>;
  };
}

export interface StreamerOptions {
  queued?: boolean;
  /** Don't post a placeholder; the message is created on the first real text. */
  lazy?: boolean;
  now?: () => number;
}

function slackError(e: unknown): string | undefined {
  return (e as { data?: { error?: string } })?.data?.error;
}

/**
 * Streams text into a thread, rolling over to a new message when the current
 * one is about to exceed Slack's `chat.update` length limit.
 */
export class SlackStreamer {
  private ts: string | undefined;
  private body = "";
  private lastFlushedLen = 0;
  private lastFlushAt = -Infinity;
  private placeholder: string;
  private readonly lazy: boolean;
  private readonly now: () => number;

  constructor(
    private readonly client: ChatClient,
    private readonly channel: string,
    private readonly threadTs: string | undefined,
    private readonly log: Logger,
    opts: StreamerOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.lazy = opts.lazy ?? false;
    // When another turn on this thread is still running, say so rather than
    // sitting on a frozen "thinking…" line. `markActive` swaps it later.
    this.placeholder = opts.queued
      ? "_⏳ queued — finishing an earlier request in this thread first…_"
      : `_${randomPhrase()}_`;
  }

  get messageTs(): string | undefined {
    return this.ts;
  }

  async open(): Promise<void> {
    if (this.lazy) return;
    const r = await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: this.placeholder,
    });
    this.ts = r.ts;
  }

  /** Turn just started: if still showing the queued placeholder, swap in a normal phrase. */
  async markActive(): Promise<void> {
    if (!this.ts || this.body) return;
    this.placeholder = `_${randomPhrase()}_`;
    try {
      await this.client.chat.update({ channel: this.channel, ts: this.ts, text: this.placeholder });
    } catch (e) {
      this.log.warn("chat.update (markActive) failed", e);
    }
  }

  async append(text: string): Promise<void> {
    if (!text) return;
    if (this.body.length + text.length > MAX_MSG_CHARS) {
      await this.flush(true);
      await this.rollOver();
    }
    this.body += text;
    await this.flush();
  }

  async flush(force = false): Promise<void> {
    if (!this.ts) {
      // Lazy mode: create the message with the first real text.
      if (!this.body.trim()) return;
      const r = await this.client.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: this.body });
      this.ts = r.ts;
      this.lastFlushedLen = this.body.length;
      this.lastFlushAt = this.now();
      return;
    }
    const now = this.now();
    const delta = this.body.length - this.lastFlushedLen;
    if (!force) {
      if (delta < MIN_FLUSH_DELTA) return;
      if (now - this.lastFlushAt < MIN_UPDATE_INTERVAL_MS) return;
    }
    if (delta === 0 && this.lastFlushedLen > 0) return;
    const rendered = this.body.trim() || this.placeholder;
    try {
      await this.client.chat.update({ channel: this.channel, ts: this.ts, text: rendered });
      this.lastFlushedLen = this.body.length;
      this.lastFlushAt = now;
    } catch (e) {
      const err = slackError(e);
      if (err === "msg_too_long") {
        // Body grew past Slack's actual limit between checks. Trim this
        // message, roll over, and re-stage the tail.
        this.log.warn(`msg_too_long at ${this.body.length} chars; rolling over`);
        const tail = this.body.slice(MAX_MSG_CHARS);
        const trimmed = this.body.slice(0, MAX_MSG_CHARS).trimEnd() + " …";
        try {
          await this.client.chat.update({ channel: this.channel, ts: this.ts, text: trimmed });
        } catch (e2) {
          this.log.warn("chat.update retry after trim failed", e2);
        }
        await this.rollOver();
        this.body = tail;
        this.lastFlushedLen = 0;
        this.lastFlushAt = this.now();
        if (tail.trim()) await this.flush(true);
      } else {
        this.log.warn(`chat.update failed (${err ?? "unknown"})`, e);
      }
    }
  }

  private async rollOver(): Promise<void> {
    const r = await this.client.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text: "…" });
    this.ts = r.ts;
    this.body = "";
    this.lastFlushedLen = 0;
    this.lastFlushAt = -Infinity;
  }

  /** Overwrite the current message — used for terminal error reporting. */
  async replaceWith(text: string): Promise<void> {
    try {
      if (!this.ts) {
        const r = await this.client.chat.postMessage({ channel: this.channel, thread_ts: this.threadTs, text });
        this.ts = r.ts;
        return;
      }
      await this.client.chat.update({ channel: this.channel, ts: this.ts, text });
    } catch (e) {
      this.log.warn("chat.update (replaceWith) failed", e);
    }
  }
}
