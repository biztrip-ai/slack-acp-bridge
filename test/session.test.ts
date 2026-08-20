import { describe, it, expect } from "vitest";
import { Session } from "../src/host/host.js";
import type { AgentProcess, UpdateSink } from "../src/host/agent-process.js";
import { createLogger } from "../src/logger.js";

/** Fake agent: echoes the prompt back as two chunks, resolving in order of a gate. */
function fakeAgent() {
  let sink: UpdateSink | undefined;
  const gates: Array<() => void> = [];
  const agent = {
    bindSink: (_id: string, s: UpdateSink | undefined) => {
      sink = s;
    },
    prompt: async (p: { sessionId: string; prompt: { type: string; text: string }[] }) => {
      await new Promise<void>((r) => gates.push(r));
      const text = p.prompt[0]!.text;
      sink?.({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo:" } } });
      sink?.({ sessionId: p.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      return { stopReason: "end_turn" as const };
    },
  } as unknown as AgentProcess;
  const release = async () => {
    while (!gates.length) await new Promise((r) => setImmediate(r));
    gates.shift()!();
  };
  return { agent, release };
}

async function collect(it: AsyncIterable<{ kind: string; text?: string; turn?: number }>) {
  const out: string[] = [];
  for await (const ev of it) {
    if (ev.kind === "turn_start") out.push(`start:${ev.turn}`);
    else if (ev.kind === "text") out.push(ev.text!);
    else if (ev.kind === "done") out.push("done");
  }
  return out;
}

describe("Session", () => {
  it("serializes turns and emits turn_start only when the turn actually begins", async () => {
    const { agent, release } = fakeAgent();
    const s = new Session("k", agent, "sid", createLogger("t"));
    const a = collect(s.send("one"));
    const b = collect(s.send("two"));
    expect(s.busy).toBe(true);
    await release(); // finish turn 1
    expect(await a).toEqual(["start:1", "echo:", "one", "done"]);
    await release(); // finish turn 2
    expect(await b).toEqual(["start:2", "echo:", "two", "done"]);
    expect(s.busy).toBe(false);
  });
});
