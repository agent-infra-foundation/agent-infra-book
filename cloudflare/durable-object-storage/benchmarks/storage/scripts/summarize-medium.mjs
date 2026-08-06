import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const inputPath = resolve(process.argv[2]);
const outputRoot = resolve(process.argv[3]);
const inputBytes = readFileSync(inputPath);
const report = JSON.parse(inputBytes.toString("utf8"));
const byPhase = new Map(report.phases.map((entry) => [entry.phase, entry]));

const round = (value, digits = 3) =>
  value === null || value === undefined
    ? null
    : Math.round(value * 10 ** digits) / 10 ** digits;
const mib = (bytes) => round(bytes / 1024 / 1024, 3);
const ratio = (numerator, denominator) =>
  denominator === 0 ? null : round(numerator / denominator, 3);
const sum = (values) => values.reduce((total, value) => total + Number(value), 0);

function speedRow(label, phases) {
  const entries = phases.map((phase) => byPhase.get(phase));
  const nativeMs = sum(entries.map((entry) => entry.native.commandMs));
  const computerCommandMs = sum(entries.map((entry) => entry.computer.command.commandMs));
  const durableMs = sum(entries.map((entry) => entry.computer.timing.durableExecMs));
  const verificationMs = sum(entries.map((entry) => entry.computer.timing.verificationMs));
  return {
    operation: label,
    nativeCommandMs: round(nativeMs),
    computerFuseCommandMs: round(computerCommandMs),
    computerDurableExecMs: round(durableMs),
    verificationMs: round(verificationMs),
    fuseVsNative: ratio(computerCommandMs, nativeMs),
    durableVsNative: ratio(durableMs, nativeMs),
  };
}

const speed = [
  speedRow("Create 6,385 files / 274.8 MiB", ["initialize"]),
  speedRow("Recursive ls -lR", ["list"]),
  speedRow("Read all file content", ["read"]),
  speedRow("Duplicate tree", ["duplicate"]),
  speedRow("Overwrite 10 bytes once", ["edit-one"]),
  speedRow(
    "Overwrite 10 bytes five times / five execution brackets",
    [1, 2, 3, 4, 5].map((step) => `edit-separate-${step}`),
  ),
  speedRow("Overwrite 10 bytes five times / one execution bracket", ["edit-five-bracket"]),
  speedRow("Append 10 bytes", ["append"]),
  speedRow("Prepend 10 bytes to 32 MiB", ["prepend"]),
  speedRow("Delete duplicate tree", ["delete-copy"]),
  speedRow("Delete remaining tree", ["delete-all"]),
];

const storageStates = [
  ["Initial unique tree", "initialize"],
  ["Exact duplicate tree", "duplicate"],
  ["One 10-byte overwrite", "edit-one"],
  ["After five edits in separate execution brackets", "edit-separate-5"],
  ["After five edits in one execution bracket", "edit-five-bracket"],
  ["After 10-byte append", "append"],
  ["After 10-byte prepend", "prepend"],
  ["After deleting duplicate", "delete-copy"],
  ["After deleting all files", "delete-all"],
];

const space = storageStates.map(([state, phase]) => {
  const entry = byPhase.get(phase);
  const storage = entry.computer.verification.storage;
  return {
    state,
    phase,
    files: storage.fileCount,
    logicalMiB: mib(storage.logicalBytes),
    nativeAllocatedMiB: mib(entry.native.allocatedBytes),
    computerDatabaseMiB: mib(storage.databaseBytes),
    computerUniqueBlobMiB: mib(storage.uniqueBlobBytes),
    reachableBlobMiB: mib(storage.reachableBlobBytes),
    orphanBlobMiB: mib(storage.orphanedBlobBytes),
    workerdPersistMiB: mib(entry.workerdPersist.logicalBytes),
    databaseAmplification: ratio(storage.databaseBytes, storage.logicalBytes),
    payloadDedupRatio:
      storage.logicalBytes === 0 ? null : ratio(storage.logicalBytes, storage.uniqueBlobBytes),
    chunkReferences: storage.chunkReferenceCount,
    uniqueBlobs: storage.uniqueBlobCount,
  };
});

function uniqueBytes(phase) {
  return byPhase.get(phase).computer.verification.storage.uniqueBlobBytes;
}

const editAmplification = [
  {
    operation: "One 10-byte overwrite",
    userBytesWritten: 10,
    newUniqueBlobBytes: uniqueBytes("edit-one") - uniqueBytes("duplicate"),
  },
  {
    operation: "Five 10-byte overwrites / five execution brackets",
    userBytesWritten: 50,
    newUniqueBlobBytes: uniqueBytes("edit-separate-5") - uniqueBytes("edit-one"),
  },
  {
    operation: "Five 10-byte overwrites / one execution bracket",
    userBytesWritten: 50,
    newUniqueBlobBytes:
      uniqueBytes("edit-five-bracket") - uniqueBytes("edit-separate-5"),
  },
  {
    operation: "Append 10 bytes to aligned 1 MiB file",
    userBytesWritten: 10,
    newUniqueBlobBytes: uniqueBytes("append") - uniqueBytes("edit-five-bracket"),
  },
  {
    operation: "Prepend 10 bytes to 32 MiB file",
    userBytesWritten: 10,
    newUniqueBlobBytes: uniqueBytes("prepend") - uniqueBytes("append"),
  },
].map((row) => ({
  ...row,
  newUniqueBlobMiB: mib(row.newUniqueBlobBytes),
  amplification: ratio(row.newUniqueBlobBytes, row.userBytesWritten),
}));

const summary = {
  generatedAt: report.generatedAt,
  sourceResult: relative(outputRoot, inputPath).replaceAll("\\", "/"),
  sourceResultSha256: createHash("sha256").update(inputBytes).digest("hex"),
  computerCommit: report.computerCommit,
  packageSha256: report.packageSha256,
  wranglerRuntimeSource: report.wranglerRuntimeSource ?? null,
  runtimeVersions: report.runtimeVersions ?? null,
  environment: {
    ...report.environment,
    syncBatchPolicy:
      "ordinary create/duplicate classes use at most 40 hashes per bracket; " +
      "the single 32 MiB boundary-file bracket references 64",
  },
  corpus: report.corpus,
  speed,
  space,
  editAmplification,
};

const markdownNumber = (value, digits = 3) =>
  value === null ? "-" : Number(value).toFixed(digits);
const markdownRatio = (value, digits = 2) =>
  value === null ? "-" : `${Number(value).toFixed(digits)}x`;
const lines = [
  "# Native filesystem vs Cloudflare Computer: medium benchmark",
  "",
  `- Generated: ${summary.generatedAt}`,
  `- Computer commit: \`${summary.computerCommit}\``,
  `- Raw result SHA-256: \`${summary.sourceResultSha256}\``,
  `- Corpus: ${summary.corpus.fileCount.toLocaleString()} files, ${mib(summary.corpus.logicalBytes)} MiB`,
  `- Mount backend: real FUSE; cache policy: ${summary.environment.cachePolicy}`,
  `- Execution policy: ${summary.environment.executionPolicy}`,
  `- Bulk sync: ${summary.environment.syncBatchPolicy}`,
  "",
  "## Speed",
  "",
  "Verification is shown separately and is not included in Computer durable-exec time.",
  "",
  "| Operation | Native command ms | Computer FUSE command ms | Computer durable exec ms | FUSE/native | Durable/native |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...speed.map(
    (row) =>
      `| ${row.operation} | ${markdownNumber(row.nativeCommandMs)} | ${markdownNumber(row.computerFuseCommandMs)} | ${markdownNumber(row.computerDurableExecMs)} | ${markdownRatio(row.fuseVsNative)} | ${markdownRatio(row.durableVsNative)} |`,
  ),
  "",
  "## Space",
  "",
  "`Computer DB` is `DurableObjectStorage.sql.databaseSize`. `Workerd persisted` is the total logical size of the isolated local workerd persistence directory.",
  "",
  "| State | Files | Logical MiB | Native allocated MiB | Computer DB MiB | Unique blob MiB | Orphan MiB | Workerd persisted MiB | DB/logical | Logical/unique |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...space.map(
    (row) =>
      `| ${row.state} | ${row.files} | ${markdownNumber(row.logicalMiB)} | ${markdownNumber(row.nativeAllocatedMiB)} | ${markdownNumber(row.computerDatabaseMiB)} | ${markdownNumber(row.computerUniqueBlobMiB)} | ${markdownNumber(row.orphanBlobMiB)} | ${markdownNumber(row.workerdPersistMiB)} | ${markdownRatio(row.databaseAmplification)} | ${markdownRatio(row.payloadDedupRatio)} |`,
  ),
  "",
  "## Fixed-chunk edit amplification",
  "",
  "| Operation | User bytes written | New unique blob bytes | New unique blob MiB | Payload amplification |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...editAmplification.map(
    (row) =>
      `| ${row.operation} | ${row.userBytesWritten} | ${row.newUniqueBlobBytes} | ${markdownNumber(row.newUniqueBlobMiB)} | ${markdownNumber(row.amplification, 1)}x |`,
  ),
  "",
  "## Interpretation boundary",
  "",
  "These are local WSL2/workerd results. They exercise the pinned Computer implementation and a real FUSE mount, but not Cloudflare's production Container lifecycle, placement, network, or billing environment. Small files are stored at their actual length; 512 KiB is a maximum fixed chunk size, not a minimum allocation unit.",
  "",
];

const csv = (rows) => {
  const headers = Object.keys(rows[0]);
  const quote = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => quote(row[header])).join(","))
    .join("\n")}\n`;
};

writeFileSync(resolve(outputRoot, "medium-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(resolve(outputRoot, "medium-summary.md"), `${lines.join("\n")}\n`);
writeFileSync(resolve(outputRoot, "medium-speed.csv"), csv(speed));
writeFileSync(resolve(outputRoot, "medium-space.csv"), csv(space));
