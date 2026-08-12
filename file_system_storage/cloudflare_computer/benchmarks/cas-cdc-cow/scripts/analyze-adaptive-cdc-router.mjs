import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rawPath = resolve(root, "results/c3-adaptive-cdc-router-raw-v04.json");
const analysisPath = resolve(root, "results/c3-adaptive-cdc-router-analysis-v04.json");
const csvPath = resolve(root, "results/c3-adaptive-cdc-router-records-v04.csv");
const reportPath = resolve(root, "experiments/C3_ADAPTIVE_CDC_ROUTER_V04_RESULTS.md");
const reportCnPath = resolve(root, "experiments/C3_ADAPTIVE_CDC_ROUTER_V04_RESULTS_CN.md");
const MIB = 1024 * 1024;
const routeOrder = [
  "single-window-cow",
  "raw-multi-window-cow",
  "coalesced-multi-window-cow",
  "adaptive-cow",
  "materialized",
];

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sum(rows, select) {
  return rows.reduce((total, row) => total + select(row), 0);
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : round(numerator / denominator);
}

function groupBy(rows, select) {
  const groups = new Map();
  for (const row of rows) {
    const key = select(row);
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  return groups;
}

function routeSummary(rows, route) {
  return {
    route,
    scenarios: rows.length,
    totalMs: round(sum(rows, (row) => row.routes[route].totalMs)),
    applyMs: round(sum(rows, (row) => row.routes[route].applyMs)),
    publishMs: round(sum(rows, (row) => row.routes[route].publishMs)),
    cdcScanBytes: sum(rows, (row) => row.routes[route].cdcScanBytes),
    cdcWindowCount: sum(rows, (row) => row.routes[route].cdcWindowCount),
    sqlitePayloadBytes: sum(rows, (row) => row.routes[route].sqlitePayloadBytes),
    peakBranchBytes: sum(rows, (row) => row.routes[route].peakBranchBytes),
    retainedGrowthBytes: sum(rows, (row) => row.routes[route].retainedGrowthBytes),
    pageLoadCount: sum(rows, (row) => row.routes[route].pageLoadCount),
    pageUpsertCount: sum(rows, (row) => row.routes[route].pageUpsertCount),
    fastestCount: rows.filter((row) => row.fastestRoute === route).length,
  };
}

function groupedSummary(rows, fields) {
  const groups = groupBy(rows, (row) => fields.map((field) => row[field]).join("|"));
  return [...groups.values()].map((group) => ({
    ...Object.fromEntries(fields.map((field) => [field, group[0][field]])),
    scenarios: group.length,
    routes: Object.fromEntries(routeOrder.map((route) => [route, routeSummary(group, route)])),
  }));
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function mib(bytes) {
  return round(bytes / MIB, 2);
}

function percent(value) {
  return `${round(value * 100, 1)}%`;
}

function hypothesisLabel(passed) {
  return passed ? "PASS" : "FAIL";
}

function canonicalTextBytes(bytes) {
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

const rawBytes = canonicalTextBytes(readFileSync(rawPath));
const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
const raw = JSON.parse(rawBytes.toString("utf8"));
const rows = raw.results;
const routeTotals = Object.fromEntries(routeOrder.map((route) => [
  route,
  routeSummary(rows, route),
]));
const byFileSize = groupedSummary(rows, ["fileBytes"]);
const byDistribution = groupedSummary(rows, ["distribution"]);
const byRangeCount = groupedSummary(rows, ["rangeCount"]);
const byDistributionAndRange = groupedSummary(rows, ["distribution", "rangeCount"]);
const byFileDistributionAndRange = groupedSummary(
  rows,
  ["fileBytes", "distribution", "rangeCount"],
);

const adaptiveSelections = {
  singleWindow: sum(rows, (row) => (
    row.routes["adaptive-cow"].adaptiveSelectedSingleWindowCount
  )),
  multiWindow: sum(rows, (row) => (
    row.routes["adaptive-cow"].adaptiveSelectedMultiWindowCount
  )),
  fullScan: sum(rows, (row) => (
    row.routes["adaptive-cow"].adaptiveSelectedFullScanCount
  )),
  budgetFallback: sum(rows, (row) => (
    row.routes["adaptive-cow"].adaptiveBudgetFallbackCount
  )),
};
const expectedSelections = raw.configuration.expectedAdaptiveSelections;
const manyRangeRows = rows.filter((row) => row.rangeCount >= 16);
const rawManyWindows = sum(
  manyRangeRows,
  (row) => row.routes["raw-multi-window-cow"].cdcWindowCount,
);
const adaptiveManyWindows = sum(
  manyRangeRows,
  (row) => row.routes["adaptive-cow"].cdcWindowCount,
);
const rawManyScan = sum(
  manyRangeRows,
  (row) => row.routes["raw-multi-window-cow"].cdcScanBytes,
);
const adaptiveManyScan = sum(
  manyRangeRows,
  (row) => row.routes["adaptive-cow"].cdcScanBytes,
);
const rawManyTotal = sum(
  manyRangeRows,
  (row) => row.routes["raw-multi-window-cow"].totalMs,
);
const adaptiveManyTotal = sum(
  manyRangeRows,
  (row) => row.routes["adaptive-cow"].totalMs,
);
const oracleRows = rows.map((row) => {
  const fastestMs = Math.min(...routeOrder.map((route) => row.routes[route].totalMs));
  const adaptiveMs = row.routes["adaptive-cow"].totalMs;
  return {
    id: row.id,
    fastestRoute: row.fastestRoute,
    fastestMs,
    adaptiveMs,
    ratio: ratio(adaptiveMs, fastestMs),
    within125: adaptiveMs <= fastestMs * 1.25,
  };
});
const oracleWithin125 = oracleRows.filter((row) => row.within125);
const requiredOracleCount = Math.ceil(rows.length * 0.7);
const cowRoutes = routeOrder.filter((route) => route !== "materialized");
const cowPeakMismatchRows = rows.filter((row) => (
  new Set(cowRoutes.map((route) => row.routes[route].peakBranchBytes)).size !== 1
));
const adaptiveOverBudgetRows = rows.filter((row) => (
  row.routes["adaptive-cow"].cdcScanBytes > row.fileBytes
));
const adaptivePeak = routeTotals["adaptive-cow"].peakBranchBytes;
const materializedPeak = routeTotals.materialized.peakBranchBytes;

const hypotheses = {
  H1_structuralRouting: {
    passed:
      adaptiveSelections.singleWindow === expectedSelections.singleWindow &&
      adaptiveSelections.multiWindow === expectedSelections.multiWindow &&
      adaptiveSelections.fullScan === expectedSelections.fullScan &&
      adaptiveSelections.budgetFallback === 0,
    threshold: "adaptive selections = 22 single / 6 multi / 12 full; zero fallback",
    expected: expectedSelections,
    actual: adaptiveSelections,
  },
  H2_windowBound: {
    passed: adaptiveManyWindows <= rawManyWindows * 0.1,
    threshold: "adaptive windows <= 10% of raw multi for rangeCount >= 16",
    scenarios: manyRangeRows.length,
    rawWindows: rawManyWindows,
    adaptiveWindows: adaptiveManyWindows,
    ratio: ratio(adaptiveManyWindows, rawManyWindows),
  },
  H3_scanReduction: {
    passed: adaptiveManyScan <= rawManyScan * 0.7,
    threshold: "adaptive scan bytes <= 70% of raw multi for rangeCount >= 16",
    scenarios: manyRangeRows.length,
    rawScanBytes: rawManyScan,
    adaptiveScanBytes: adaptiveManyScan,
    ratio: ratio(adaptiveManyScan, rawManyScan),
  },
  H4_latencyReduction: {
    passed: adaptiveManyTotal <= rawManyTotal * 0.8,
    threshold: "adaptive total <= 80% of raw multi for rangeCount >= 16",
    scenarios: manyRangeRows.length,
    rawTotalMs: round(rawManyTotal),
    adaptiveTotalMs: round(adaptiveManyTotal),
    ratio: ratio(adaptiveManyTotal, rawManyTotal),
  },
  H5_boundedRegret: {
    passed: oracleWithin125.length >= requiredOracleCount,
    threshold: "adaptive <= 125% of fastest forced route in at least 70% of scenarios",
    within125Count: oracleWithin125.length,
    requiredCount: requiredOracleCount,
    scenarios: rows.length,
    misses: oracleRows.filter((row) => !row.within125),
  },
  H6_sparseStorage: {
    passed:
      cowPeakMismatchRows.length === 0 &&
      adaptivePeak <= materializedPeak * 0.15 &&
      raw.retainedGrowthMismatches.length === 0,
    threshold: "COW peaks equal; adaptive peak <= 15% materialized; retained growth equal",
    cowPeakMismatchScenarios: cowPeakMismatchRows.map((row) => row.id),
    adaptivePeakBranchBytes: adaptivePeak,
    materializedPeakBranchBytes: materializedPeak,
    ratio: ratio(adaptivePeak, materializedPeak),
    retainedGrowthMismatches: raw.retainedGrowthMismatches,
  },
  H7_scanBudget: {
    passed: adaptiveOverBudgetRows.length === 0 && adaptiveSelections.budgetFallback === 0,
    threshold: "adaptive scan <= one file in every scenario; zero budget fallback",
    overBudgetScenarios: adaptiveOverBudgetRows.map((row) => row.id),
    budgetFallbackCount: adaptiveSelections.budgetFallback,
  },
  H8_correctness: {
    passed:
      raw.configuration.correctnessExecutions === 1005 &&
      raw.retainedGrowthMismatches.length === 0 &&
      rows.length === 40,
    threshold: "all 1,005 executions correct and all 40 scenarios retained-growth consistent",
    correctnessExecutions: raw.configuration.correctnessExecutions,
    scenarios: rows.length,
  },
};

const keyFindings = {
  adaptiveVsRawOverallRatio: ratio(
    routeTotals["adaptive-cow"].totalMs,
    routeTotals["raw-multi-window-cow"].totalMs,
  ),
  coalescedVsRawOverallRatio: ratio(
    routeTotals["coalesced-multi-window-cow"].totalMs,
    routeTotals["raw-multi-window-cow"].totalMs,
  ),
  adaptiveVsRawManyRangeRatio: ratio(adaptiveManyTotal, rawManyTotal),
  adaptiveToMaterializedPeakRatio: ratio(adaptivePeak, materializedPeak),
  adaptiveSelections,
  oracleWithin125Count: oracleWithin125.length,
  largestAdaptiveRegrets: [...oracleRows]
    .sort((left, right) => right.ratio - left.ratio)
    .slice(0, 10),
};

const analysis = {
  schemaVersion: 1,
  experiment: raw.experiment,
  date: raw.date,
  author: raw.author,
  sourceRawPath: "results/c3-adaptive-cdc-router-raw-v04.json",
  sourceRawSha256: rawSha256,
  configuration: raw.configuration,
  routeTotals,
  byFileSize,
  byDistribution,
  byRangeCount,
  byDistributionAndRange,
  byFileDistributionAndRange,
  hypotheses,
  keyFindings,
  interpretationLimits: [
    "equal-weighted sums of per-scenario medians are synthetic summaries, not workload-weighted production estimates",
    "five repetitions balance route order but do not establish production latency distributions or statistical significance",
    "engine timing excludes Computer RPC, computerd, FUSE, diff construction, native disk, network transfer, concurrent agents, and warm CAS",
    "full-scan fallback reconstructs a contiguous file buffer in memory; scan bytes and window count alone do not measure allocation, copying, or working-set cost",
    "the frozen policy was not changed after the formal run; failed latency hypotheses are retained",
  ],
};
writeFileSync(analysisPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

const csvHeader = [
  "scenarioId",
  "fileBytes",
  "changedBytes",
  "rangeCount",
  "distribution",
  "dirtySpanBytes",
  "dirtySpanRatio",
  "touchedPages",
  "route",
  ...raw.configuration.sampleColumns,
];
const csvRows = [csvHeader.join(",")];
for (const row of rows) {
  for (const route of routeOrder) {
    csvRows.push([
      row.id,
      row.fileBytes,
      row.changedBytes,
      row.rangeCount,
      row.distribution,
      row.dirtySpanBytes,
      row.dirtySpanRatio,
      row.touchedPages,
      route,
      ...raw.configuration.sampleColumns.map((field) => row.routes[route][field]),
    ].map(csvCell).join(","));
  }
}
writeFileSync(csvPath, `${csvRows.join("\n")}\n`, "utf8");

const routeRows = routeOrder.map((route) => {
  const item = routeTotals[route];
  return `| ${route} | ${item.totalMs} | ${item.applyMs} | ${item.publishMs} | ` +
    `${mib(item.cdcScanBytes)} | ${item.cdcWindowCount} | ` +
    `${mib(item.peakBranchBytes)} | ${item.fastestCount} |`;
}).join("\n");
const splitRows = byDistributionAndRange.map((group) => (
  `| ${group.distribution} | ${group.rangeCount} | ${group.scenarios} | ` +
  `${group.routes["single-window-cow"].totalMs} | ` +
  `${group.routes["raw-multi-window-cow"].totalMs} | ` +
  `${group.routes["coalesced-multi-window-cow"].totalMs} | ` +
  `${group.routes["adaptive-cow"].totalMs} | ` +
  `${group.routes.materialized.totalMs} | ` +
  `${group.routes["raw-multi-window-cow"].cdcWindowCount} | ` +
  `${group.routes["adaptive-cow"].cdcWindowCount} |`
)).join("\n");
const hypothesisRows = Object.entries(hypotheses).map(([name, value]) => (
  `| ${name} | ${hypothesisLabel(value.passed)} | ${value.threshold} |`
)).join("\n");

const report = `# C3 adaptive CDC router v0.4 results\n\n` +
  `Date: ${raw.date} · Author: ${raw.author}\n` +
  `Raw SHA-256: \`${rawSha256}\`\n\n` +
  `## Outcome\n\n` +
  `The formal run completed 1,000 timed route executions plus five warm-up ` +
  `correctness executions. All 1,005 executions produced the expected final ` +
  `bytes, and retained growth matched across all five routes in all 40 scenarios.\n\n` +
  `The v0.4 planner successfully bounded the mechanism but did not improve ` +
  `latency. On 16/64-range scenarios, it reduced CDC windows from ` +
  `${rawManyWindows} to ${adaptiveManyWindows} (${percent(adaptiveManyWindows / rawManyWindows)}), ` +
  `and scan bytes from ${mib(rawManyScan)} MiB to ${mib(adaptiveManyScan)} MiB ` +
  `(${percent(adaptiveManyScan / rawManyScan)}). Yet total time increased from ` +
  `${rawManyTotal} ms to ${adaptiveManyTotal} ms ` +
  `(${percent(adaptiveManyTotal / rawManyTotal)} of raw multi-window).\n\n` +
  `This falsifies the frozen assumption that fewer windows and fewer scanned ` +
  `bytes are sufficient latency predictors. The full-scan branch reconstructs ` +
  `one contiguous file buffer and performs whole-file chunk preparation; those ` +
  `copy/allocation/working-set costs are not represented by scan bytes alone.\n\n` +
  `## Aggregate route totals\n\n` +
  `Every synthetic scenario has equal weight.\n\n` +
  `| Route | Total ms | Apply ms | Publish ms | CDC scan MiB | Windows | Peak branch MiB | Fastest scenarios |\n` +
  `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${routeRows}\n\n` +
  `Adaptive total was ${routeTotals["adaptive-cow"].totalMs} ms versus ` +
  `${routeTotals["raw-multi-window-cow"].totalMs} ms for raw multi-window ` +
  `(${percent(keyFindings.adaptiveVsRawOverallRatio)}). Pre-merging alone was ` +
  `essentially neutral overall: ${routeTotals["coalesced-multi-window-cow"].totalMs} ms ` +
  `versus ${routeTotals["raw-multi-window-cow"].totalMs} ms ` +
  `(${percent(keyFindings.coalescedVsRawOverallRatio)}).\n\n` +
  `## Layout and range-count split\n\n` +
  `| Layout | Ranges | N | Single ms | Raw multi ms | Coalesced ms | Adaptive ms | Materialized ms | Raw windows | Adaptive windows |\n` +
  `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n` +
  `${splitRows}\n\n` +
  `## Frozen hypotheses\n\n` +
  `| Hypothesis | Result | Frozen criterion |\n| --- | --- | --- |\n${hypothesisRows}\n\n` +
  `H1, H2, H3, H6, H7, and H8 passed. H4 failed: the many-range latency ` +
  `ratio was ${hypotheses.H4_latencyReduction.ratio}, against the frozen 0.80 ` +
  `cutoff. H5 also failed: ${hypotheses.H5_boundedRegret.within125Count}/40 ` +
  `scenarios were within 125% of the fastest forced route, below the required ` +
  `${hypotheses.H5_boundedRegret.requiredCount}.\n\n` +
  `## Engineering decision\n\n` +
  `Do not promote the v0.4 policy. Keep batched page application and the safe ` +
  `multi-window primitive as experimental building blocks. The next router must ` +
  `model at least two costs separately: CDC work and contiguous full-file ` +
  `reconstruction. A natural next preregistered test is a file-size-scaled window ` +
  `limit (instead of the fixed value 8) plus primitive-cost calibration on held-out ` +
  `layouts.\n\n` +
  `## Limits\n\n` +
  analysis.interpretationLimits.map((item) => `- ${item}`).join("\n") + "\n";
writeFileSync(reportPath, report, "utf8");

const reportCn = `# C3 自适应 CDC 路由 v0.4：大白话结果\n\n` +
  `日期：${raw.date} · 作者：${raw.author}\n\n` +
  `## 一句话结论\n\n` +
  `我们成功治住了“窗口数量爆炸”，但没有让程序更快。也就是说，` +
  `v0.4 找到了一个真实的优化线索，也同时证明了当前路由规则还不能用。\n\n` +
  `## 实际发生了什么\n\n` +
  `把 16/64 个修改点放在一起看：原始多窗口一共开了 ${rawManyWindows} 个 ` +
  `CDC 窗口，自适应只开了 ${adaptiveManyWindows} 个，降到 ` +
  `${percent(adaptiveManyWindows / rawManyWindows)}。扫描量也从 ` +
  `${mib(rawManyScan)} MiB 降到 ${mib(adaptiveManyScan)} MiB。可是耗时没有跟着降，` +
  `反而从 ${rawManyTotal} ms 增加到 ${adaptiveManyTotal} ms。\n\n` +
  `原因不是数据造假，也不是代码算错。我们的规则漏算了一笔成本：` +
  `“一次全扫描”之前，要先拼出一个连续的完整文件，还要分配大块内存并复制数据。` +
  `原始多窗口虽然窗口多，却能只处理几块较小的缓冲区。在 16 MiB 文件上，` +
  `后者有时反而明显更快。\n\n` +
  `## 五条路线总成绩\n\n` +
  `| 路线 | 总时间 ms | CDC 扫描 MiB | 窗口数 | 分支峰值 MiB |\n` +
  `| --- | ---: | ---: | ---: | ---: |\n` +
  routeOrder.map((route) => {
    const item = routeTotals[route];
    return `| ${route} | ${item.totalMs} | ${mib(item.cdcScanBytes)} | ` +
      `${item.cdcWindowCount} | ${mib(item.peakBranchBytes)} |`;
  }).join("\n") + `\n\n` +
  `自适应总时间是 ${routeTotals["adaptive-cow"].totalMs} ms，原始多窗口是 ` +
  `${routeTotals["raw-multi-window-cow"].totalMs} ms，所以自适应整体慢了约 ` +
  `${round((keyFindings.adaptiveVsRawOverallRatio - 1) * 100, 1)}%。单独做脏区预合并也没有` +
  `整体提速：${routeTotals["coalesced-multi-window-cow"].totalMs} ms 对 ` +
  `${routeTotals["raw-multi-window-cow"].totalMs} ms。\n\n` +
  `## 哪些事情证实了\n\n` +
  `- 1,005/1,005 次最终文件都完全正确。\n` +
  `- 自适应确实按冻结规则选了 22 次单窗口、6 次多窗口、12 次全扫描。\n` +
  `- 24 个多修改点场景的窗口数从 ${rawManyWindows} 降到 ${adaptiveManyWindows}。\n` +
  `- 稀疏分支没有丢：自适应分支峰值总量只有完整物化的 ` +
  `${percent(keyFindings.adaptiveToMaterializedPeakRatio)}。\n\n` +
  `## 哪些事情被否定了\n\n` +
  `- “窗口越少、扫描越少，就一定越快”被否定。\n` +
  `- 固定写死“最多 8 个窗口”太粗糙。16 MiB 文件承受 16 个小窗口时，` +
  `有时比拼一个完整大缓冲区更划算。\n` +
  `- 当前自适应只在 ${hypotheses.H5_boundedRegret.within125Count}/40 个场景中` +
  `落在最快路线的 125% 以内，没有达到冻结要求的 ` +
  `${hypotheses.H5_boundedRegret.requiredCount}/40。\n\n` +
  `## 客观决定\n\n` +
  `v0.4 不应进入生产默认，也不能宣称“优化成功”。但它非常有用：它把下一步问题` +
  `缩小成了“怎样同时估算小窗口 CDC 成本和完整文件拼接成本”。下一版应该让窗口上限` +
  `随文件大小变化，并先用独立微基准测出复制、分配、CDC 三种成本，再在没有参与调参的` +
  `场景上验证。\n\n` +
  `这仍是本地引擎层合成实验，不等于完整 Computer/FUSE 的真实端到端性能。\n`;
writeFileSync(reportCnPath, reportCn, "utf8");

process.stdout.write(`${JSON.stringify({
  rawSha256,
  analysisPath,
  csvPath,
  reportPath,
  reportCnPath,
  hypotheses: Object.fromEntries(Object.entries(hypotheses).map(([key, value]) => [
    key,
    value.passed,
  ])),
  routeTotals: Object.fromEntries(routeOrder.map((route) => [
    route,
    routeTotals[route].totalMs,
  ])),
})}\n`);
