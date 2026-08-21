import { deflateSync } from "node:zlib";

/**
 * Default bot avatar, drawn procedurally so the package needs no image assets
 * or dependencies: a rounded dark tile (the manifest's background colour) with
 * a white chat bubble and three dots. Rendered with 4x supersampling.
 */
export interface AvatarOptions {
  size?: number; // output pixels (square); Slack wants >= 512
  bg?: string; // hex
  fg?: string; // hex
}

function hex(c: string): [number, number, number] {
  const h = c.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Signed-distance helpers (in supersampled pixel units).
const sdRoundRect = (x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) => {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
};
const sdCircle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) - r;
// Triangle via half-planes (counter-clockwise vertices).
const sdTriangle = (x: number, y: number, a: [number, number], b: [number, number], c: [number, number]) => {
  const edge = (p: [number, number], q: [number, number]) => {
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const len = Math.hypot(ex, ey);
    return ((x - p[0]) * ey - (y - p[1]) * ex) / len;
  };
  // Normalise for either winding order (screen y points down).
  const orient = Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) || 1;
  return Math.max(edge(a, b) * orient, edge(b, c) * orient, edge(c, a) * orient);
};

export function buildAvatarPng(opts: AvatarOptions = {}): Buffer {
  const size = opts.size ?? 512;
  const SS = 4;
  const W = size * SS;
  const [br, bgc, bb] = hex(opts.bg ?? "#1f2937");
  const [fr, fgc, fb] = hex(opts.fg ?? "#ffffff");
  const u = W / 512; // design units → supersampled px

  const coverage = (x: number, y: number): number => {
    // Bubble body + tail (union), minus the three dots.
    const body = sdRoundRect(x, y, 256 * u, 232 * u, 168 * u, 112 * u, 56 * u);
    const tail = sdTriangle(x, y, [150 * u, 330 * u], [132 * u, 412 * u], [222 * u, 338 * u]);
    let d = Math.min(body, tail);
    for (const cx of [176, 256, 336]) d = Math.max(d, -sdCircle(x, y, cx * u, 232 * u, 26 * u));
    return d < 0 ? 1 : 0;
  };
  const tileMask = (x: number, y: number): number => (sdRoundRect(x, y, W / 2, W / 2, W / 2, W / 2, 96 * u) < 0 ? 1 : 0);

  const row = Buffer.alloc(1 + size * 4);
  const raw = Buffer.alloc((1 + size * 4) * size);
  for (let py = 0; py < size; py++) {
    row[0] = 0;
    for (let px = 0; px < size; px++) {
      let tile = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5, y = py * SS + sy + 0.5;
          const t = tileMask(x, y);
          tile += t;
          if (t) fg += coverage(x, y);
        }
      }
      const n = SS * SS;
      const a = tile / n; // tile alpha (transparent corners)
      const f = tile ? fg / tile : 0; // fg share inside tile
      const o = 1 + px * 4;
      row[o] = Math.round(br + (fr - br) * f);
      row[o + 1] = Math.round(bgc + (fgc - bgc) * f);
      row[o + 2] = Math.round(bb + (fb - bb) * f);
      row[o + 3] = Math.round(255 * a);
    }
    row.copy(raw, py * row.length);
  }
  return encodePng(size, size, raw);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w: number, h: number, filteredRows: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filteredRows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
