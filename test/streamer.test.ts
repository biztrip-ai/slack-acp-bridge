import { describe, it, expect } from "vitest";
import { SlackStreamer, MAX_MSG_CHARS, type ChatClient } from "../src/slack/streamer.js";
import { createLogger } from "../src/logger.js";

class FakeSlack implements ChatClient {
  posts: { channel: string; thread_ts?: string; text: string }[] = [];
  updates: { ts: string; text: string }[] = [];
  failNextUpdateWith?: string;
  private n = 0;
  chat = {
    postMessage: async (a: { channel: string; thread_ts?: string; text: string }) => {
      this.posts.push(a);
      return { ts: `ts${++this.n}` };
    },
    update: async (a: { channel: string; ts: string; text: string }) => {
      if (this.failNextUpdateWith) {
        const err = Object.assign(new Error("slack"), { data: { error: this.failNextUpdateWith } });
        this.failNextUpdateWith = undefined;
        throw err;
      }
      this.updates.push({ ts: a.ts, text: a.text });
      return {};
    },
  };
}

const log = createLogger("test");

describe("SlackStreamer", () => {
  it("posts a placeholder, throttles, and flushes on force", async () => {
    let t = 0;
    const slack = new FakeSlack();
    const s = new SlackStreamer(slack, "C1", "1.0", log, { now: () => t });
    await s.open();
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.thread_ts).toBe("1.0");

    await s.append("hi"); // below MIN_FLUSH_DELTA → no update
    expect(slack.updates).toHaveLength(0);
    await s.append("x".repeat(200)); // enough delta, and lastFlushAt=0 → flush
    expect(slack.updates).toHaveLength(1);
    await s.append("y".repeat(200)); // within 1s → throttled
    expect(slack.updates).toHaveLength(1);
    t = 1500;
    await s.append("z"); // delta ≥120 and 1.5s passed → flush
    expect(slack.updates).toHaveLength(2);
    await s.flush(true);
    expect(slack.updates.at(-1)!.text).toBe("hi" + "x".repeat(200) + "y".repeat(200) + "z");
  });

  it("rolls over to a new message past MAX_MSG_CHARS", async () => {
    const slack = new FakeSlack();
    const s = new SlackStreamer(slack, "C1", "1.0", log, { now: () => 0 });
    await s.open();
    await s.append("a".repeat(MAX_MSG_CHARS - 10));
    await s.append("b".repeat(50));
    expect(slack.posts).toHaveLength(2); // placeholder + rollover
    expect(s.messageTs).toBe("ts2");
    await s.flush(true);
    expect(slack.updates.at(-1)!).toEqual({ ts: "ts2", text: "b".repeat(50) });
  });

  it("recovers from msg_too_long by trimming and rolling over", async () => {
    const slack = new FakeSlack();
    const s = new SlackStreamer(slack, "C1", undefined, log, { now: () => 0 });
    await s.open();
    slack.failNextUpdateWith = "msg_too_long";
    await s.append("q".repeat(500)); // first flush fails with msg_too_long
    // trimmed update on old ts, then a rollover post; tail is empty here
    expect(slack.posts).toHaveLength(2);
    expect(slack.updates.at(-1)!.ts).toBe("ts1");
    expect(slack.updates.at(-1)!.text.endsWith(" …")).toBe(true);
  });

  it("queued placeholder is swapped by markActive only before text arrives", async () => {
    const slack = new FakeSlack();
    const s = new SlackStreamer(slack, "C1", "1.0", log, { queued: true, now: () => 0 });
    await s.open();
    expect(slack.posts[0]!.text).toContain("queued");
    await s.markActive();
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]!.text).not.toContain("queued");
  });
});
