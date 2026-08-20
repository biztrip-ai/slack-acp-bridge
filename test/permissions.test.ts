import { describe, it, expect } from "vitest";
import { PermissionPrompter, type PermissionChat } from "../src/slack/permissions.js";
import { createLogger } from "../src/logger.js";

function fakeChat() {
  const posts: { text: string; blocks?: unknown[] }[] = [];
  const updates: { ts: string; text: string }[] = [];
  const chat: PermissionChat = {
    chat: {
      postMessage: async (a) => {
        posts.push({ text: a.text, blocks: a.blocks });
        return { ts: `ts${posts.length}` };
      },
      update: async (a) => {
        updates.push({ ts: a.ts, text: a.text });
        return {};
      },
    },
  };
  return { chat, posts, updates };
}

const req = {
  sessionId: "s",
  toolCall: { toolCallId: "t1", title: "Run `rm -rf build`", rawInput: { command: "rm -rf build" } },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" as const },
    { optionId: "deny", name: "Deny", kind: "reject_once" as const },
  ],
};

async function tick() {
  await new Promise((r) => setImmediate(r));
}

describe("PermissionPrompter", () => {
  it("posts buttons and resolves from a click", async () => {
    const { chat, posts, updates } = fakeChat();
    const p = new PermissionPrompter(chat, createLogger("t"), 60_000);
    const pending = p.ask("C1", "1.0", req, new AbortController().signal);
    await tick();
    expect(posts).toHaveLength(1);
    const actions = (posts[0]!.blocks as { type: string; elements?: { value: string }[] }[]).find((b) => b.type === "actions")!;
    expect(actions.elements).toHaveLength(2);
    expect(p.resolve(actions.elements![1]!.value, "U1")).toBe(true);
    expect(await pending).toEqual({ optionId: "deny" });
    await tick();
    expect(updates[0]!.text).toContain("Deny");
    expect(updates[0]!.text).toContain("<@U1>");
    expect(p.resolve(actions.elements![0]!.value, "U1")).toBe(false); // already settled
  });

  it("cancels on abort (turn stopped) and on timeout", async () => {
    const { chat, updates } = fakeChat();
    const p = new PermissionPrompter(chat, createLogger("t"), 20);
    const ac = new AbortController();
    const a = p.ask("C1", "1.0", req, ac.signal);
    await tick();
    ac.abort();
    expect(await a).toEqual({ cancelled: true });
    await tick();
    expect(updates.at(-1)!.text).toContain("cancelled");

    const b = p.ask("C1", "1.0", req, new AbortController().signal);
    expect(await b).toEqual({ cancelled: true });
    await tick();
    expect(updates.at(-1)!.text).toContain("timed out");
    expect(p.pendingCount).toBe(0);
  });
});
