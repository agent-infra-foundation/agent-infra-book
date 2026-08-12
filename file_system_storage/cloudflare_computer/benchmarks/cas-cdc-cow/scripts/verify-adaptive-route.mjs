import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIB = 1024;
const MIB = 1024 * KIB;
const REPEATS = 5;
const ROUTES = ["incremental", "materialized"];
const FIELDS = [
  "applyMs",
  "publishMs",
  "totalMs",
  "sqlitePayloadBytes",
  "peakBranchBytes",
  "retainedGrowthBytes",
  "databaseGrowthBytes",
];
const CANDIDATE_VALUES = {
  maxChangedBytes: [0, 4 * KIB, 64 * KIB, 256 * KIB],
  maxRanges: [0, 1, 64, 256],
  maxDirtySpanRatio: [0, 0.125, 0.5, 1],
};
const EXPECTED_GATE = {
  maxChangedBytes: 65536,
  maxRanges: 1,
  maxDirtySpanRatio: 0.125,
};
const MANIFEST_PATH = "experiments/adaptive-route-v0.1/MANIFEST.json";
const INVENTORY_FILES = [
  {
    path: "src/bench/adaptive-route.bench.ts",
    sha256: "7bd57b4455eef8b11329155bcfc5abe61e6b3977a36121adec5ff8dd3249ef9e",
    bytes: 14310,
  },
  {
    path: "scripts/run-adaptive-route.mjs",
    sha256: "29c40b32dd365cd2a530c2235c8a16fc8c8ee7e703ecaccbb990f7fcaed0f321",
    bytes: 2134,
  },
];
const RUNS = [
  {
    name: "supplied",
    path: "results/adaptive-route-supplied-7829e079.json",
    sha256: "7829e079a6b9c5012ddc2759e40bd7101ab9ba9a561101197003b8d1458ff233",
    bytes: 124185,
    heldOut: { current: 1025, adaptive: 539, oracle: 524 },
    repeatGates: [
      [65536, 1, 0.125],
      [65536, 1, 0.125],
      [65536, 1, 0.125],
      [65536, 1, 0.125],
      [65536, 1, 0.125],
    ],
  },
  {
    name: "clean-room",
    path: "results/adaptive-route-clean-room-077bef18.json",
    sha256: "077bef181631c6ce16d25684297100b26a4416eaa1e8844afcd94866830dff65",
    bytes: 124229,
    heldOut: { current: 1078, adaptive: 711, oracle: 698 },
    repeatGates: [
      [65536, 1, 0.125],
      [4096, 1, 0.125],
      [4096, 64, 0.125],
      [65536, 1, 0.125],
      [65536, 1, 0.125],
    ],
  },
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const issues = [];

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hashBytes(path) {
  const bytes = readFileSync(resolve(root, path));
  return {
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function readJson(path) {
  return JSON.parse(hashBytes(path).bytes.toString("utf8"));
}

function currentRoute(result) {
  return result.changedBytes <= 64 * KIB && result.rangeCount <= 256
    ? "incremental"
    : "materialized";
}

function ruleRoute(result, rule) {
  return result.changedBytes <= rule.maxChangedBytes &&
    result.rangeCount <= rule.maxRanges &&
    result.dirtySpanRatio <= rule.maxDirtySpanRatio
    ? "incremental"
    : "materialized";
}

function oracleRoute(result) {
  return result.routes.incremental.totalMs <= result.routes.materialized.totalMs
    ? "incremental"
    : "materialized";
}

function evaluate(results, select) {
  const output = {
    totalMs: 0,
    sqlitePayloadBytes: 0,
    selections: { incremental: 0, materialized: 0 },
  };
  for (const result of results) {
    const route = select(result);
    output.selections[route]++;
    output.totalMs += result.routes[route].totalMs;
    output.sqlitePayloadBytes += result.routes[route].sqlitePayloadBytes;
  }
  output.totalMs = round(output.totalMs);
  return output;
}

function evaluateStorage(results, select) {
  const output = {
    totalMs: 0,
    sqlitePayloadBytes: 0,
    peakBranchBytes: 0,
    retainedGrowthBytes: 0,
    databaseGrowthBytes: 0,
    selections: { incremental: 0, materialized: 0 },
  };
  for (const result of results) {
    const route = select(result);
    output.selections[route]++;
    for (const field of [
      "totalMs",
      "sqlitePayloadBytes",
      "peakBranchBytes",
      "retainedGrowthBytes",
      "databaseGrowthBytes",
    ]) {
      output[field] += result.routes[route][field];
    }
  }
  output.totalMs = round(output.totalMs);
  return output;
}

function candidates() {
  const rules = [];
  for (const maxChangedBytes of CANDIDATE_VALUES.maxChangedBytes) {
    for (const maxRanges of CANDIDATE_VALUES.maxRanges) {
      for (const maxDirtySpanRatio of CANDIDATE_VALUES.maxDirtySpanRatio) {
        rules.push({ maxChangedBytes, maxRanges, maxDirtySpanRatio });
      }
    }
  }
  return rules;
}

function calibrate(results) {
  const training = results.filter((result) => result.fileBytes === 4 * MIB);
  return candidates()
    .map((rule) => ({
      rule,
      cost: round(training.reduce(
        (total, result) => total + result.routes[ruleRoute(result, rule)].totalMs,
        0,
      )),
    }))
    .sort((left, right) => left.cost - right.cost ||
      left.rule.maxChangedBytes - right.rule.maxChangedBytes ||
      left.rule.maxRanges - right.rule.maxRanges ||
      left.rule.maxDirtySpanRatio - right.rule.maxDirtySpanRatio)[0];
}

function scenarioIds() {
  const ids = [];
  for (const fileBytes of [1 * MIB, 4 * MIB, 16 * MIB]) {
    for (const changedBytes of [4 * KIB, 64 * KIB, 256 * KIB]) {
      for (const rangeCount of [1, 64, 256]) {
        const distributions = rangeCount === 1 ? ["midpoint"] : ["clustered", "spread"];
        for (const distribution of distributions) {
          ids.push(`${fileBytes / MIB}m-${changedBytes / KIB}k-${rangeCount}r-${distribution}`);
        }
      }
    }
  }
  return ids;
}

function checkEqual(runName, label, actual, expected) {
  if (!sameJson(actual, expected)) {
    issues.push(`${runName}: ${label} mismatch: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

function checkFinite(runName, label, value) {
  if (!Number.isFinite(value)) {
    issues.push(`${runName}: ${label} is not finite: ${value}`);
  }
}

function checkTopLevelContract(runName, report) {
  checkEqual(runName, "schemaVersion", report.schemaVersion, 1);
  checkEqual(runName, "benchmarkLayer", report.benchmarkLayer, "engine");
  checkEqual(runName, "experiment", report.experiment, "adaptive-c3-route-v0.1");
  checkEqual(
    runName,
    "repositoryRevision",
    report.repositoryRevision,
    "d63eec0a10c327fa52c52e83897cf6e43490df68",
  );
  checkEqual(runName, "configuration.repetitions", report.configuration?.repetitions, REPEATS);
  checkEqual(runName, "configuration.currentRule", report.configuration?.currentRule, {
    maxChangedBytes: 64 * KIB,
    maxRanges: 256,
  });
  checkEqual(runName, "configuration.calibrationFileBytes", report.configuration?.calibrationFileBytes, 4 * MIB);
  checkEqual(runName, "configuration.heldOutFileBytes", report.configuration?.heldOutFileBytes, [1 * MIB, 16 * MIB]);
  checkEqual(runName, "configuration.sampleColumns", report.configuration?.sampleColumns, FIELDS);
  checkEqual(runName, "H4 correctness accounting", report.hypotheses?.H4_correctness, {
    passed: true,
    executions: 452,
  });
}

function repeatResults(report, repeat) {
  return report.results.map((result) => {
    const routes = {};
    for (const route of ROUTES) {
      const sample = result.routes[route].samples[repeat];
      routes[route] = Object.fromEntries(FIELDS.map((field, index) => [field, sample[index]]));
      routes[route].samples = [sample];
    }
    const rebuilt = { ...result, routes };
    rebuilt.currentRoute = currentRoute(rebuilt);
    rebuilt.oracleRoute = oracleRoute(rebuilt);
    return rebuilt;
  });
}

function recomputeHypotheses(report, heldOut, aggregates) {
  const opportunityCount = heldOut.filter((result) => {
    const chosen = result.routes[currentRoute(result)].totalMs;
    const alternativeRoute = currentRoute(result) === "incremental" ? "materialized" : "incremental";
    const alternative = result.routes[alternativeRoute].totalMs;
    return chosen - alternative >= 0.2 && chosen / alternative >= 1.1;
  }).length;
  const currentExcess = aggregates.current.totalMs - aggregates.oracle.totalMs;
  const adaptiveExcess = aggregates.adaptive.totalMs - aggregates.oracle.totalMs;
  const excessRemoved = currentExcess <= 0 ? 0 : (currentExcess - adaptiveExcess) / currentExcess;
  return {
    H1_opportunity: {
      passed: opportunityCount / heldOut.length >= 0.2,
      opportunityCount,
      heldOutScenarios: heldOut.length,
    },
    H2_usefulGate: {
      passed: aggregates.adaptive.totalMs <= aggregates.current.totalMs * 0.9,
      speedup: round(aggregates.current.totalMs / aggregates.adaptive.totalMs),
    },
    H3_lowerRegret: {
      passed: excessRemoved >= 0.25,
      currentExcessMs: round(currentExcess),
      adaptiveExcessMs: round(adaptiveExcess),
      excessRemovedFraction: round(excessRemoved),
    },
    H4_correctness: {
      passed: true,
      executions: report.results.length * ROUTES.length * REPEATS + 2,
    },
  };
}

function validateRun(run) {
  const hashed = hashBytes(run.path);
  if (hashed.sha256 !== run.sha256) issues.push(`${run.name}: sha256 mismatch ${hashed.sha256}`);
  if (hashed.byteLength !== run.bytes) issues.push(`${run.name}: byte count mismatch ${hashed.byteLength}`);

  const report = JSON.parse(hashed.bytes.toString("utf8"));
  checkTopLevelContract(run.name, report);
  const expectedIds = scenarioIds();
  const actualIds = report.results.map((result) => result.id).sort();
  checkEqual(run.name, "scenario id set", actualIds, [...expectedIds].sort());

  const calibration = report.results.filter((result) => result.fileBytes === 4 * MIB);
  const heldOut = report.results.filter((result) => result.fileBytes !== 4 * MIB);
  if (report.results.length !== 45) issues.push(`${run.name}: expected 45 scenarios`);
  if (calibration.length !== 15) issues.push(`${run.name}: expected 15 calibration scenarios`);
  if (heldOut.length !== 30) issues.push(`${run.name}: expected 30 held-out scenarios`);
  if (report.results.length * ROUTES.length * REPEATS !== 450) {
    issues.push(`${run.name}: expected 450 formal measurements`);
  }

  for (const result of report.results) {
    checkEqual(run.name, `${result.id} currentRoute`, result.currentRoute, currentRoute(result));
    checkEqual(run.name, `${result.id} oracleRoute`, result.oracleRoute, oracleRoute(result));
    for (const route of ROUTES) {
      const aggregate = result.routes[route];
      if (!Array.isArray(aggregate.samples) || aggregate.samples.length !== REPEATS) {
        issues.push(`${run.name}: ${result.id}/${route} expected ${REPEATS} samples`);
        continue;
      }
      for (const [sampleIndex, sample] of aggregate.samples.entries()) {
        if (!Array.isArray(sample) || sample.length !== FIELDS.length) {
          issues.push(`${run.name}: ${result.id}/${route} sample ${sampleIndex} expected ${FIELDS.length} fields`);
          continue;
        }
        sample.forEach((value, fieldIndex) => {
          checkFinite(run.name, `${result.id}/${route} sample ${sampleIndex} ${FIELDS[fieldIndex]}`, value);
        });
      }
      for (const [fieldIndex, field] of FIELDS.entries()) {
        const computed = round(median(aggregate.samples.map((sample) => sample[fieldIndex])));
        checkEqual(run.name, `${result.id}/${route} median ${field}`, aggregate[field], computed);
      }
    }
  }

  const aggregateGate = calibrate(report.results).rule;
  checkEqual(run.name, "aggregate calibrated rule", report.calibratedRule, aggregateGate);
  checkEqual(run.name, "expected aggregate gate", aggregateGate, EXPECTED_GATE);

  const recomputedCalibration = {
    current: evaluate(calibration, currentRoute),
    adaptive: evaluate(calibration, (result) => ruleRoute(result, aggregateGate)),
    oracle: evaluate(calibration, oracleRoute),
  };
  const recomputedHeldOut = {
    current: evaluate(heldOut, currentRoute),
    adaptive: evaluate(heldOut, (result) => ruleRoute(result, aggregateGate)),
    oracle: evaluate(heldOut, oracleRoute),
  };
  checkEqual(run.name, "calibration aggregates", report.aggregates.calibration, recomputedCalibration);
  checkEqual(run.name, "held-out aggregates", report.aggregates.heldOut, recomputedHeldOut);
  checkEqual(run.name, "expected held-out totals", {
    current: recomputedHeldOut.current.totalMs,
    adaptive: recomputedHeldOut.adaptive.totalMs,
    oracle: recomputedHeldOut.oracle.totalMs,
  }, run.heldOut);

  const hypotheses = recomputeHypotheses(report, heldOut, recomputedHeldOut);
  checkEqual(run.name, "hypotheses", report.hypotheses, hypotheses);

  const storage = {
    current: evaluateStorage(heldOut, currentRoute),
    adaptive: evaluateStorage(heldOut, (result) => ruleRoute(result, aggregateGate)),
    oracle: evaluateStorage(heldOut, oracleRoute),
  };
  if (storage.current.peakBranchBytes !== 44689135) {
    issues.push(`${run.name}: current peakBranchBytes mismatch`);
  }
  if (storage.adaptive.peakBranchBytes !== 105724767) {
    issues.push(`${run.name}: adaptive peakBranchBytes mismatch`);
  }
  const peakBranchRatio = round(storage.adaptive.peakBranchBytes / storage.current.peakBranchBytes);
  if (peakBranchRatio !== 2.366) {
    issues.push(`${run.name}: adaptive/current peak branch ratio mismatch ${peakBranchRatio}`);
  }
  if (storage.adaptive.sqlitePayloadBytes !== 106888055 ||
      storage.current.sqlitePayloadBytes !== 117513079) {
    issues.push(`${run.name}: held-out sqlite payload trade-off mismatch`);
  }
  if (storage.current.retainedGrowthBytes !== storage.adaptive.retainedGrowthBytes) {
    issues.push(`${run.name}: current/adaptive retainedGrowthBytes differ`);
  }
  if (storage.current.databaseGrowthBytes !== storage.adaptive.databaseGrowthBytes) {
    issues.push(`${run.name}: current/adaptive databaseGrowthBytes differ`);
  }
  if (storage.current.retainedGrowthBytes !== 106740599 ||
      storage.adaptive.retainedGrowthBytes !== 106740599 ||
      storage.current.databaseGrowthBytes !== 107507712 ||
      storage.adaptive.databaseGrowthBytes !== 107507712) {
    issues.push(`${run.name}: retained/database growth aggregate mismatch`);
  }

  const repeatFits = [];
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    const rebuilt = repeatResults(report, repeat);
    const repeatGate = calibrate(rebuilt).rule;
    const repeatHeldOut = rebuilt.filter((result) => result.fileBytes !== 4 * MIB);
    const current = evaluate(repeatHeldOut, currentRoute);
    const adaptive = evaluate(repeatHeldOut, (result) => ruleRoute(result, repeatGate));
    const oracle = evaluate(repeatHeldOut, oracleRoute);
    const expectedGate = {
      maxChangedBytes: run.repeatGates[repeat][0],
      maxRanges: run.repeatGates[repeat][1],
      maxDirtySpanRatio: run.repeatGates[repeat][2],
    };
    checkEqual(run.name, `repeat ${repeat} fitted gate`, repeatGate, expectedGate);
    if (adaptive.totalMs >= current.totalMs) {
      issues.push(`${run.name}: repeat ${repeat} adaptive total does not beat current`);
    }
    repeatFits.push({
      repeat,
      gate: repeatGate,
      currentMs: current.totalMs,
      adaptiveMs: adaptive.totalMs,
      oracleMs: oracle.totalMs,
      speedup: round(current.totalMs / adaptive.totalMs),
    });
  }

  return {
    name: run.name,
    sha256: hashed.sha256,
    bytes: hashed.byteLength,
    gate: aggregateGate,
    heldOut: recomputedHeldOut,
    speedup: report.hypotheses.H2_usefulGate.speedup,
    storage: {
      currentPeakBranchBytes: storage.current.peakBranchBytes,
      adaptivePeakBranchBytes: storage.adaptive.peakBranchBytes,
      adaptivePeakBranchRatio: peakBranchRatio,
      currentSqlitePayloadBytes: storage.current.sqlitePayloadBytes,
      adaptiveSqlitePayloadBytes: storage.adaptive.sqlitePayloadBytes,
      retainedGrowthBytes: storage.current.retainedGrowthBytes,
      databaseGrowthBytes: storage.current.databaseGrowthBytes,
    },
    repeatFits,
  };
}

function validateManifest() {
  const manifest = readJson(MANIFEST_PATH);
  const inventory = new Map((manifest.inventory ?? []).map((entry) => [entry.path, entry]));
  const expected = [...INVENTORY_FILES, ...RUNS.map((run) => ({
    path: run.path,
    sha256: run.sha256,
    bytes: run.bytes,
  }))];

  for (const item of expected) {
    const entry = inventory.get(item.path);
    if (entry === undefined) {
      issues.push(`manifest: missing inventory entry for ${item.path}`);
      continue;
    }
    const hashed = hashBytes(item.path);
    checkEqual("manifest", `${item.path} sha256`, entry.sha256, item.sha256);
    checkEqual("manifest", `${item.path} bytes`, entry.bytes, item.bytes);
    checkEqual("manifest", `${item.path} computed sha256`, hashed.sha256, item.sha256);
    checkEqual("manifest", `${item.path} computed bytes`, hashed.byteLength, item.bytes);
  }

  for (const path of [
    "experiments/adaptive-route-v0.1/README.md",
    "scripts/verify-adaptive-route.mjs",
  ]) {
    const entry = inventory.get(path);
    if (entry === undefined) {
      issues.push(`manifest: missing inventory entry for ${path}`);
      continue;
    }
    const hashed = hashBytes(path);
    checkEqual("manifest", `${path} sha256`, entry.sha256, hashed.sha256);
    checkEqual("manifest", `${path} bytes`, entry.bytes, hashed.byteLength);
  }
}

validateManifest();
const summaries = RUNS.map(validateRun);

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`VERIFY_ADAPTIVE_ROUTE_ERROR: ${issue}`);
  }
  process.exit(1);
}

for (const summary of summaries) {
  const repeatGates = summary.repeatFits
    .map((fit) => `${fit.repeat}:${fit.gate.maxChangedBytes}/${fit.gate.maxRanges}/${fit.gate.maxDirtySpanRatio}`)
    .join(", ");
  console.log(
    `VERIFY_ADAPTIVE_ROUTE_OK ${summary.name}: ` +
    `sha256=${summary.sha256} bytes=${summary.bytes} ` +
    `heldOut=${summary.heldOut.current.totalMs}/${summary.heldOut.adaptive.totalMs}/${summary.heldOut.oracle.totalMs}ms ` +
    `speedup=${summary.speedup} gate=${summary.gate.maxChangedBytes}/${summary.gate.maxRanges}/${summary.gate.maxDirtySpanRatio} ` +
    `peakBranch=${summary.storage.currentPeakBranchBytes}/${summary.storage.adaptivePeakBranchBytes} (${summary.storage.adaptivePeakBranchRatio}x) ` +
    `repeatGates=[${repeatGates}]`,
  );
}
