import { describe, it, expect } from "vitest";
import { SessionStore } from "../src/host/session-store.js";

describe("SessionStore", () => {
  it("round-trips rows and answers thread membership", () => {
    const s = new SessionStore(":memory:");
    expect(s.get("thread:C1:1.0")).toBeUndefined();
    expect(s.hasThread("C1", "1.0")).toBe(false);
    s.put({ key: "thread:C1:1.0", agent: "claude", sessionId: "sid", cwd: "/x", channel: "C1", threadTs: "1.0", createdAt: 1, lastUsedAt: 1 });
    expect(s.get("thread:C1:1.0")?.sessionId).toBe("sid");
    expect(s.hasThread("C1", "1.0")).toBe(true);
    s.put({ key: "thread:C1:1.0", agent: "claude", sessionId: "sid2", cwd: "/x", channel: "C1", threadTs: "1.0", createdAt: 1, lastUsedAt: 2 });
    expect(s.get("thread:C1:1.0")?.sessionId).toBe("sid2");
    expect(s.get("thread:C1:1.0")?.createdAt).toBe(1);
    expect(s.delete("thread:C1:1.0")).toBe(true);
    expect(s.delete("thread:C1:1.0")).toBe(false);
    s.close();
  });
});
