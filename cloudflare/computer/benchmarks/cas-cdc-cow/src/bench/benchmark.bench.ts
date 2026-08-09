import { describe, expect, it } from "vitest";
import { applyEdit, nowMs } from "../engines/util";
import type { EngineName } from "../engines/types";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const MIB = 1024 * 1024;
const STORAGE_FILE_BYTES = 16 * MIB;
const BRANCH_FILE_BYTES = 1 * MIB;
const GC_FILE_BYTES = 8 * MIB;
const engineNames: EngineName[] = ["naive", "cas-cdc-cow"];

interface OperationMeasurement {
  elapsedMs: number;
  sqlitePayloadBytes: number;
  databaseGrowthBytes: number;
  retainedGrowthBytes: number;
}

interface StorageRow {
  id: string;
  label: string;
  naive: OperationMeasurement;
  "cas-cdc-cow": OperationMeasurement;
}

interface BranchMeasurement {
  create: {
    elapsedMs: number;
    sqlitePayloadBytes: number;
    databaseGrowthBytes: number;
  };
  privateEdit: {
    elapsedMs: number;
    sqlitePayloadBytes: number;
    privateCowPagePayloadBytes: number;
    branchExclusiveContentBytes: number;
    branchDatabaseGrowthBytes: number;
  };
  disjoint: {
    merged: number;
    filesCorrect: number;
  };
  sameFile: {
    firstOutcome: string;
    secondOutcome: string;
    lostUpdates: number;
  };
}

interface GcMeasurement {
  storedBeforeBytes: number;
  reachableBeforeBytes: number;
  orphanBeforeBytes: number;
  storedAfterBytes: number;
  orphanAfterBytes: number;
  reclaimedBytes: number;
  elapsedMs: number;
  databaseBeforeBytes: number;
  databaseAfterBytes: number;
}

interface BenchmarkReport {
  schemaVersion: 1;
  benchmarkLayer: "engine";
  configuration: {
    storageFileBytes: number;
    branchFileBytes: number;
    gcFileBytes: number;
    cowPageBytes: number;
    cdc: { minBytes: number; averageBytes: number; maxBytes: number };
  };
  storage: StorageRow[];
  branches: Record<EngineName, BranchMeasurement>;
  gc: Record<EngineName, GcMeasurement>;
}

interface StorageCase {
  id: string;
  label: string;
  run: (
    edit: (offset: number, deleteLength: number, insert: Uint8Array) => Promise<void>,
    base: Uint8Array,
  ) => Promise<Uint8Array>;
}

const storageCases: StorageCase[] = [
  {
    id: "overwrite-10b",
    label: "Overwrite 10 B",
    async run(edit, base) {
      const insert = new Uint8Array(10).fill(0xa1);
      const offset = 7 * MIB + 123;
      await edit(offset, 10, insert);
      return applyEdit(base, offset, 10, insert);
    },
  },
  {
    id: "overwrite-10b-x5",
    label: "5x overwrite 10 B",
    async run(edit, base) {
      const offset = 7 * MIB + 123;
      let expected = base;
      for (let index = 0; index < 5; index++) {
        const insert = new Uint8Array(10).fill(0xb0 + index);
        await edit(offset, 10, insert);
        expected = applyEdit(expected, offset, 10, insert);
      }
      return expected;
    },
  },
  {
    id: "prepend-10b",
    label: "Prepend 10 B",
    async run(edit, base) {
      const insert = new Uint8Array(10).fill(0xc1);
      await edit(0, 0, insert);
      return applyEdit(base, 0, 0, insert);
    },
  },
  {
    id: "rewrite-full",
    label: "Rewrite full file",
    async run(edit, base) {
      const replacement = fixtureBytes(base.byteLength, 0x987654);
      await edit(0, base.byteLength, replacement);
      return replacement;
    },
  },
];

async function measureStorageCase(
  name: EngineName,
  benchmarkCase: StorageCase,
): Promise<OperationMeasurement> {
  return withEngine(name, async ({ engine, sql }) => {
    const base = fixtureBytes(STORAGE_FILE_BYTES, 0x123456);
    await engine.seedFile("/workspace.bin", base);
    engine.createBranch("agent-a");
    engine.resetCounters();
    const before = engine.snapshot(1);
    const databaseBefore = sql.databaseSize;

    const started = nowMs();
    const expected = await benchmarkCase.run(
      (offset, deleteLength, insert) => engine.editFile(
        "agent-a",
        "/workspace.bin",
        offset,
        deleteLength,
        insert,
      ),
      base,
    );
    const publish = await engine.publish("agent-a");
    const elapsedMs = nowMs() - started;
    if (publish.outcome !== "merged") throw new Error(`${name} unexpectedly conflicted`);

    const after = engine.snapshot(1);
    const actual = await engine.readFile(null, "/workspace.bin");
    if (!bytesEqual(actual, expected)) throw new Error(`${name} produced incorrect bytes`);
    return {
      elapsedMs,
      sqlitePayloadBytes: engine.counters.sqlitePayloadBytes,
      databaseGrowthBytes: Math.max(0, sql.databaseSize - databaseBefore),
      retainedGrowthBytes: Math.max(0, after.storedPayloadBytes - before.storedPayloadBytes),
    };
  });
}

async function measureBranches(name: EngineName): Promise<BranchMeasurement> {
  const create = await withEngine(name, async ({ engine, sql }) => {
    await engine.seedFile("/file.bin", fixtureBytes(BRANCH_FILE_BYTES, 0x2001));
    engine.resetCounters();
    const databaseBefore = sql.databaseSize;
    const started = nowMs();
    engine.createBranch("agent-a");
    return {
      elapsedMs: nowMs() - started,
      sqlitePayloadBytes: engine.counters.sqlitePayloadBytes,
      databaseGrowthBytes: Math.max(0, sql.databaseSize - databaseBefore),
    };
  });

  const privateEdit = await withEngine(name, async ({ engine, sql }) => {
    await engine.seedFile("/file.bin", fixtureBytes(BRANCH_FILE_BYTES, 0x2002));
    const databaseBefore = sql.databaseSize;
    engine.createBranch("agent-a");
    engine.resetCounters();
    const started = nowMs();
    await engine.editFile("agent-a", "/file.bin", 400_000, 10, new Uint8Array(10).fill(0xd1));
    const elapsedMs = nowMs() - started;
    const snapshot = engine.snapshot(1);
    return {
      elapsedMs,
      sqlitePayloadBytes: engine.counters.sqlitePayloadBytes,
      privateCowPagePayloadBytes: snapshot.branchStorage.cowPageBytes,
      branchExclusiveContentBytes: snapshot.branchStorage.totalExclusivePayloadBytes,
      branchDatabaseGrowthBytes: Math.max(0, sql.databaseSize - databaseBefore),
    };
  });

  const disjoint = await withEngine(name, async ({ engine }) => {
    const a = fixtureBytes(BRANCH_FILE_BYTES, 0x2003);
    const b = fixtureBytes(BRANCH_FILE_BYTES, 0x2004);
    await engine.seedFile("/a.bin", a);
    await engine.seedFile("/b.bin", b);
    engine.createBranch("agent-a");
    engine.createBranch("agent-b");
    await engine.editFile("agent-a", "/a.bin", 100, 1, new Uint8Array([0xea]));
    await engine.editFile("agent-b", "/b.bin", 100, 1, new Uint8Array([0xeb]));
    const outcomes = [await engine.publish("agent-a"), await engine.publish("agent-b")];
    const finalA = await engine.readFile(null, "/a.bin");
    const finalB = await engine.readFile(null, "/b.bin");
    return {
      merged: outcomes.filter((outcome) => outcome.outcome === "merged").length,
      filesCorrect: Number(finalA[100] === 0xea) + Number(finalB[100] === 0xeb),
    };
  });

  const sameFile = await withEngine(name, async ({ engine }) => {
    await engine.seedFile("/file.bin", fixtureBytes(BRANCH_FILE_BYTES, 0x2005));
    engine.createBranch("agent-a");
    engine.createBranch("agent-b");
    await engine.editFile("agent-a", "/file.bin", 100, 1, new Uint8Array([0xfa]));
    await engine.editFile("agent-b", "/file.bin", 100, 1, new Uint8Array([0xfb]));
    const first = await engine.publish("agent-a");
    const second = await engine.publish("agent-b");
    const final = await engine.readFile(null, "/file.bin");
    return {
      firstOutcome: first.outcome,
      secondOutcome: second.outcome,
      lostUpdates: name === "naive"
        ? Number(first.outcome === "merged" && second.outcome === "merged" && final[100] === 0xfb)
        : Number(first.outcome !== "merged" || second.outcome !== "conflict" || final[100] !== 0xfa),
    };
  });

  return { create, privateEdit, disjoint, sameFile };
}

async function measureGc(name: EngineName): Promise<GcMeasurement> {
  return withEngine(name, async ({ engine, sql }) => {
    let expected = fixtureBytes(GC_FILE_BYTES, 0x3001);
    await engine.seedFile("/file.bin", expected);
    for (let index = 0; index < 5; index++) {
      const offset = MIB + index * MIB;
      const insert = new Uint8Array(10).fill(0x60 + index);
      const branch = `agent-${index}`;
      engine.createBranch(branch);
      await engine.editFile(branch, "/file.bin", offset, 10, insert);
      expected = applyEdit(expected, offset, 10, insert);
      const publish = await engine.publish(branch);
      if (publish.outcome !== "merged") throw new Error(`${name} unexpectedly conflicted during GC setup`);
    }

    const before = engine.snapshot(1);
    const databaseBeforeBytes = sql.databaseSize;
    const gc = engine.gc(1);
    const after = engine.snapshot(1);
    if (!bytesEqual(await engine.readFile(null, "/file.bin"), expected)) {
      throw new Error(`${name} GC changed current content`);
    }
    return {
      storedBeforeBytes: before.storedPayloadBytes,
      reachableBeforeBytes: before.reachablePayloadBytes,
      orphanBeforeBytes: before.orphanPayloadBytes,
      storedAfterBytes: after.storedPayloadBytes,
      orphanAfterBytes: after.orphanPayloadBytes,
      reclaimedBytes: gc.payloadBytesReclaimed,
      elapsedMs: gc.elapsedMs,
      databaseBeforeBytes,
      databaseAfterBytes: sql.databaseSize,
    };
  });
}

describe("naive vs CAS + CDC + COW", () => {
  it("runs the compact benchmark matrix", async () => {
    const storage: StorageRow[] = [];
    for (const benchmarkCase of storageCases) {
      const [naive, optimized] = await Promise.all([
        measureStorageCase("naive", benchmarkCase),
        measureStorageCase("cas-cdc-cow", benchmarkCase),
      ]);
      storage.push({
        id: benchmarkCase.id,
        label: benchmarkCase.label,
        naive,
        "cas-cdc-cow": optimized,
      });
    }

    const [naiveBranches, optimizedBranches] = await Promise.all([
      measureBranches("naive"),
      measureBranches("cas-cdc-cow"),
    ]);
    const [naiveGc, optimizedGc] = await Promise.all([
      measureGc("naive"),
      measureGc("cas-cdc-cow"),
    ]);

    const report: BenchmarkReport = {
      schemaVersion: 1,
      benchmarkLayer: "engine",
      configuration: {
        storageFileBytes: STORAGE_FILE_BYTES,
        branchFileBytes: BRANCH_FILE_BYTES,
        gcFileBytes: GC_FILE_BYTES,
        cowPageBytes: 4 * 1024,
        cdc: {
          minBytes: 32 * 1024,
          averageBytes: 128 * 1024,
          maxBytes: 512 * 1024,
        },
      },
      storage,
      branches: {
        naive: naiveBranches,
        "cas-cdc-cow": optimizedBranches,
      },
      gc: {
        naive: naiveGc,
        "cas-cdc-cow": optimizedGc,
      },
    };

    expect(storage).toHaveLength(4);
    expect(optimizedBranches.sameFile.secondOutcome).toBe("conflict");
    expect(optimizedGc.orphanAfterBytes).toBe(0);
    console.log(`BENCHMARK_JSON:${JSON.stringify(report)}`);
  });
});
