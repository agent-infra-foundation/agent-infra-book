import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.argv[2] ?? "./results/volume-latest.json");
const report = JSON.parse(await readFile(source, "utf8"));
const target = source.replace(/\.json$/i, ".md");
const naive = report.measurements.naive;
const optimized = report.measurements["cas-cdc-cow"];

const bytes = (value) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / 1024 / 1024).toFixed(value < 1024 * 1024 * 1024 ? 1 : 2)} MiB`;
};
const duration = (value) => value < 1000 ? `${value.toFixed(0)} ms` : `${(value / 1000).toFixed(2)} s`;
const less = (before, after) => `${Math.max(0, (1 - after / before) * 100).toFixed(1)}% less`;
const speed = (before, after) => after <= before
  ? `${(before / after).toFixed(2)}x faster`
  : `${(after / before).toFixed(2)}x slower`;
const naiveAmplification = naive.sqlitePayloadBytes / naive.storedAfterGcBytes;
const optimizedAmplification = optimized.sqlitePayloadBytes / optimized.storedAfterGcBytes;

const lines = [
  "# High-volume aggregate result",
  "",
  `One ${bytes(report.configuration.fileBytes)} workspace, ${report.configuration.totalOperations} checkpoints: ` +
    `${report.configuration.overwrites} tiny overwrites, ${report.configuration.prepends} front insertions, ` +
    `${report.configuration.fullRewrites} full rewrite.`,
  "",
  "**Evidence layer: engine.**",
  "",
  "| Aggregate metric | Naive | CAS+CDC+COW | Difference |",
  "| --- | ---: | ---: | ---: |",
  `| SQL payload written | ${bytes(naive.sqlitePayloadBytes)} | ${bytes(optimized.sqlitePayloadBytes)} | ${less(naive.sqlitePayloadBytes, optimized.sqlitePayloadBytes)} |`,
  `| Write amplification | ${naiveAmplification.toFixed(2)}x | ${optimizedAmplification.toFixed(2)}x | ${(naiveAmplification / optimizedAmplification).toFixed(2)}x lower |`,
  `| Retained growth before GC | ${bytes(naive.retainedGrowthBytes)} | ${bytes(optimized.retainedGrowthBytes)} | ${less(naive.retainedGrowthBytes, optimized.retainedGrowthBytes)} |`,
  `| SQLite database growth | ${bytes(naive.databaseGrowthBytes)} | ${bytes(optimized.databaseGrowthBytes)} | ${less(naive.databaseGrowthBytes, optimized.databaseGrowthBytes)} |`,
  `| Orphan payload before GC | ${bytes(naive.orphanBeforeGcBytes)} | ${bytes(optimized.orphanBeforeGcBytes)} | ${less(naive.orphanBeforeGcBytes, optimized.orphanBeforeGcBytes)} |`,
  `| Edit + publish time | ${duration(naive.elapsedMs)} | ${duration(optimized.elapsedMs)} | ${speed(naive.elapsedMs, optimized.elapsedMs)} |`,
  `| GC payload reclaimed | ${bytes(naive.gcReclaimedBytes)} | ${bytes(optimized.gcReclaimedBytes)} | Exact unreachable data |`,
  `| GC time | ${duration(naive.gcElapsedMs)} | ${duration(optimized.gcElapsedMs)} | ${speed(naive.gcElapsedMs, optimized.gcElapsedMs)} |`,
  `| Stored after GC | ${bytes(naive.storedAfterGcBytes)} | ${bytes(optimized.storedAfterGcBytes)} | Current workspace only |`,
  "",
  "> Aggregate values cover all 32 edit-and-publish operations. Initial seeding and final verification are outside the timed path.",
  "",
];

await writeFile(target, lines.join("\n"), "utf8");
console.log(target);
