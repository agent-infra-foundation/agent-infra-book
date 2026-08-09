import { describe, expect, it } from "vitest";
import { prepareFullManifest } from "../engines/compact-manifest";
import type { EngineName } from "../engines/types";
import { nowMs } from "../engines/util";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const MIB = 1024 * 1024;
const FILE_BYTES = 16 * MIB;

interface EditOperation {
  offset: number;
  value: number;
}

interface ScaleMeasurement {
  editMs: number;
  publishMs: number;
  totalMs: number;
  sqlitePayloadBytes: number;
  privateCowPagePayloadBytes: number;
  branchExclusiveContentBytes: number;
  storedGrowthBytes: number;
  orphanBytes: number;
  databaseGrowthBytes: number;
}

interface ScaleRow {
  edits: number;
  naive: ScaleMeasurement;
  "cas-cdc-cow": ScaleMeasurement;
}

interface ScaleReport {
  schemaVersion: 1;
  benchmarkLayer: "engine";
  configuration: {
    fileBytes: number;
    editBytes: number;
    distributions: string;
  };
  rows: ScaleRow[];
}

function operations(count: number): EditOperation[] {
  if (count === 1) return [{ offset: Math.floor(FILE_BYTES / 2), value: 0xa1 }];
  const stride = Math.floor((FILE_BYTES - 1) / count);
  return Array.from({ length: count }, (_, index) => ({
    offset: index * stride,
    value: (index % 251) + 1,
  }));
}

async function measure(
  name: EngineName,
  edits: EditOperation[],
): Promise<ScaleMeasurement> {
  return withEngine(name, async ({ engine, sql }) => {
    const base = fixtureBytes(FILE_BYTES, 0x8101);
    const expected = new Uint8Array(base);
    await engine.seedFile("/workspace.bin", base);
    engine.createBranch("agent-a");
    engine.resetCounters();
    const before = engine.snapshot(1);
    const databaseBefore = sql.databaseSize;

    const editStarted = nowMs();
    for (const edit of edits) {
      const insert = new Uint8Array([edit.value]);
      await engine.editFile("agent-a", "/workspace.bin", edit.offset, 1, insert);
      expected[edit.offset] = edit.value;
    }
    const editMs = nowMs() - editStarted;
    const afterEdits = engine.snapshot(1);

    const publishStarted = nowMs();
    const publish = await engine.publish("agent-a");
    const publishMs = nowMs() - publishStarted;
    if (publish.outcome !== "merged") throw new Error(`${name} unexpectedly conflicted`);

    const afterPublish = engine.snapshot(1);
    const actual = await engine.readFile(null, "/workspace.bin");
    if (!bytesEqual(actual, expected)) throw new Error(`${name} scale result is incorrect`);
    if (name === "cas-cdc-cow") {
      const canonical = await prepareFullManifest(expected);
      const current = sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/workspace.bin'",
      ).toArray()[0];
      if (current?.manifest_hash !== canonical.hash) {
        throw new Error("scaled local CDC manifest differs from canonical full CDC");
      }
    }

    return {
      editMs,
      publishMs,
      totalMs: editMs + publishMs,
      sqlitePayloadBytes: engine.counters.sqlitePayloadBytes,
      privateCowPagePayloadBytes: afterEdits.branchStorage.cowPageBytes,
      branchExclusiveContentBytes: afterEdits.branchStorage.totalExclusivePayloadBytes,
      storedGrowthBytes: Math.max(0, afterPublish.storedPayloadBytes - before.storedPayloadBytes),
      orphanBytes: afterPublish.orphanPayloadBytes,
      databaseGrowthBytes: Math.max(0, sql.databaseSize - databaseBefore),
    };
  });
}

describe("one and one thousand edits", () => {
  it("separates private edit cost from durable publication", async () => {
    const rows: ScaleRow[] = [];
    for (const count of [1, 1000]) {
      const edits = operations(count);
      const naive = await measure("naive", edits);
      const optimized = await measure("cas-cdc-cow", edits);
      rows.push({ edits: count, naive, "cas-cdc-cow": optimized });
    }
    const report: ScaleReport = {
      schemaVersion: 1,
      benchmarkLayer: "engine",
      configuration: {
        fileBytes: FILE_BYTES,
        editBytes: 1,
        distributions: "one midpoint edit; 1,000 evenly spaced edits",
      },
      rows,
    };
    expect(rows).toHaveLength(2);
    expect(rows[1]["cas-cdc-cow"].branchExclusiveContentBytes).toBeLessThan(
      rows[1].naive.sqlitePayloadBytes,
    );
    console.log(`EDIT_SCALE_JSON:${JSON.stringify(report)}`);
  });
});
