import { describe, expect, it } from "vitest";
import {
  CasCdcCowWorkspaceStore,
  type C3ExperimentMetrics,
  type ExperimentalRangeEdit,
} from "../engines/cas-cdc-cow";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const KIB = 1024;
const MIB = 1024 * KIB;

type Route =
  | "sequential"
  | "batched"
  | "multi-window"
  | "coalesced-multi-window"
  | "adaptive";

function editedFixture(
  fileBytes: number,
  offsets: number[],
  rangeBytes: number,
): { base: Uint8Array; expected: Uint8Array; ranges: ExperimentalRangeEdit[] } {
  const base = fixtureBytes(fileBytes, 0x71a3 + fileBytes / MIB);
  const expected = new Uint8Array(base);
  const ranges = offsets.map((offset) => {
    const bytes = new Uint8Array(rangeBytes);
    for (let index = 0; index < rangeBytes; index++) {
      bytes[index] = base[offset + index] ^ 0xff;
    }
    expected.set(bytes, offset);
    return { offset, bytes };
  });
  return { base, expected, ranges };
}

async function execute(
  route: Route,
  workload: ReturnType<typeof editedFixture>,
): Promise<{ actual: Uint8Array; metrics: C3ExperimentMetrics }> {
  return withEngine("cas-cdc-cow", async ({ engine }) => {
    const c3 = engine as CasCdcCowWorkspaceStore;
    await c3.seedFile("/workspace.bin", workload.base);
    c3.createBranch("agent-a");
    c3.resetCounters();
    if (route === "sequential") {
      for (const range of workload.ranges) {
        await c3.editFile(
          "agent-a",
          "/workspace.bin",
          range.offset,
          range.bytes.byteLength,
          range.bytes,
        );
      }
    } else {
      await c3.editFileRanges("agent-a", "/workspace.bin", workload.ranges);
      if (route === "multi-window") {
        c3.setExperimentalPagePublishStrategy("agent-a", "multi-window");
      } else if (route === "coalesced-multi-window") {
        c3.setExperimentalPagePublishStrategy("agent-a", "coalesced-multi-window");
      } else if (route === "adaptive") {
        c3.setExperimentalPagePublishStrategy("agent-a", "adaptive");
      }
    }
    const published = await c3.publish("agent-a");
    expect(published.outcome).toBe("merged");
    return {
      actual: await c3.readFile(null, "/workspace.bin"),
      metrics: { ...c3.experimentalMetrics },
    };
  });
}

describe("experimental batched COW and multi-window CDC", () => {
  it("coalesces repeated edits to one page into one load and upsert", async () => {
    const workload = editedFixture(4 * MIB, [64 * KIB, 64 * KIB + 256, 64 * KIB + 512], 64);
    const sequential = await execute("sequential", workload);
    const batched = await execute("batched", workload);

    expect(bytesEqual(sequential.actual, workload.expected)).toBe(true);
    expect(bytesEqual(batched.actual, workload.expected)).toBe(true);
    expect(sequential.metrics.pageLoadCount).toBe(3);
    expect(sequential.metrics.pageUpsertCount).toBe(3);
    expect(batched.metrics.pageLoadCount).toBe(1);
    expect(batched.metrics.pageUpsertCount).toBe(1);
  });

  it("publishes separated dirty regions through more than one safe resync window", async () => {
    const workload = editedFixture(
      4 * MIB,
      [64 * KIB, 2 * MIB, 3 * MIB + 512 * KIB],
      4 * KIB,
    );
    const single = await execute("batched", workload);
    const multi = await execute("multi-window", workload);

    expect(bytesEqual(single.actual, workload.expected)).toBe(true);
    expect(bytesEqual(multi.actual, workload.expected)).toBe(true);
    expect(multi.metrics.multiWindowResyncCount).toBeGreaterThan(1);
    expect(multi.metrics.cdcScanBytes).toBeLessThan(single.metrics.cdcScanBytes);
  });

  it("pre-merges nearby dirty runs before attempting local CDC", async () => {
    const workload = editedFixture(
      4 * MIB,
      Array.from({ length: 16 }, (_, index) => MIB + index * 32 * KIB),
      4 * KIB,
    );
    const raw = await execute("multi-window", workload);
    const coalesced = await execute("coalesced-multi-window", workload);

    expect(bytesEqual(raw.actual, workload.expected)).toBe(true);
    expect(bytesEqual(coalesced.actual, workload.expected)).toBe(true);
    expect(raw.metrics.multiWindowOriginalRunCount).toBe(16);
    expect(raw.metrics.multiWindowPlannedRunCount).toBe(16);
    expect(coalesced.metrics.multiWindowOriginalRunCount).toBe(16);
    expect(coalesced.metrics.multiWindowPlannedRunCount).toBe(1);
    expect(coalesced.metrics.cdcWindowCount).toBeLessThan(raw.metrics.cdcWindowCount);
  });

  it("routes a few distant dirty regions to bounded multi-window CDC", async () => {
    const workload = editedFixture(
      16 * MIB,
      [64 * KIB, 5 * MIB, 10 * MIB, 15 * MIB],
      4 * KIB,
    );
    const adaptive = await execute("adaptive", workload);

    expect(bytesEqual(adaptive.actual, workload.expected)).toBe(true);
    expect(adaptive.metrics.adaptiveSelectedMultiWindowCount).toBe(1);
    expect(adaptive.metrics.adaptiveSelectedSingleWindowCount).toBe(0);
    expect(adaptive.metrics.adaptiveSelectedFullScanCount).toBe(0);
    expect(adaptive.metrics.adaptiveBudgetFallbackCount).toBe(0);
    expect(adaptive.metrics.cdcScanBytes).toBeLessThanOrEqual(16 * MIB);
  });

  it("routes one localized cluster to a single CDC envelope", async () => {
    const workload = editedFixture(
      16 * MIB,
      [7 * MIB, 7 * MIB + 64 * KIB, 7 * MIB + 128 * KIB, 7 * MIB + 192 * KIB],
      4 * KIB,
    );
    const adaptive = await execute("adaptive", workload);

    expect(bytesEqual(adaptive.actual, workload.expected)).toBe(true);
    expect(adaptive.metrics.adaptiveOriginalRunCount).toBe(4);
    expect(adaptive.metrics.adaptiveCoalescedRunCount).toBe(1);
    expect(adaptive.metrics.adaptiveSelectedSingleWindowCount).toBe(1);
    expect(adaptive.metrics.adaptiveSelectedMultiWindowCount).toBe(0);
    expect(adaptive.metrics.adaptiveSelectedFullScanCount).toBe(0);
  });

  it("routes many file-spanning dirty regions to one full scan", async () => {
    const workload = editedFixture(
      4 * MIB,
      Array.from({ length: 64 }, (_, index) => index * 64 * KIB),
      4 * KIB,
    );
    const adaptive = await execute("adaptive", workload);

    expect(bytesEqual(adaptive.actual, workload.expected)).toBe(true);
    expect(adaptive.metrics.adaptiveOriginalRunCount).toBe(64);
    expect(adaptive.metrics.adaptiveCoalescedRunCount).toBe(1);
    expect(adaptive.metrics.adaptiveSelectedFullScanCount).toBe(1);
    expect(adaptive.metrics.adaptiveSelectedSingleWindowCount).toBe(0);
    expect(adaptive.metrics.adaptiveSelectedMultiWindowCount).toBe(0);
    expect(adaptive.metrics.cdcWindowCount).toBe(1);
    expect(adaptive.metrics.fullManifestCount).toBe(1);
  });

  it("does not retain an experimental route when a branch id is reused", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const c3 = engine as CasCdcCowWorkspaceStore;
      const base = fixtureBytes(4 * MIB, 0x71a3);
      const ranges = [64 * KIB, 3 * MIB].map((offset) => ({
        offset,
        bytes: new Uint8Array(4 * KIB).fill(0xa5),
      }));

      await c3.seedFile("/workspace.bin", base);
      c3.createBranch("agent-a");
      c3.setExperimentalPagePublishStrategy("agent-a", "adaptive");
      await c3.editFileRanges("agent-a", "/workspace.bin", ranges);
      await c3.publish("agent-a");
      await c3.gc(1);

      c3.createBranch("agent-a");
      c3.resetCounters();
      await c3.editFileRanges("agent-a", "/workspace.bin", ranges);
      await c3.publish("agent-a");

      expect(c3.experimentalMetrics.adaptivePlanCount).toBe(0);
    });
  });
});
