import { sha256Hex } from "../lib/payload";
import type { CorrectnessResult } from "../lib/types";

export async function compareBytes(
  expected: Uint8Array,
  actual: Uint8Array,
): Promise<CorrectnessResult> {
  const [expectedSha256, actualSha256] = await Promise.all([
    sha256Hex(expected),
    sha256Hex(actual),
  ]);
  return {
    passed: expected.byteLength === actual.byteLength && expectedSha256 === actualSha256,
    expectedBytes: expected.byteLength,
    actualBytes: actual.byteLength,
    expectedSha256,
    actualSha256,
  };
}

