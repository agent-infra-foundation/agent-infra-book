import { describe, expect, it } from "vitest";
import { fastCdc } from "../engines/fastcdc";
import { fixtureBytes } from "../lib/fixtures";

describe("FastCDC", () => {
  it("covers the input exactly with bounded chunks", () => {
    const bytes = fixtureBytes(2 * 1024 * 1024);
    const chunks = fastCdc(bytes);
    expect(chunks[0]?.offset).toBe(0);
    expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(bytes.byteLength);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 512 * 1024)).toBe(true);
  });

  it("keeps most chunks stable after a small front insertion", () => {
    const original = fixtureBytes(4 * 1024 * 1024, 73);
    const prepended = new Uint8Array(original.byteLength + 10);
    prepended.set(new Uint8Array(10).fill(0xa5));
    prepended.set(original, 10);

    const chunkKeys = (bytes: Uint8Array) => new Set(
      fastCdc(bytes).map((chunk) => {
        const view = bytes.subarray(chunk.offset, chunk.offset + chunk.length);
        // A cheap test-only identity is enough to verify boundary stability.
        let hash = 2166136261;
        for (const byte of view) hash = Math.imul(hash ^ byte, 16777619);
        return `${chunk.length}:${hash >>> 0}`;
      }),
    );
    const before = chunkKeys(original);
    const after = chunkKeys(prepended);
    const reused = [...before].filter((key) => after.has(key)).length;
    expect(reused / before.size).toBeGreaterThan(0.7);
  });
});

