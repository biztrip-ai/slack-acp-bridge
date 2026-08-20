import { randomUUID } from "node:crypto";
import type { KnownBlock } from "@slack/types";
import type { Logger } from "../logger.js";
import { truncate } from "../logger.js";
import type { PermissionDecision, PermissionRequest } from "../host/types.js";

export interface PermissionChat {
  chat: {
    postMessage(args: { channel: string; thread_ts?: string; text: string; blocks?: KnownBlock[] }): Promise<{ ts?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: KnownBlock[] }): Promise<unknown>;
  };
}

interface Pending {
  resolve: (d: PermissionDecision & { by?: string }) => void;
  channel: string;
  ts?: string;
  title: string;
  options: PermissionRequest["options"];
}

export const PERMISSION_ACTION_PREFIX = "perm:";

function describe(req: PermissionRequest): { title: string; detail: string } {
  const title = req.toolCall.title ?? "Tool call";
  const raw = (req.toolCall as { rawInput?: unknown }).rawInput;
  let detail = "";
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const key = ["command", "file_path", "path", "url", "pattern", "query"].find((k) => typeof r[k] === "string");
    detail = key ? String(r[key]) : JSON.stringify(raw, null, 2);
  } else if (typeof raw === "string") {
    detail = raw;
  }
  return { title, detail: truncate(detail, 1500) };
}

/**
 * Surfaces ACP permission requests as a Block Kit message with one button per
 * option, and resolves them from `block_actions` payloads.
 */
export class PermissionPrompter {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly client: PermissionChat,
    private readonly log: Logger,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  async ask(channel: string, threadTs: string | undefined, req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
    const id = randomUUID();
    const { title, detail } = describe(req);
    const blocks: KnownBlock[] = [
      { type: "section", text: { type: "mrkdwn", text: `:lock: *Permission needed:* ${title}` } },
    ];
    if (detail) blocks.push({ type: "section", text: { type: "mrkdwn", text: "```" + detail + "```" } });
    blocks.push({
      type: "actions",
      block_id: `${PERMISSION_ACTION_PREFIX}${id}`,
      elements: req.options.map((o) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: truncate(o.name, 75) },
        action_id: `${PERMISSION_ACTION_PREFIX}${o.optionId}`,
        value: JSON.stringify({ id, optionId: o.optionId }),
        ...(o.kind.startsWith("allow") ? { style: "primary" as const } : o.kind.startsWith("reject") ? { style: "danger" as const } : {}),
      })),
    });

    return new Promise<PermissionDecision>((resolve) => {
      const entry: Pending = { resolve: () => {}, channel, title, options: req.options };
      let settled = false;
      const finish = async (d: PermissionDecision & { by?: string }, note: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (entry.ts) {
          const text = `:lock: ${title} — ${note}`;
          try {
            await this.client.chat.update({ channel, ts: entry.ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
          } catch (e) {
            this.log.warn("permission message update failed", e);
          }
        }
        resolve("optionId" in d ? { optionId: d.optionId } : { cancelled: true });
      };
      entry.resolve = (d) => {
        const opt = "optionId" in d ? req.options.find((o) => o.optionId === d.optionId) : undefined;
        void finish(d, `*${opt?.name ?? "cancelled"}*${d.by ? ` by <@${d.by}>` : ""}`);
      };
      const timer = setTimeout(() => void finish({ cancelled: true }, "_timed out_"), this.timeoutMs);
      const onAbort = () => void finish({ cancelled: true }, "_cancelled_");
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, entry);

      this.client.chat
        .postMessage({ channel, thread_ts: threadTs, text: `Permission needed: ${title}`, blocks })
        .then((r) => {
          entry.ts = r.ts;
        })
        .catch((e) => {
          this.log.error("permission prompt post failed; cancelling", e);
          void finish({ cancelled: true }, "_could not prompt_");
        });
    });
  }

  /** Feed a button click. Returns false if it wasn't ours / already settled. */
  resolve(value: string, userId?: string): boolean {
    let parsed: { id?: string; optionId?: string };
    try {
      parsed = JSON.parse(value) as { id?: string; optionId?: string };
    } catch {
      return false;
    }
    if (!parsed.id || !parsed.optionId) return false;
    const p = this.pending.get(parsed.id);
    if (!p) return false;
    this.log.info(`permission ${parsed.optionId} for "${truncate(p.title, 80)}" by ${userId ?? "?"}`);
    p.resolve({ optionId: parsed.optionId, by: userId });
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
