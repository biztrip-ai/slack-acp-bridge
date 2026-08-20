import { describe, it, expect } from "vitest";
import { AbstainBuffer } from "../src/slack/abstain.js";

describe("AbstainBuffer", () => {
  it("suppresses an exact sentinel, even when streamed in pieces", () => {
    const a = new AbstainBuffer("<<SILENT>>");
    expect(a.feed("<<SIL")).toBe("");
    expect(a.feed("ENT>>")).toBe("");
    expect(a.feed("\n")).toBe("");
    expect(a.finish()).toEqual({ abstained: true, tail: "" });
  });
  it("suppresses empty output", () => {
    expect(new AbstainBuffer("<<SILENT>>").finish()).toEqual({ abstained: true, tail: "" });
  });
  it("flushes buffered text once output diverges, then passes through", () => {
    const a = new AbstainBuffer("<<SILENT>>");
    expect(a.feed("<<S")).toBe("");
    expect(a.feed("ure thing")).toBe("<<Sure thing");
    expect(a.feed("!")).toBe("!");
    expect(a.finish()).toEqual({ abstained: false, tail: "" });
  });
  it("releases a partial sentinel at finish instead of dropping it", () => {
    const a = new AbstainBuffer("<<SILENT>>");
    expect(a.feed("<<SI")).toBe("");
    expect(a.finish()).toEqual({ abstained: false, tail: "<<SI" });
  });
});
