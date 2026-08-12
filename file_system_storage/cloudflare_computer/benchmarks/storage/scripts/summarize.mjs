import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const input = process.argv[2];
if (!input) throw new Error("usage: node scripts/summarize.mjs <raw-result.json>");

const envelope = JSON.parse(fs.readFileSync(input, "utf8"));
const report = envelope.report;
const resultsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../results");

const rows = report.latency.map((row) => ({
  profile: report.profile,
  engine: row.engine,
  operation: row.operation,
  sizeBytes: row.sizeBytes,
  operationsPerSample: row.operationsPerSample,
  medianMs: row.summary.medianMs,
  p95Ms: row.summary.p95Ms,
  p99Ms: row.summary.p99Ms,
  throughputMiBPerSecond: row.summary.throughputMiBPerSecond ?? "",
}));

const csvColumns = Object.keys(rows[0] ?? {});
const csv = [
  csvColumns.join(","),
  ...rows.map((row) => csvColumns.map((column) => JSON.stringify(row[column] ?? "")).join(",")),
].join("\n");

const MiB = 1024 * 1024;
const mib = (bytes) => (bytes / MiB).toFixed(2);
const valueOrDash = (value, format = String) =>
  value === undefined || value === null ? "-" : format(value);

const editRows = report.editTransitions.map((row) => {
  const first = row.steps[0];
  const last = row.steps[row.steps.length - 1];
  return {
    engine: row.engine,
    variant: row.variant,
    logicalMiB: mib(last.storage.logicalBytes),
    databaseMiB: mib(last.storage.databaseBytes),
    databaseGrowthMiB: mib(last.storage.databaseBytes - first.storage.databaseBytes),
    orphanedMiB: valueOrDash(last.storage.orphanedBlobBytes, mib),
    uniqueBlobs: valueOrDash(last.storage.uniqueBlobCount),
    manifests: valueOrDash(last.storage.manifestCount),
    finalEditMs: last.durationMs.toFixed(4),
  };
});

const dedupRows = report.deduplication.map((row) => ({
  engine: row.engine,
  dataset: row.dataset,
  logicalMiB: mib(row.storageAfterWrite.logicalBytes),
  databaseMiB: mib(row.storageAfterWrite.databaseBytes),
  uniqueBlobMiB: valueOrDash(row.storageAfterWrite.uniqueBlobBytes, mib),
  databaseAfterDeleteMiB: mib(row.storageAfterDelete.databaseBytes),
  orphanedAfterDeleteMiB: valueOrDash(row.storageAfterDelete.orphanedBlobBytes, mib),
  medianWriteMs: row.summary.medianMs.toFixed(4),
}));

const directoryRows = report.directories.map((row) => ({
  engine: row.engine,
  entries: row.entryCount,
  createMs: row.createTotalMs.toFixed(4),
  listMs: row.listMs.toFixed(4),
  statMs: row.statMs.toFixed(4),
  deleteMs: row.deleteTotalMs.toFixed(4),
  databaseMiB: mib(row.storageAfterCreate.databaseBytes),
}));

const md = [
  "# Durable Object storage benchmark summary",
  "",
  `- Generated: ${report.generatedAt}`,
  `- Profile: ${report.profile}`,
  `- Computer commit: \`${envelope.provenance.sourceCommit}\``,
  `- Package SHA-256: \`${envelope.provenance.packageSha256}\``,
  `- Runtime: ${report.runtime}`,
  "",
  "| Engine | Operation | Bytes | Ops/sample | Median ms/op | p95 ms/op | p99 ms/op | MiB/s |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map(
    (row) =>
      `| ${row.engine} | ${row.operation} | ${row.sizeBytes} | ${row.operationsPerSample} | ${row.medianMs.toFixed(4)} | ${row.p95Ms.toFixed(4)} | ${row.p99Ms.toFixed(4)} | ${row.throughputMiBPerSecond === "" ? "-" : Number(row.throughputMiBPerSecond).toFixed(2)} |`,
  ),
  "",
  "## Five-write edit transitions",
  "",
  "Database growth is measured from the initial write to the fifth edit.",
  "",
  "| Engine | Variant | Logical MiB | Final DB MiB | DB growth MiB | Orphaned MiB | Unique blobs | Manifests | Fifth edit ms |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...editRows.map(
    (row) =>
      `| ${row.engine} | ${row.variant} | ${row.logicalMiB} | ${row.databaseMiB} | ${row.databaseGrowthMiB} | ${row.orphanedMiB} | ${row.uniqueBlobs} | ${row.manifests} | ${row.finalEditMs} |`,
  ),
  "",
  "## Ten-file deduplication datasets",
  "",
  "| Engine | Dataset | Logical MiB | DB MiB | Unique blob MiB | DB after delete MiB | Orphaned after delete MiB | Median write ms |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...dedupRows.map(
    (row) =>
      `| ${row.engine} | ${row.dataset} | ${row.logicalMiB} | ${row.databaseMiB} | ${row.uniqueBlobMiB} | ${row.databaseAfterDeleteMiB} | ${row.orphanedAfterDeleteMiB} | ${row.medianWriteMs} |`,
  ),
  "",
  "## Directory workloads",
  "",
  "| Engine | Entries | Create total ms | List ms | Stat ms | Delete total ms | DB MiB |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...directoryRows.map(
    (row) =>
      `| ${row.engine} | ${row.entries} | ${row.createMs} | ${row.listMs} | ${row.statMs} | ${row.deleteMs} | ${row.databaseMiB} |`,
  ),
  "",
  "These are local workerd measurements, not production-edge latency or billing data. Full samples and correctness records are preserved in `summary.json`.",
  "",
].join("\n");

fs.mkdirSync(resultsRoot, { recursive: true });
fs.writeFileSync(path.join(resultsRoot, "summary.json"), `${JSON.stringify(envelope, null, 2)}\n`);
fs.writeFileSync(path.join(resultsRoot, "summary.csv"), `${csv}\n`);
fs.writeFileSync(path.join(resultsRoot, "summary.md"), md);
