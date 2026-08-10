import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  root,
  "experiments/c3-adaptive-cdc-router-v0.4/MANIFEST.json",
);
const rawPath = resolve(root, "results/c3-adaptive-cdc-router-raw-v04.json");
const analysisPath = resolve(root, "results/c3-adaptive-cdc-router-analysis-v04.json");
const expectedRoutes = [
  "single-window-cow",
  "raw-multi-window-cow",
  "coalesced-multi-window-cow",
  "adaptive-cow",
  "materialized",
];
const expectedHypotheses = {
  H1_structuralRouting: true,
  H2_windowBound: true,
  H3_scanReduction: true,
  H4_latencyReduction: false,
  H5_boundedRegret: false,
  H6_sparseStorage: true,
  H7_scanBudget: true,
  H8_correctness: true,
};

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const manifest = readJson(manifestPath);
const inventoryPaths = new Set();
for (const item of manifest.inventory) {
  check(!isAbsolute(item.path), `inventory path must be relative: ${item.path}`);
  const path = resolve(root, item.path);
  check(
    path.startsWith(`${root}${sep}`),
    `inventory path escapes benchmark root: ${item.path}`,
  );
  check(!inventoryPaths.has(item.path), `duplicate inventory path: ${item.path}`);
  inventoryPaths.add(item.path);
  try {
    const bytes = readFileSync(path);
    check(statSync(path).size === item.bytes, `byte count mismatch: ${item.path}`);
    check(sha256(bytes) === item.sha256, `SHA-256 mismatch: ${item.path}`);
  } catch (error) {
    failures.push(`cannot read inventory file ${item.path}: ${error.message}`);
  }
}

const rawBytes = readFileSync(rawPath);
const raw = JSON.parse(rawBytes.toString("utf8"));
const analysis = readJson(analysisPath);
const rawSha256 = sha256(rawBytes);

check(raw.experiment === "c3-adaptive-cdc-router-v0.4", "unexpected experiment id");
check(raw.author === "Wang Runyuan", "unexpected author");
check(raw.results.length === 40, "raw data must contain 40 scenarios");
check(raw.configuration.scenarios === 40, "configuration.scenarios must be 40");
check(raw.configuration.repetitions === 5, "configuration.repetitions must be 5");
check(
  JSON.stringify(raw.configuration.routes) === JSON.stringify(expectedRoutes),
  "route order does not match the frozen design",
);
check(raw.configuration.formalExecutions === 1000, "formal execution count must be 1,000");
check(
  raw.configuration.warmupCorrectnessExecutions === 5,
  "warm-up correctness count must be 5",
);
check(
  raw.configuration.correctnessExecutions === 1005,
  "correctness execution count must be 1,005",
);
check(
  raw.configuration.formalExecutions ===
    raw.configuration.scenarios * expectedRoutes.length * raw.configuration.repetitions,
  "formal execution count is inconsistent with scenarios, routes, and repetitions",
);
check(
  raw.retainedGrowthMismatches.length === 0,
  "retained growth mismatch list must be empty",
);

for (const row of raw.results) {
  check(
    JSON.stringify(Object.keys(row.routes)) === JSON.stringify(expectedRoutes),
    `${row.id}: route keys do not match the frozen route order`,
  );
  for (const route of expectedRoutes) {
    const record = row.routes[route];
    check(record.samples.length === 5, `${row.id}/${route}: expected five samples`);
    for (const [index, sample] of record.samples.entries()) {
      check(
        sample.length === raw.configuration.sampleColumns.length,
        `${row.id}/${route}/sample-${index}: sample column count mismatch`,
      );
    }
  }
}

check(analysis.sourceRawSha256 === rawSha256, "analysis source raw hash mismatch");
for (const [name, expected] of Object.entries(expectedHypotheses)) {
  check(analysis.hypotheses[name]?.passed === expected, `${name}: unexpected decision`);
  check(manifest.hypotheses[name] === expected, `${name}: manifest decision mismatch`);
}

for (const route of expectedRoutes) {
  check(
    manifest.route_total_ms[route] === analysis.routeTotals[route].totalMs,
    `${route}: manifest route total mismatch`,
  );
}

const manyRange = manifest.many_range_result;
check(
  manyRange.raw_multi_windows === analysis.hypotheses.H2_windowBound.rawWindows,
  "many-range raw window total mismatch",
);
check(
  manyRange.adaptive_windows === analysis.hypotheses.H2_windowBound.adaptiveWindows,
  "many-range adaptive window total mismatch",
);
check(
  manyRange.raw_multi_scan_bytes === analysis.hypotheses.H3_scanReduction.rawScanBytes,
  "many-range raw scan total mismatch",
);
check(
  manyRange.adaptive_scan_bytes === analysis.hypotheses.H3_scanReduction.adaptiveScanBytes,
  "many-range adaptive scan total mismatch",
);
check(
  manyRange.raw_multi_total_ms === analysis.hypotheses.H4_latencyReduction.rawTotalMs,
  "many-range raw latency total mismatch",
);
check(
  manyRange.adaptive_total_ms === analysis.hypotheses.H4_latencyReduction.adaptiveTotalMs,
  "many-range adaptive latency total mismatch",
);

const summary = {
  ok: failures.length === 0,
  inventoryFiles: manifest.inventory.length,
  rawSha256,
  scenarios: raw.results.length,
  formalExecutions: raw.configuration.formalExecutions,
  correctnessExecutions: raw.configuration.correctnessExecutions,
  hypotheses: Object.fromEntries(
    Object.entries(analysis.hypotheses).map(([name, value]) => [name, value.passed]),
  ),
  failures,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
