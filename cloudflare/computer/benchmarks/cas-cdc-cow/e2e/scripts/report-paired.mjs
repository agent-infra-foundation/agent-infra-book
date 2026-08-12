import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(scriptRoot, "..");
const rawRoot = resolve(e2eRoot, "results/raw");
const profile = process.argv[2];
const batchId = process.argv[3];
if (!new Set(["volume", "branches"]).has(profile) || !batchId) {
  throw new Error("usage: report-paired.mjs <volume|branches> <batch-id>");
}

const rows = [];
for (const name of await readdir(rawRoot)) {
  if (!name.endsWith(".json")) continue;
  const report = JSON.parse(await readFile(resolve(rawRoot, name), "utf8"));
  if (report.profile === profile && report.batchId === batchId) rows.push(report);
}
const groups = new Map();
for (const row of rows) {
  if (!row.pairId) throw new Error(`missing pairId in ${row.objectName}`);
  const group = groups.get(row.pairId) ?? {};
  if (group[row.variant]) throw new Error(`duplicate ${row.variant} result for ${row.pairId}`);
  group[row.variant] = row;
  groups.set(row.pairId, group);
}
const pairs = [...groups.entries()].map(([pairId, group]) => {
  if (!group.baseline || !group.c3) throw new Error(`incomplete pair ${pairId}`);
  if (group.baseline.sourceCommit !== group.c3.sourceCommit) {
    throw new Error(`commit mismatch in ${pairId}`);
  }
  if (group.baseline.benchmarkSeed !== group.c3.benchmarkSeed) {
    throw new Error(`seed mismatch in ${pairId}`);
  }
  if (group.baseline.orderIndex === group.c3.orderIndex) {
    throw new Error(`invalid execution order in ${pairId}`);
  }
  return { pairId, baseline: group.baseline, c3: group.c3 };
}).sort((a, b) => a.pairId.localeCompare(b.pairId));
if (pairs.length < 10 || pairs.length > 30) {
  throw new Error(`expected 10-30 complete pairs, found ${pairs.length}`);
}
const sourceCommits = new Set(pairs.flatMap((pair) => [
  pair.baseline.sourceCommit,
  pair.c3.sourceCommit,
]));
const seeds = new Set(pairs.flatMap((pair) => [
  pair.baseline.benchmarkSeed,
  pair.c3.benchmarkSeed,
]));
if (sourceCommits.size !== 1) throw new Error("paired batch spans multiple source commits");
if (seeds.size !== 1) throw new Error("paired batch spans multiple randomization seeds");

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function stats(values) {
  return {
    median: quantile(values, 0.5),
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
const collect = (variant, selector) => pairs.map((pair) => selector(pair[variant]));
const pairedMetric = (selector) => ({
  baseline: stats(collect("baseline", selector)),
  c3: stats(collect("c3", selector)),
});
const fmt = (value) => value.toFixed(1);
const cellMs = (value) => `${fmt(value.median)} ms [${fmt(value.q1)}, ${fmt(value.q3)}]`;
const cellMib = (value) => `${(value.median / 1048576).toFixed(2)} MiB [${(value.q1 / 1048576).toFixed(2)}, ${(value.q3 / 1048576).toFixed(2)}]`;
const cellKib = (value) => `${(value.median / 1024).toFixed(1)} KiB [${(value.q1 / 1024).toFixed(1)}, ${(value.q3 / 1024).toFixed(1)}]`;

let metrics;
let markdown;
if (profile === "volume") {
  const m = (key) => pairedMetric((row) => row.measurement.timing[key]);
  const finalDb = pairedMetric((row) => row.measurement.storage.afterFrontInsert.databaseBytes);
  const editBlobs = pairedMetric((row) =>
    row.measurement.storage.afterEdits.uniqueBlobBytes -
    row.measurement.storage.afterCreate.uniqueBlobBytes
  );
  const prependBlobs = pairedMetric((row) =>
    row.measurement.storage.afterFrontInsert.uniqueBlobBytes -
    row.measurement.storage.afterEdits.uniqueBlobBytes
  );
  metrics = {
    createMs: m("createMs"),
    checkpointEditsMs: m("checkpointEditsMs"),
    frontInsertMs: m("frontInsertMs"),
    readMs: m("readMs"),
    editBlobGrowthBytes: editBlobs,
    prependBlobGrowthBytes: prependBlobs,
    finalDatabaseBytes: finalDb,
  };
  markdown = `# Paired Computer full-pipeline benchmark

**Benchmark layer:** full Computer E2E through upstream Workspace.runtime.exec().

**Protocol:** ${pairs.length} paired trials, randomized variant order, seed recorded in the result. Values are median [Q1, Q3] using linear-interpolated quartiles.

## Speed

**Evidence layer: full Computer E2E.**

| Operation | Computer baseline | C3 |
| --- | ---: | ---: |
| Initial 32 MiB creation | ${cellMs(metrics.createMs.baseline)} | ${cellMs(metrics.createMs.c3)} |
| 16 durable tiny edits | ${cellMs(metrics.checkpointEditsMs.baseline)} | ${cellMs(metrics.checkpointEditsMs.c3)} |
| 10-byte front insertion | ${cellMs(metrics.frontInsertMs.baseline)} | ${cellMs(metrics.frontInsertMs.c3)} |
| Full read and sync bracket | ${cellMs(metrics.readMs.baseline)} | ${cellMs(metrics.readMs.c3)} |

## Storage

**Evidence layer: full Computer E2E.**

| Metric | Computer baseline | C3 |
| --- | ---: | ---: |
| Tiny-edit blob growth | ${cellMib(metrics.editBlobGrowthBytes.baseline)} | ${cellMib(metrics.editBlobGrowthBytes.c3)} |
| Front-insert blob growth | ${cellMib(metrics.prependBlobGrowthBytes.baseline)} | ${cellMib(metrics.prependBlobGrowthBytes.c3)} |
| Final SQLite database | ${cellMib(metrics.finalDatabaseBytes.baseline)} | ${cellMib(metrics.finalDatabaseBytes.c3)} |
`;
} else {
  const disjoint = (row) => row.measurement.scenarios.disjoint;
  const m = (key) => pairedMetric((row) => disjoint(row).phases[key]);
  metrics = {
    pushMs: m("pushWallMs"),
    shellMs: m("shellWallMs"),
    pullMs: m("pullWallMs"),
    publishMs: m("publishWallMs"),
    totalMs: m("totalWallMs"),
    privateCowPagePayloadBytes: pairedMetric(
      (row) => disjoint(row).privateCowPagePayloadBytes,
    ),
    branchExclusivePayloadBytes: pairedMetric(
      (row) => disjoint(row).privateBranchExclusivePayloadBytes,
    ),
    branchDatabaseGrowthBytes: pairedMetric(
      (row) => disjoint(row).privateBranchDatabaseGrowthBytes,
    ),
  };
  markdown = `# Paired two-mount branch benchmark

**Benchmark layer:** full Computer E2E through the custom branch RPC adapter.

**Protocol:** ${pairs.length} paired trials, randomized variant order, seed recorded in the result. Values are median [Q1, Q3] using linear-interpolated quartiles.

## Speed

**Evidence layer: full Computer E2E.**

| Phase | Fixed-chunk | C3 |
| --- | ---: | ---: |
| Push two branch views | ${cellMs(metrics.pushMs.baseline)} | ${cellMs(metrics.pushMs.c3)} |
| Run two FUSE shell commands | ${cellMs(metrics.shellMs.baseline)} | ${cellMs(metrics.shellMs.c3)} |
| Pull two execution deltas | ${cellMs(metrics.pullMs.baseline)} | ${cellMs(metrics.pullMs.c3)} |
| Publish two branches | ${cellMs(metrics.publishMs.baseline)} | ${cellMs(metrics.publishMs.c3)} |
| Complete branch round | ${cellMs(metrics.totalMs.baseline)} | ${cellMs(metrics.totalMs.c3)} |

## Complete branch-exclusive storage

**Evidence layer: full Computer E2E.**

| Metric | Fixed-chunk | C3 |
| --- | ---: | ---: |
| Private COW-page payload | ${cellKib(metrics.privateCowPagePayloadBytes.baseline)} | ${cellKib(metrics.privateCowPagePayloadBytes.c3)} |
| Complete branch-exclusive content | ${cellMib(metrics.branchExclusivePayloadBytes.baseline)} | ${cellMib(metrics.branchExclusivePayloadBytes.c3)} |
| SQLite database growth | ${cellMib(metrics.branchDatabaseGrowthBytes.baseline)} | ${cellMib(metrics.branchDatabaseGrowthBytes.c3)} |
`;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  batchId,
  profile,
  benchmarkLayer: profile === "volume"
    ? "full Computer E2E (upstream Workspace.runtime.exec)"
    : "full Computer E2E (custom branch RPC adapter)",
  pairCount: pairs.length,
  randomizationSeed: pairs[0].baseline.benchmarkSeed,
  quartileMethod: "linear interpolation at (n - 1) * q",
  metrics,
  pairs: pairs.map(({ pairId, baseline, c3 }) => ({
    pairId,
    trial: baseline.trial,
    executionOrder: baseline.orderIndex < c3.orderIndex ? ["baseline", "c3"] : ["c3", "baseline"],
    baselineObject: baseline.objectName,
    c3Object: c3.objectName,
  })),
};
const stem = `paired-${profile}-latest`;
await writeFile(resolve(e2eRoot, `results/${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(e2eRoot, `results/${stem}.md`), markdown);
console.log(markdown);
