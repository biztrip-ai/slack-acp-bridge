import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { buildAvatarPng } from "../src/avatar.js";

describe("buildAvatarPng", () => {
  it("produces a valid square RGBA PNG of the requested size with transparent corners and opaque centre", () => {
    const png = buildAvatarPng({ size: 64 });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(64);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    // decode IDAT to check a corner pixel is transparent and the centre is opaque
    const idatLen = png.readUInt32BE(33);
    expect(png.toString("ascii", 37, 41)).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    const px = (x: number, y: number) => raw.subarray(y * (1 + 64 * 4) + 1 + x * 4, y * (1 + 64 * 4) + 1 + x * 4 + 4);
    expect(px(0, 0)[3]).toBe(0);
    expect(px(32, 32)[3]).toBe(255);
  });
});
