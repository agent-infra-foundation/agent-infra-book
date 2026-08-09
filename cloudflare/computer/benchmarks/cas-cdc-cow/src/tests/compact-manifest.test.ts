import { describe, expect, it } from "vitest";
import {
  decodeManifest,
  encodeManifest,
  prepareFullManifest,
} from "../engines/compact-manifest";
import { fixtureBytes } from "../lib/fixtures";

describe("compact manifest", () => {
  it("round trips binary hash and size entries", () => {
    const entries = [
      { hash: "00".repeat(32), size: 32 * 1024 },
      { hash: "ff".repeat(32), size: 512 * 1024 },
    ];
    const encoded = encodeManifest(entries);
    expect(encoded.byteLength).toBe(72);
    expect(decodeManifest(encoded)).toEqual(entries);
  });

  it("builds a deterministic full manifest", async () => {
    const bytes = fixtureBytes(2 * 1024 * 1024, 81);
    const first = await prepareFullManifest(bytes);
    const second = await prepareFullManifest(bytes);
    expect(second.hash).toBe(first.hash);
    expect(second.encoded).toEqual(first.encoded);
    expect(second.entries.reduce((total, entry) => total + entry.size, 0)).toBe(bytes.byteLength);
  });
});
