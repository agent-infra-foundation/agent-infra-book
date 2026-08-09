import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.argv[2] ?? "./results/latest.json");
const report = JSON.parse(await readFile(source, "utf8"));
const target = source.replace(/\.json$/i, ".md");

const bytes = (value) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
};
const ms = (value) => `${value.toFixed(value < 10 ? 2 : 1)} ms`;
const ratio = (before, after) => before === 0
  ? "-"
  : `${Math.max(0, (1 - after / before) * 100).toFixed(1)}%`;
const speed = (naive, optimized) => optimized <= naive
  ? (naive / optimized < 1.1 ? "~same" : `${(naive / optimized).toFixed(2)}x faster`)
  : (optimized / naive < 1.1 ? "~same" : `${(optimized / naive).toFixed(2)}x slower`);
const pair = (measurement) => `${bytes(measurement.sqlitePayloadBytes)} / ${bytes(measurement.retainedGrowthBytes)}`;

const lines = [
  "# Naive vs CAS + CDC + COW - measured results",
  "",
  `Files: ${bytes(report.configuration.storageFileBytes)} for edit workloads; ${bytes(report.configuration.gcFileBytes)} for GC.`,
  "",
  "## 1. Storage - SQL payload written / payload retained",
  "",
  "**Evidence layer: engine.**",
  "",
  "| Workload | Naive | CAS+CDC+COW | Less written |",
  "| --- | ---: | ---: | ---: |",
  ...report.storage.map((row) =>
    `| ${row.label} | ${pair(row.naive)} | ${pair(row["cas-cdc-cow"])} | ${ratio(row.naive.sqlitePayloadBytes, row["cas-cdc-cow"].sqlitePayloadBytes)} |`
  ),
  "",
  "## 2. Edit + publish latency",
  "",
  "**Evidence layer: engine.**",
  "",
  "| Workload | Naive | CAS+CDC+COW | Change |",
  "| --- | ---: | ---: | ---: |",
  ...report.storage.map((row) =>
    `| ${row.label} | ${ms(row.naive.elapsedMs)} | ${ms(row["cas-cdc-cow"].elapsedMs)} | ${speed(row.naive.elapsedMs, row["cas-cdc-cow"].elapsedMs)} |`
  ),
  "",
  "## 3. Branch and multi-writer boundary",
  "",
  "**Evidence layer: engine.**",
  "",
  "| Scenario | Naive | CAS+CDC+COW | Result |",
  "| --- | ---: | ---: | --- |",
  `| Create branch | ${bytes(report.branches.naive.create.sqlitePayloadBytes)} | ${bytes(report.branches["cas-cdc-cow"].create.sqlitePayloadBytes)} | Metadata only |`,
  `| Private COW-page payload | ${bytes(report.branches.naive.privateEdit.privateCowPagePayloadBytes)} | ${bytes(report.branches["cas-cdc-cow"].privateEdit.privateCowPagePayloadBytes)} | C3 page overlay; fixed chunks use no COW pages |`,
  `| Complete branch-exclusive content | ${bytes(report.branches.naive.privateEdit.branchExclusiveContentBytes)} | ${bytes(report.branches["cas-cdc-cow"].privateEdit.branchExclusiveContentBytes)} | ${ratio(report.branches.naive.privateEdit.branchExclusiveContentBytes, report.branches["cas-cdc-cow"].privateEdit.branchExclusiveContentBytes)} less |`,
  `| SQLite growth with branch active | ${bytes(report.branches.naive.privateEdit.branchDatabaseGrowthBytes)} | ${bytes(report.branches["cas-cdc-cow"].privateEdit.branchDatabaseGrowthBytes)} | ${ratio(report.branches.naive.privateEdit.branchDatabaseGrowthBytes, report.branches["cas-cdc-cow"].privateEdit.branchDatabaseGrowthBytes)} less |`,
  `| Two writers, disjoint files | ${report.branches.naive.disjoint.filesCorrect}/2 survive | ${report.branches["cas-cdc-cow"].disjoint.filesCorrect}/2 survive | Both merge |`,
  `| Two writers, same file | ${report.branches.naive.sameFile.secondOutcome}; ${report.branches.naive.sameFile.lostUpdates} lost | ${report.branches["cas-cdc-cow"].sameFile.secondOutcome}; ${report.branches["cas-cdc-cow"].sameFile.lostUpdates} lost | Conflict is explicit |`,
  "",
  "## 4. Five checkpoints + GC",
  "",
  "**Evidence layer: engine.**",
  "",
  "| Metric | Naive | CAS+CDC+COW | Difference |",
  "| --- | ---: | ---: | ---: |",
  `| Stored before GC | ${bytes(report.gc.naive.storedBeforeBytes)} | ${bytes(report.gc["cas-cdc-cow"].storedBeforeBytes)} | ${ratio(report.gc.naive.storedBeforeBytes, report.gc["cas-cdc-cow"].storedBeforeBytes)} less |`,
  `| Orphan before GC | ${bytes(report.gc.naive.orphanBeforeBytes)} | ${bytes(report.gc["cas-cdc-cow"].orphanBeforeBytes)} | ${ratio(report.gc.naive.orphanBeforeBytes, report.gc["cas-cdc-cow"].orphanBeforeBytes)} less |`,
  `| Payload reclaimed | ${bytes(report.gc.naive.reclaimedBytes)} | ${bytes(report.gc["cas-cdc-cow"].reclaimedBytes)} | Exact unreachable data |`,
  `| GC time | ${ms(report.gc.naive.elapsedMs)} | ${ms(report.gc["cas-cdc-cow"].elapsedMs)} | ${speed(report.gc.naive.elapsedMs, report.gc["cas-cdc-cow"].elapsedMs)} |`,
  "",
  "> SQL payload written counts BLOB bytes submitted by the measured edit and publish operations. Payload retained counts content BLOB growth before GC; SQLite metadata and page-reservation overhead are available in `latest.json`.",
  "",
];

await writeFile(target, lines.join("\n"), "utf8");
console.log(target);
