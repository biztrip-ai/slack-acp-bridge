import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

/**
 * `ATTACH: <path>` lines in the agent's reply mean "upload this file to the
 * thread". Works with any agent (no MCP needed). The filter removes those lines
 * from the streamed text and collects the paths; the bridge uploads them when
 * the turn ends. Same protocol as Bizzybot.
 */
export const ATTACH_RE = /^[ \t]*ATTACH:[ \t]*(.+?)[ \t]*$/;

/** Stream-safe line filter: holds back an incomplete trailing line until it can be classified. */
export class AttachFilter {
  readonly paths: string[] = [];
  private tail = "";

  /** Feed streamed text; returns the text that may be posted now. */
  feed(text: string): string {
    const buf = this.tail + text;
    const lastNl = buf.lastIndexOf("\n");
    if (lastNl === -1) {
      // No complete line yet. Release it only if it can no longer become an ATTACH line.
      if (this.couldBeAttach(buf)) {
        this.tail = buf;
        return "";
      }
      this.tail = "";
      return buf;
    }
    const complete = buf.slice(0, lastNl + 1);
    this.tail = buf.slice(lastNl + 1);
    const out = this.filterLines(complete);
    if (this.tail && !this.couldBeAttach(this.tail)) {
      const t = this.tail;
      this.tail = "";
      return out + t;
    }
    return out;
  }

  /** Call when the turn ends; returns any held-back text. */
  finish(): string {
    const t = this.tail;
    this.tail = "";
    return this.filterLines(t);
  }

  private couldBeAttach(s: string): boolean {
    const trimmed = s.trimStart();
    return "ATTACH:".startsWith(trimmed.slice(0, 7)) && trimmed.length <= 7 ? true : trimmed.startsWith("ATTACH:");
  }

  private filterLines(s: string): string {
    if (!s) return s;
    const lines = s.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = ATTACH_RE.exec(line);
      if (m) this.paths.push(m[1]!);
      else kept.push(line);
    }
    return kept.join("\n");
  }
}

/** Structural subset of @slack/web-api's WebClient (its argument union is stricter than we need). */
export interface UploadClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filesUploadV2(args: any): Promise<unknown>;
}

export function resolveAttachPath(p: string, cwd: string): string {
  const clean = p.replace(/^["'`]|["'`]$/g, "");
  return path.isAbsolute(clean) ? clean : path.join(cwd, clean);
}

/** Upload files into a thread; returns a note for each failure. */
export async function uploadFiles(
  client: UploadClient,
  channel: string,
  threadTs: string | undefined,
  paths: string[],
  cwd: string,
  log: Logger,
  opts: { title?: string; comment?: string } = {},
): Promise<string[]> {
  const problems: string[] = [];
  for (const raw of paths) {
    const p = resolveAttachPath(raw, cwd);
    try {
      if (!fs.statSync(p).isFile()) throw new Error("not a file");
      await client.filesUploadV2({
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        file: fs.readFileSync(p),
        filename: path.basename(p),
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.comment ? { initial_comment: opts.comment } : {}),
      });
      log.info(`uploaded ${p} to ${channel}${threadTs ? "/" + threadTs : ""}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`upload failed for ${p}: ${msg}`);
      problems.push(`${raw}: ${msg}`);
    }
  }
  return problems;
}
