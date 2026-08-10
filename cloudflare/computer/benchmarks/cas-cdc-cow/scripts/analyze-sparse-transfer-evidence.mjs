import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sparseRunPaths = [
  "results/c3-sparse-transfer-recovery-formal-run-1.json",
  "results/c3-sparse-transfer-recovery-formal-run-2.json",
];
const rangeRunPaths = [
  "results/c3-range-recipe-recovery-formal-run-1.json",
  "results/c3-range-recipe-recovery-formal-run-2.json",
];
const sparseAnalysisPath = "results/c3-sparse-transfer-recovery-analysis.json";
const rangeAnalysisPath = "results/c3-range-recipe-recovery-analysis.json";
const sparseCsvPath = "results/c3-sparse-transfer-recovery-records.csv";
const rangeCsvPath = "results/c3-range-recipe-recovery-records.csv";
const sparseReportPath = "experiments/C3_NO_CACHE_SPARSE_TRANSFER_V05_RECOVERY_RESULTS.md";
const sparseReportCnPath = "experiments/C3_NO_CACHE_SPARSE_TRANSFER_V05_RECOVERY_RESULTS_CN.md";
const rangeReportPath = "experiments/C3_RANGE_RECIPE_V06R_RECOVERY_RESULTS.md";
const rangeReportCnPath = "experiments/C3_RANGE_RECIPE_V06R_RECOVERY_RESULTS_CN.md";
const manifestPath = "experiments/c3-no-cache-sparse-transfer-recovery/MANIFEST.json";

function canonicalTextBytes(bytes) {
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRun(path) {
  const bytes = canonicalTextBytes(readFileSync(resolve(root, path)));
  return { path, sha256: sha256(bytes), bytes: bytes.byteLength, data: JSON.parse(bytes) };
}

function writeText(path, text) {
  const absolute = resolve(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text.replaceAll("\r\n", "\n"), "utf8");
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : round(numerator / denominator);
}

function sum(rows, select) {
  return rows.reduce((total, row) => total + select(row), 0);
}

function percent(value, digits = 2) {
  return `${round(value * 100, digits)}%`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function flatten(run, runIndex, routes) {
  return run.data.results.flatMap((scenario) => routes.flatMap((route) => (
    scenario.routes[route].samples.map((sample, repeat) => ({
      run: runIndex + 1,
      scenarioId: scenario.id,
      accessShape: scenario.accessShape ?? "",
      fileBytes: scenario.fileBytes,
      pageCount: scenario.pageCount ?? scenario.dirtyPages,
      distribution: scenario.distribution,
      route,
      repeat: repeat + 1,
      ...sample,
    }))
  )));
}

function makeCsv(records) {
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return `${[
    headers.join(","),
    ...records.map((record) => headers.map((header) => csvCell(record[header] ?? "")).join(",")),
  ].join("\n")}\n`;
}

const sparseRuns = sparseRunPaths.map(readRun);
const rangeRuns = rangeRunPaths.map(readRun);
const sparseRoutes = ["full-materialization", "manifest-overlay-stream"];
const rangeRoutes = ["full-materialization", "full-recipe-stream", "range-recipe"];
const sparseRecords = sparseRuns.flatMap((run, index) => flatten(run, index, sparseRoutes));
const rangeRecords = rangeRuns.flatMap((run, index) => flatten(run, index, rangeRoutes));

function sparseRunSummary(run) {
  const rows = run.data.results;
  const fullMs = sum(rows, (row) => row.routes["full-materialization"].localMs);
  const sparseMs = sum(rows, (row) => row.routes["manifest-overlay-stream"].localMs);
  const maxHashRatio = Math.max(...rows.map((row) => (
    row.routes["manifest-overlay-stream"].hashedBytes / row.fileBytes
  )));
  const largeRows = rows.filter((row) => row.fileBytes === 16 * 1024 * 1024);
  const maxLargePeakRatio = Math.max(...largeRows.map((row) => (
    row.routes["manifest-overlay-stream"].peakAlgorithmicPayloadBytes / row.fileBytes
  )));
  const minReferencedRatio = Math.min(...rows.map((row) => (
    row.routes["manifest-overlay-stream"].referencedBytes / row.fileBytes
  )));
  return {
    capture: run.data.capture,
    fullMedianSumMs: round(fullMs, 3),
    sparseMedianSumMs: round(sparseMs, 3),
    sparseToFullLocalTimeRatio: ratio(sparseMs, fullMs),
    maxHashedByteRatio: round(maxHashRatio),
    maxLargeFileWorkingSetRatio: round(maxLargePeakRatio),
    minReferencedByteRatio: round(minReferencedRatio),
  };
}

const sparseRunSummaries = sparseRuns.map(sparseRunSummary);
const sparseHypotheses = {
  H1_correctness: {
    passed: sparseRecords.length === 288 && sparseRecords.every((row) => row.correctness),
    threshold: "288/288 formal executions exact",
    actual: sparseRecords.filter((row) => row.correctness).length,
  },
  H2_readOnly: {
    passed: sparseRecords.length === 288 && sparseRecords.every((row) => row.storageUnchanged),
    threshold: "288/288 storage fingerprints unchanged",
    actual: sparseRecords.filter((row) => row.storageUnchanged).length,
  },
  H3_noCompleteMaterialization: {
    passed: sparseRecords.filter((row) => row.route === "manifest-overlay-stream")
      .every((row) => row.completeFileMaterializations === 0),
    threshold: "zero complete logical-file materializations on sparse route",
  },
  H4_boundedIdentityWork: {
    passed: sparseRunSummaries.every((run) => run.maxHashedByteRatio <= 0.1),
    threshold: "hashed bytes <= 10% of file in every scenario/run",
    perRunMaxRatio: sparseRunSummaries.map((run) => run.maxHashedByteRatio),
  },
  H5_largeFileWorkingSet: {
    passed: sparseRunSummaries.every((run) => run.maxLargeFileWorkingSetRatio <= 0.05),
    threshold: "16 MiB sparse peak <= 5% of file in every scenario/run",
    perRunMaxRatio: sparseRunSummaries.map((run) => run.maxLargeFileWorkingSetRatio),
  },
  H6_honestColdPayload: {
    passed: sparseRecords.filter((row) => row.route === "manifest-overlay-stream")
      .every((row) => row.wirePayloadBytes === row.fileBytes),
    threshold: "cold wire payload equals file size; no cache credit",
  },
  H7_structuralReuse: {
    passed: sparseRunSummaries.every((run) => run.minReferencedByteRatio >= 0.9),
    threshold: "at least 90% referenced bytes in every scenario/run",
    perRunMinRatio: sparseRunSummaries.map((run) => run.minReferencedByteRatio),
  },
  H8_replicatedLocalDirection: {
    passed: sparseRunSummaries.every((run) => run.sparseToFullLocalTimeRatio <= 1.25),
    threshold: "sparse median-sum local time <= 1.25x full in each run",
    perRunRatio: sparseRunSummaries.map((run) => run.sparseToFullLocalTimeRatio),
  },
};

const sparseAnalysis = {
  schemaVersion: 1,
  experiment: "c3-no-cache-sparse-transfer-v0.5-recovery-formal",
  date: "2026-08-10",
  author: "Wang Runyuan",
  repositoryBaseRevision: sparseRuns[0].data.repositoryBaseRevision,
  recoveryNotice: sparseRuns[0].data.recoveryNotice,
  sourceRuns: sparseRuns.map(({ path, sha256: hash, bytes, data }) => ({
    path,
    sha256: hash,
    bytes,
    capture: data.capture,
    formalExecutions: data.configuration.formalExecutions,
  })),
  combinedFormalExecutions: sparseRecords.length,
  runSummaries: sparseRunSummaries,
  hypotheses: sparseHypotheses,
  allPassed: Object.values(sparseHypotheses).every((item) => item.passed),
  interpretationLimits: [
    "cold wire payload remains one complete file because no receiver cache is assumed",
    "local timing excludes RPC, network, FUSE, native disk, concurrency, and production workload weighting",
    "the prototype handles only patch-free equal-length COW branches",
    "no production, three-dimensional, or neural-network claim",
  ],
};
writeJson(sparseAnalysisPath, sparseAnalysis);
writeText(sparseCsvPath, makeCsv(sparseRecords));

function rangeRunSummary(run) {
  const rows = run.data.results;
  const sparseShapes = new Set(run.data.configuration.sparseAccessShapes);
  const sparseRows = rows.filter((row) => sparseShapes.has(row.accessShape));
  const quarterRows = rows.filter((row) => row.accessShape === "quarter-sequential");
  const fullRows = rows.filter((row) => row.accessShape === "full-sequential");
  const nonFullRows = rows.filter((row) => row.accessShape !== "full-sequential");
  const fileTotal = (selected) => sum(selected, (row) => row.fileBytes);
  const routePayload = (selected, route) => sum(selected, (row) => row.routes[route].payloadBytes);
  const rangeAllFileBytes = fileTotal(rows);
  const rangeHashBytes = sum(rows, (row) => row.routes["range-recipe"].planningHashedBytes);
  const sparseFullMs = sum(sparseRows, (row) => row.routes["full-materialization"].localMs);
  const sparseRangeMs = sum(sparseRows, (row) => row.routes["range-recipe"].localMs);
  return {
    capture: run.data.capture,
    sparsePayloadRatio: ratio(routePayload(sparseRows, "range-recipe"), fileTotal(sparseRows)),
    quarterPayloadRatio: ratio(routePayload(quarterRows, "range-recipe"), fileTotal(quarterRows)),
    fullPayloadRatio: ratio(routePayload(fullRows, "range-recipe"), fileTotal(fullRows)),
    planningHashedByteRatio: ratio(rangeHashBytes, rangeAllFileBytes),
    maxWorkingSetRatio: round(Math.max(...rows.map((row) => (
      row.routes["range-recipe"].peakAlgorithmicPayloadBytes / row.fileBytes
    )))),
    nonFullPayloadSpecificity: nonFullRows.every((row) => (
      row.routes["range-recipe"].payloadBytes < row.routes["full-recipe-stream"].payloadBytes
    )),
    rangeObjectReadCount: sum(rows, (row) => row.routes["range-recipe"].objectRangeReadCount),
    fullSequentialObjectReadCount: sum(
      fullRows,
      (row) => row.routes["range-recipe"].objectRangeReadCount,
    ),
    sparseFullMedianSumMs: round(sparseFullMs, 3),
    sparseRangeMedianSumMs: round(sparseRangeMs, 3),
    sparseLocalTimeRatio: ratio(sparseRangeMs, sparseFullMs),
  };
}

const rangeRunSummaries = rangeRuns.map(rangeRunSummary);
const rangeHypotheses = {
  H1_correctness: {
    passed: rangeRecords.length === 270 && rangeRecords.every((row) => row.correctness),
    threshold: "270/270 formal executions exact",
    actual: rangeRecords.filter((row) => row.correctness).length,
  },
  H2_readOnly: {
    passed: rangeRecords.length === 270 && rangeRecords.every((row) => row.storageUnchanged),
    threshold: "270/270 storage fingerprints unchanged",
    actual: rangeRecords.filter((row) => row.storageUnchanged).length,
  },
  H3_noCompleteMaterialization: {
    passed: rangeRecords.filter((row) => row.route === "range-recipe")
      .every((row) => row.completeFileMaterializations === 0),
    threshold: "zero complete logical-file materializations on range-recipe route",
  },
  H4_sparsePayload: {
    passed: rangeRunSummaries.every((run) => run.sparsePayloadRatio <= 0.02),
    threshold: "three sparse shapes <= 2% aggregate payload in each run",
    perRunRatio: rangeRunSummaries.map((run) => run.sparsePayloadRatio),
  },
  H5_quarterPayload: {
    passed: rangeRunSummaries.every((run) => run.quarterPayloadRatio <= 0.26),
    threshold: "quarter access <= 26% aggregate payload in each run",
    perRunRatio: rangeRunSummaries.map((run) => run.quarterPayloadRatio),
  },
  H6_fullAccessOverhead: {
    passed: rangeRunSummaries.every((run) => run.fullPayloadRatio <= 1.01),
    threshold: "full access <= 101% aggregate payload in each run",
    perRunRatio: rangeRunSummaries.map((run) => run.fullPayloadRatio),
  },
  H7_boundedIdentityWork: {
    passed: rangeRunSummaries.every((run) => run.planningHashedByteRatio <= 0.01),
    threshold: "planning hashed bytes <= 1% aggregate file bytes in each run",
    perRunRatio: rangeRunSummaries.map((run) => run.planningHashedByteRatio),
  },
  H8_boundedWorkingSet: {
    passed: rangeRunSummaries.every((run) => run.maxWorkingSetRatio <= 0.25),
    threshold: "range-recipe peak <= 25% of file in every scenario/run",
    perRunMaxRatio: rangeRunSummaries.map((run) => run.maxWorkingSetRatio),
  },
  H9_rangeSpecificity: {
    passed: rangeRunSummaries.every((run) => run.nonFullPayloadSpecificity),
    threshold: "range payload < full-recipe payload in every non-full scenario/run",
  },
  H10_actualCasRangeReads: {
    passed: rangeRunSummaries.every((run) => run.rangeObjectReadCount > 0),
    threshold: "at least one CAS object-range query in each run",
    perRunCount: rangeRunSummaries.map((run) => run.rangeObjectReadCount),
  },
  H11_replicatedSparseLocalDirection: {
    passed: rangeRunSummaries.every((run) => run.sparseLocalTimeRatio < 1),
    threshold: "sparse-shape range local median sum < full materialization in each run",
    perRunRatio: rangeRunSummaries.map((run) => run.sparseLocalTimeRatio),
  },
};

const rangeAnalysis = {
  schemaVersion: 1,
  experiment: "c3-no-cache-range-recipe-v0.6R-recovery-formal",
  date: "2026-08-10",
  author: "Wang Runyuan",
  repositoryBaseRevision: rangeRuns[0].data.repositoryBaseRevision,
  recoveryNotice: rangeRuns[0].data.recoveryNotice,
  sourceRuns: rangeRuns.map(({ path, sha256: hash, bytes, data }) => ({
    path,
    sha256: hash,
    bytes,
    capture: data.capture,
    formalExecutions: data.configuration.formalExecutions,
  })),
  combinedFormalExecutions: rangeRecords.length,
  runSummaries: rangeRunSummaries,
  hypotheses: rangeHypotheses,
  allPassed: Object.values(rangeHypotheses).every((item) => item.passed),
  interpretationLimits: [
    "payload ratios are deterministic mechanism accounting, not measured network throughput",
    "full sequential demand intentionally approaches one complete file of payload",
    "local timing excludes RPC, network, FUSE, native disk, concurrency, and production workload weighting",
    "no persistent receiver cache, production, three-dimensional, or neural-network claim",
  ],
};
writeJson(rangeAnalysisPath, rangeAnalysis);
writeText(rangeCsvPath, makeCsv(rangeRecords));

function decisionsTable(hypotheses) {
  return Object.entries(hypotheses).map(([name, item]) => (
    `| ${name} | ${item.passed ? "PASS" : "FAIL"} | ${item.threshold} |`
  )).join("\n");
}

const sparseLatest = sparseRunSummaries[1];
writeText(sparseReportPath, `# C3 no-cache sparse transfer v0.5 — recovery results

Date: 2026-08-10
Author: Wang Runyuan
Base revision: \`${sparseAnalysis.repositoryBaseRevision}\`

## Outcome

Both frozen formal recovery runs passed H1–H8. Across 288 formal executions,
all 288 reconstructed the expected bytes and all 288 preserved the persistent
storage fingerprint. The sparse route reported zero complete logical-file
materializations.

In formal run 2, the sum of per-scenario median local time was
${sparseLatest.sparseMedianSumMs} ms for the sparse stream and
${sparseLatest.fullMedianSumMs} ms for full materialization
(${percent(sparseLatest.sparseToFullLocalTimeRatio)}). The largest identity-work
ratio was ${percent(sparseLatest.maxHashedByteRatio)}; the largest 16 MiB
algorithmic working-set ratio was ${percent(sparseLatest.maxLargeFileWorkingSetRatio)};
and every recipe referenced at least ${percent(sparseLatest.minReferencedByteRatio)}
of logical bytes.

Cold wire payload remained exactly one file. This route removes complete-file
materialization and bounds working memory; it does not save cold network bytes.

## Frozen decisions

| Check | Decision | Frozen threshold |
| --- | --- | --- |
${decisionsTable(sparseHypotheses)}

## Raw evidence

${sparseAnalysis.sourceRuns.map((run) => `- \`${run.path}\`: \`${run.sha256}\``).join("\n")}

## Interpretation limits

${sparseAnalysis.interpretationLimits.map((item) => `- ${item}`).join("\n")}

The original unpushed raw files were lost during workspace maintenance. These
are fresh, prospectively frozen recovery reruns and are not represented as the
lost original bytes.
`);

writeText(sparseReportCnPath, `# C3 无缓存稀疏传输 v0.5——恢复重跑结果

日期：2026-08-10
作者：Wang Runyuan
基线：\`${sparseAnalysis.repositoryBaseRevision}\`

## 结论

冻结后的两轮正式恢复实验全部通过 H1–H8。288 次正式执行全部逐字节正确，
288 次读取前后存储指纹全部不变；稀疏路线没有一次完整逻辑文件物化。

第二轮中，12 个场景的中位本地时间相加：稀疏流为
${sparseLatest.sparseMedianSumMs} ms，完整物化为
${sparseLatest.fullMedianSumMs} ms，比例为
${percent(sparseLatest.sparseToFullLocalTimeRatio)}。最坏场景只需对
${percent(sparseLatest.maxHashedByteRatio)} 的文件字节做新身份工作；16 MiB
场景的最大算法工作集为文件的
${percent(sparseLatest.maxLargeFileWorkingSetRatio)}；每个配方至少引用
${percent(sparseLatest.minReferencedByteRatio)} 的原有字节。

大白话：它能像“旧积木引用 + 改过的小块”那样顺序输出，不先拼一份完整
文件。但在完全冷、没有缓存的接收端，网络上仍要收到一整个文件，不能把
它宣传成冷传输省流量。

## 冻结判定

| 检查 | 结果 | 冻结门槛 |
| --- | --- | --- |
${decisionsTable(sparseHypotheses)}

## 原始数据哈希

${sparseAnalysis.sourceRuns.map((run) => `- \`${run.path}\`：\`${run.sha256}\``).join("\n")}

原来未推送分支的原始文件被工作区维护清理；本报告只使用重新冻结后产生的
新正式数据，不冒充丢失的原始文件。
`);

const rangeLatest = rangeRunSummaries[1];
writeText(rangeReportPath, `# C3 no-cache range recipe v0.6R — recovery results

Date: 2026-08-10
Author: Wang Runyuan
Base revision: \`${rangeAnalysis.repositoryBaseRevision}\`

## Outcome

Both frozen formal recovery runs passed H1–H11. Across 270 formal executions,
all 270 returned exact requested bytes and all 270 preserved the persistent
storage fingerprint. The range-recipe route never materialized a complete
logical file internally.

Formal run 2 produced these deterministic payload ratios:

- three sparse access shapes: ${percent(rangeLatest.sparsePayloadRatio)} of full transfer;
- quarter-file access: ${percent(rangeLatest.quarterPayloadRatio)};
- full sequential access: ${percent(rangeLatest.fullPayloadRatio)};
- recipe-planning identity work: ${percent(rangeLatest.planningHashedByteRatio)} of file bytes.

The maximum algorithm-owned working set was
${Math.round(Math.max(...rangeRuns[1].data.results.map((row) => row.routes["range-recipe"].peakAlgorithmicPayloadBytes)) / 1024)} KiB.
Full sequential range reads issued ${rangeLatest.fullSequentialObjectReadCount}
local CAS object-range queries across the three workloads. Sparse-shape local
median time summed to ${rangeLatest.sparseRangeMedianSumMs} ms versus
${rangeLatest.sparseFullMedianSumMs} ms for full materialization.

## Frozen decisions

| Check | Decision | Frozen threshold |
| --- | --- | --- |
${decisionsTable(rangeHypotheses)}

## Raw evidence

${rangeAnalysis.sourceRuns.map((run) => `- \`${run.path}\`: \`${run.sha256}\``).join("\n")}

## Interpretation limits

${rangeAnalysis.interpretationLimits.map((item) => `- ${item}`).join("\n")}

The benefit is specific to partial demand. Full sequential demand correctly
returns to approximately one file of payload. The result supports a larger
Computer-path prototype; it is not itself a production optimization claim.
`);

writeText(rangeReportCnPath, `# C3 无缓存区间配方 v0.6R——恢复重跑结果

日期：2026-08-10
作者：Wang Runyuan
基线：\`${rangeAnalysis.repositoryBaseRevision}\`

## 结论

冻结后的两轮正式恢复实验全部通过 H1–H11。270 次正式执行全部返回正确
字节，270 次读取前后存储指纹全部不变；按区间配方路线从未在内部物化完整
逻辑文件。

第二轮的确定性负载比例：

- 三种稀疏读取合计：完整传输的 ${percent(rangeLatest.sparsePayloadRatio)}；
- 连续读取四分之一文件：${percent(rangeLatest.quarterPayloadRatio)}；
- 顺序读取完整文件：${percent(rangeLatest.fullPayloadRatio)}；
- 配方规划需要处理的新身份字节：文件字节的 ${percent(rangeLatest.planningHashedByteRatio)}。

最大算法工作集约为
${Math.round(Math.max(...rangeRuns[1].data.results.map((row) => row.routes["range-recipe"].peakAlgorithmicPayloadBytes)) / 1024)} KiB。
三个完整读取场景合计发出 ${rangeLatest.fullSequentialObjectReadCount} 次本地
CAS 对象区间查询。三种稀疏读取的本地中位时间合计为
${rangeLatest.sparseRangeMedianSumMs} ms，完整物化为
${rangeLatest.sparseFullMedianSumMs} ms。

大白话：真正省下来的不是“把旧文件压缩得更神奇”，而是消费者只要几小段
时，配方能让系统只去拿那几小段。消费者要整文件时，负载就老老实实回到
约 100%，这反而说明记账没有作弊。

## 冻结判定

| 检查 | 结果 | 冻结门槛 |
| --- | --- | --- |
${decisionsTable(rangeHypotheses)}

## 原始数据哈希

${rangeAnalysis.sourceRuns.map((run) => `- \`${run.path}\`：\`${run.sha256}\``).join("\n")}

这是引擎层、本地 SQLite、合成负载的机制证据，不等于完整 Computer、FUSE、
网络或生产工作负载加速结论。
`);

const inventoryPaths = [
  "package.json",
  "src/engines/cas-cdc-cow.ts",
  "src/tests/sparse-transfer.test.ts",
  "src/bench/sparse-transfer.bench.ts",
  "src/bench/range-recipe.bench.ts",
  "scripts/run-sparse-transfer.mjs",
  "scripts/run-range-recipe.mjs",
  "scripts/analyze-sparse-transfer-evidence.mjs",
  "scripts/verify-sparse-transfer-evidence.mjs",
  "experiments/C3_NO_CACHE_SPARSE_TRANSFER_V05_RECOVERY.md",
  "experiments/C3_RANGE_RECIPE_V06R_RECOVERY.md",
  sparseReportPath,
  sparseReportCnPath,
  rangeReportPath,
  rangeReportCnPath,
  ...sparseRunPaths,
  ...rangeRunPaths,
  sparseAnalysisPath,
  rangeAnalysisPath,
  sparseCsvPath,
  rangeCsvPath,
];

const manifest = {
  schemaVersion: 1,
  experiment: "c3-no-cache-sparse-transfer-and-range-recipe-recovery",
  date: "2026-08-10",
  author: "Wang Runyuan",
  repositoryBaseRevision: sparseAnalysis.repositoryBaseRevision,
  recoveryNotice: sparseAnalysis.recoveryNotice,
  formalExecutions: {
    sparseTransfer: sparseAnalysis.combinedFormalExecutions,
    rangeRecipe: rangeAnalysis.combinedFormalExecutions,
    total: sparseAnalysis.combinedFormalExecutions + rangeAnalysis.combinedFormalExecutions,
  },
  hypotheses: {
    sparseTransfer: Object.fromEntries(
      Object.entries(sparseHypotheses).map(([name, item]) => [name, item.passed]),
    ),
    rangeRecipe: Object.fromEntries(
      Object.entries(rangeHypotheses).map(([name, item]) => [name, item.passed]),
    ),
  },
  rawSha256: Object.fromEntries([
    ...sparseAnalysis.sourceRuns,
    ...rangeAnalysis.sourceRuns,
  ].map((run) => [run.path, run.sha256])),
  inventory: inventoryPaths.map((path) => {
    const bytes = canonicalTextBytes(readFileSync(resolve(root, path)));
    return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }),
};
writeJson(manifestPath, manifest);

process.stdout.write(`${JSON.stringify({
  sparseAnalysisPath,
  rangeAnalysisPath,
  manifestPath,
  sparseAllPassed: sparseAnalysis.allPassed,
  rangeAllPassed: rangeAnalysis.allPassed,
  formalExecutions: manifest.formalExecutions,
  rawSha256: manifest.rawSha256,
}, null, 2)}\n`);
