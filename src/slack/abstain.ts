/**
 * Buffers streamed text until it is clear whether the agent is abstaining.
 * If the whole output equals the sentinel (or is empty), nothing is posted.
 * Same idea as kfet/slack-acp's abstainSink.
 */
export class AbstainBuffer {
  private buf = "";
  private committed = false;

  constructor(private readonly sentinel: string) {}

  /** Returns text that may be posted now ("" while still undecided). */
  feed(text: string): string {
    if (this.committed) return text;
    this.buf += text;
    const t = this.buf.trim();
    if (t === this.sentinel) return "";
    if (t.length < this.sentinel.length && this.sentinel.startsWith(t)) return "";
    this.committed = true;
    const out = this.buf;
    this.buf = "";
    return out;
  }

  /** Call after the turn ends. `tail` is text still held back that must be posted. */
  finish(): { abstained: boolean; tail: string } {
    if (this.committed) return { abstained: false, tail: "" };
    const t = this.buf.trim();
    if (t === "" || t === this.sentinel) return { abstained: true, tail: "" };
    this.committed = true;
    const tail = this.buf;
    this.buf = "";
    return { abstained: false, tail };
  }
}
