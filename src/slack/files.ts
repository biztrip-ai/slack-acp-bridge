import fs from "node:fs/promises";
import path from "node:path";
import type { PromptBlock } from "../host/types.js";
import type { Logger } from "../logger.js";

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 25 * 1024 * 1024;

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, "_");
  return base || "file";
}

/**
 * Turn Slack file attachments into ACP content blocks: images become inline
 * `image` blocks (when the agent supports them); everything else is saved
 * under `uploadDir` and passed as a `resource_link` the agent can read.
 */
export async function attachmentsToBlocks(
  files: SlackFile[],
  opts: { token: string; uploadDir: string; allowImages: boolean; log: Logger },
): Promise<{ blocks: PromptBlock[]; notes: string[] }> {
  const blocks: PromptBlock[] = [];
  const notes: string[] = [];
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    const name = safeName(f.name ?? f.title ?? f.id);
    if (!url) {
      notes.push(`(attachment ${name}: no download URL)`);
      continue;
    }
    if ((f.size ?? 0) > MAX_BYTES) {
      notes.push(`(attachment ${name} skipped: larger than ${MAX_BYTES / 1024 / 1024}MB)`);
      continue;
    }
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      if (ct.startsWith("text/html")) throw new Error("got HTML instead of the file (missing files:read scope?)");
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = f.mimetype ?? ct.split(";")[0] ?? "application/octet-stream";
      if (opts.allowImages && IMAGE_TYPES.has(mime)) {
        blocks.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
        continue;
      }
      await fs.mkdir(opts.uploadDir, { recursive: true });
      const dest = path.join(opts.uploadDir, `${f.id}-${name}`);
      await fs.writeFile(dest, buf);
      blocks.push({ type: "resource_link", uri: `file://${dest}`, name, mimeType: mime, size: buf.length });
      notes.push(`(attached file saved at ${dest})`);
    } catch (e) {
      opts.log.warn(`attachment ${name} download failed`, e);
      notes.push(`(attachment ${name} could not be downloaded: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { blocks, notes };
}
