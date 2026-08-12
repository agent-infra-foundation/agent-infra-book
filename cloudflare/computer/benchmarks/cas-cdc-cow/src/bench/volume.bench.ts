import { describe, expect, it } from "vitest";
import { prepareFullManifest } from "../engines/compact-manifest";
import { nowMs } from "../engines/util";
import type { EngineName } from "../engines/types";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const MIB = 1024 * 1024;
const FILE_BYTES = 64 * MIB;

type VolumeOperation =
  | { kind: "rewrite"; insert: Uint8Array }
  | { kind: "overwrite"; offset: number; insert: Uint8Array }
  | { kind: "prepend"; insert: Uint8Array };

interface AggregateMeasurement {
  operationsCompleted: number;
  elapsedMs: number;
  sqlitePayloadBytes: number;
  retainedGrowthBytes: number;
  databaseGrowthBytes: number;
  storedBeforeGcBytes: number;
  orphanBeforeGcBytes: number;
  gcReclaimedBytes: number;
  gcElapsedMs: number;
  storedAfterGcBytes: number;
  orphanAfterGcBytes: number;
  databaseAfterGcBytes: number;
}

interface VolumeReport {
  schemaVersion: 1;
  benchmarkLayer: "engine";
  configuration: {
    fileBytes: number;
    totalOperations: number;
    overwrites: number;
    prepends: number;
    fullRewrites: number;
    overwriteBytes: number;
    prependBytes: number;
  };
  measurements: Record<EngineName, AggregateMeasurement>;
}

function makeWorkload(): { operations: VolumeOperation[]; expected: Uint8Array } {
  const replacement = fixtureBytes(FILE_BYTES, 0x7002);
  const operations: VolumeOperation[] = [{ kind: "rewrite", insert: replacement }];
  let currentSize = FILE_BYTES;
  let overwriteIndex = 0;

  for (let round = 0; round < 7; round++) {
    for (let local = 0; local < 3; local++) {
      const offset = (1_000_003 + overwriteIndex * 2_000_033) % (currentSize - 10);
      operations.push({
        kind: "overwrite",
        offset,
        insert: new Uint8Array(10).fill(0x20 + overwriteIndex),
      });
      overwriteIndex++;
    }
    operations.push({
      kind: "prepend",
      insert: new Uint8Array(10).fill(0xa0 + round),
    });
    currentSize += 10;
  }
  while (overwriteIndex < 24) {
    const offset = (1_000_003 + overwriteIndex * 2_000_033) % (currentSize - 10);
    operations.push({
      kind: "overwrite",
      offset,
      insert: new Uint8Array(10).fill(0x20 + overwriteIndex),
    });
    overwriteIndex++;
  }

  let expected = new Uint8Array(replacement);
  for (const operation of operations.slice(1)) {
    if (operation.kind === "overwrite") {
      expected.set(operation.insert, operation.offset);
    } else if (operation.kind === "prepend") {
      const next = new Uint8Array(expected.byteLength + operation.insert.byteLength);
      next.set(operation.insert, 0);
      next.set(expected, operation.insert.byteLength);
      expected = next;
    }
  }
  return { operations, expected };
}

async function measureAggregate(
  name: EngineName,
  operations: VolumeOperation[],
  expected: Uint8Array,
): Promise<AggregateMeasurement> {
  return withEngine(name, async ({ engine, sql }) => {
    await engine.seedFile("/workspace.bin", fixtureBytes(FILE_BYTES, 0x7001));
    engine.resetCounters();
    const before = engine.snapshot(1);
    const databaseBefore = sql.databaseSize;

    const started = nowMs();
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      const branch = `checkpoint-${index}`;
      engine.createBranch(branch);
      if (operation.kind === "rewrite") {
        const current = await engine.readFile(branch, "/workspace.bin");
        await engine.editFile(branch, "/workspace.bin", 0, current.byteLength, operation.insert);
      } else if (operation.kind === "overwrite") {
        await engine.editFile(
          branch,
          "/workspace.bin",
          operation.offset,
          operation.insert.byteLength,
          operation.insert,
        );
      } else {
        await engine.editFile(branch, "/workspace.bin", 0, 0, operation.insert);
      }
      const publish = await engine.publish(branch);
      if (publish.outcome !== "merged") {
        throw new Error(`${name} conflicted at operation ${index}`);
      }
    }
    const elapsedMs = nowMs() - started;

    const beforeGc = engine.snapshot(1);
    const databaseBeforeGc = sql.databaseSize;
    const actual = await engine.readFile(null, "/workspace.bin");
    if (!bytesEqual(actual, expected)) throw new Error(`${name} aggregate result is incorrect`);
    if (name === "cas-cdc-cow") {
      const canonical = await prepareFullManifest(expected);
      const current = sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/workspace.bin'",
      ).toArray()[0];
      if (current?.manifest_hash !== canonical.hash) {
        throw new Error("local CDC aggregate manifest differs from canonical full CDC");
      }
    }

    const gc = engine.gc(1);
    const afterGc = engine.snapshot(1);
    if (!bytesEqual(await engine.readFile(null, "/workspace.bin"), expected)) {
      throw new Error(`${name} aggregate GC changed current content`);
    }
    return {
      operationsCompleted: operations.length,
      elapsedMs,
      sqlitePayloadBytes: engine.counters.sqlitePayloadBytes,
      retainedGrowthBytes: Math.max(0, beforeGc.storedPayloadBytes - before.storedPayloadBytes),
      databaseGrowthBytes: Math.max(0, databaseBeforeGc - databaseBefore),
      storedBeforeGcBytes: beforeGc.storedPayloadBytes,
      orphanBeforeGcBytes: beforeGc.orphanPayloadBytes,
      gcReclaimedBytes: gc.payloadBytesReclaimed,
      gcElapsedMs: gc.elapsedMs,
      storedAfterGcBytes: afterGc.storedPayloadBytes,
      orphanAfterGcBytes: afterGc.orphanPayloadBytes,
      databaseAfterGcBytes: sql.databaseSize,
    };
  });
}

describe("high-volume aggregate storage", () => {
  it("runs 32 checkpoints over one 64 MiB workspace", async () => {
    const { operations, expected } = makeWorkload();
    const naive = await measureAggregate("naive", operations, expected);
    const optimized = await measureAggregate("cas-cdc-cow", operations, expected);
    const report: VolumeReport = {
      schemaVersion: 1,
      benchmarkLayer: "engine",
      configuration: {
        fileBytes: FILE_BYTES,
        totalOperations: operations.length,
        overwrites: operations.filter((operation) => operation.kind === "overwrite").length,
        prepends: operations.filter((operation) => operation.kind === "prepend").length,
        fullRewrites: operations.filter((operation) => operation.kind === "rewrite").length,
        overwriteBytes: 10,
        prependBytes: 10,
      },
      measurements: {
        naive,
        "cas-cdc-cow": optimized,
      },
    };

    expect(naive.operationsCompleted).toBe(32);
    expect(optimized.operationsCompleted).toBe(32);
    expect(naive.orphanAfterGcBytes).toBe(0);
    expect(optimized.orphanAfterGcBytes).toBe(0);
    console.log(`VOLUME_BENCHMARK_JSON:${JSON.stringify(report)}`);
  });
});
