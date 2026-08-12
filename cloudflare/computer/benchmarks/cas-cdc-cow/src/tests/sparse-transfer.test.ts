import { describe, expect, it } from "vitest";
import {
  CasCdcCowWorkspaceStore,
  type ExperimentalRangeEdit,
} from "../engines/cas-cdc-cow";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const KIB = 1024;
const MIB = 1024 * KIB;

function editedFixture(
  fileBytes: number,
  pageOffsets: number[],
): { base: Uint8Array; expected: Uint8Array; ranges: ExperimentalRangeEdit[] } {
  const base = fixtureBytes(fileBytes, 0x63a5 + fileBytes / MIB);
  const expected = new Uint8Array(base);
  const ranges = pageOffsets.map((offset) => {
    const bytes = new Uint8Array(4 * KIB);
    for (let index = 0; index < bytes.byteLength; index++) {
      bytes[index] = base[offset + index] ^ 0xff;
    }
    expected.set(bytes, offset);
    return { offset, bytes };
  });
  return { base, expected, ranges };
}

async function withEditedBranch<T>(
  operation: (
    c3: CasCdcCowWorkspaceStore,
    expected: Uint8Array,
  ) => T | Promise<T>,
): Promise<T> {
  const workload = editedFixture(
    4 * MIB,
    [64 * KIB, 2 * MIB, 3 * MIB + 512 * KIB],
  );
  return withEngine("cas-cdc-cow", async ({ engine }) => {
    const c3 = engine as CasCdcCowWorkspaceStore;
    await c3.seedFile("/workspace.bin", workload.base);
    c3.createBranch("agent-a");
    await c3.editFileRanges("agent-a", "/workspace.bin", workload.ranges);
    return operation(c3, workload.expected);
  });
}

describe("experimental no-cache sparse transfer recipes", () => {
  it("reconstructs a dispersed equal-length COW branch exactly", async () => {
    await withEditedBranch((c3, expected) => {
      const recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      expect(c3.verifyExperimentalSparseRecipe(recipe, expected)).toBe(true);
      expect(recipe.extents[0]?.fileOffset).toBe(0);
      expect(recipe.extents.reduce((total, extent) => total + extent.length, 0))
        .toBe(expected.byteLength);
    });
  });

  it("reuses immutable CAS bytes and carries only dirty pages as literals", async () => {
    await withEditedBranch((c3, expected) => {
      const recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      expect(recipe.literalBytes).toBe(3 * 4 * KIB);
      expect(recipe.referencedBytes).toBe(expected.byteLength - recipe.literalBytes);
      expect(recipe.extents.some((extent) => extent.kind === "cas")).toBe(true);
      expect(recipe.extents.some((extent) => extent.kind === "literal")).toBe(true);
    });
  });

  it("serves sparse requested ranges without reading the whole logical file", async () => {
    await withEditedBranch((c3, expected) => {
      const recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      const ranges = [
        { offset: 60 * KIB, length: 16 * KIB },
        { offset: 2 * MIB - 2 * KIB, length: 16 * KIB },
      ];
      const read = c3.readExperimentalSparseRecipeRanges(recipe, ranges);
      expect(read.bytes.every((bytes, index) => bytesEqual(
        bytes,
        expected.subarray(ranges[index].offset, ranges[index].offset + ranges[index].length),
      ))).toBe(true);
      expect(read.metrics.requestedBytes).toBe(32 * KIB);
      expect(read.metrics.payloadBytes).toBeLessThan(expected.byteLength);
      expect(read.metrics.completeFileMaterializations).toBe(0);
    });
  });

  it("streams a cold full transfer with bounded algorithmic working set", async () => {
    await withEditedBranch((c3, expected) => {
      const recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      const consumed = c3.consumeExperimentalSparseRecipe(recipe);
      expect(consumed.payloadBytes).toBe(expected.byteLength);
      expect(consumed.completeFileMaterializations).toBe(0);
      expect(consumed.peakAlgorithmicPayloadBytes).toBeLessThan(expected.byteLength);
      expect(consumed.objectRangeReadCount).toBeGreaterThan(0);
    });
  });

  it("does not mutate persistent storage while exporting or reading a recipe", async () => {
    await withEditedBranch((c3, expected) => {
      const before = JSON.stringify(c3.snapshot(1));
      const recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      const read = c3.readExperimentalSparseRecipeRanges(recipe, [
        { offset: 0, length: 64 * KIB },
        { offset: expected.byteLength - 64 * KIB, length: 64 * KIB },
      ]);
      expect(read.bytes).toHaveLength(2);
      expect(JSON.stringify(c3.snapshot(1))).toBe(before);
    });
  });
});
