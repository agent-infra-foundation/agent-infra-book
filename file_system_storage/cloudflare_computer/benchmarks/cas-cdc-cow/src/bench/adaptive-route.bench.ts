import { describe, expect, it } from "vitest";
import type { BranchWorkspaceStorageEngine } from "../engines/types";
import { nowMs } from "../engines/util";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const KIB = 1024;
const MIB = 1024 * KIB;
const REPEATS = 5;
const CURRENT_MAX_DELTA_BYTES = 64 * KIB;
const CURRENT_MAX_RANGES = 256;

type Route = "incremental" | "materialized";
type Distribution = "midpoint" | "clustered" | "spread";

interface EditRange {
  offset: number;
  bytes: Uint8Array;
}

interface ScenarioDefinition {
  id: string;
  fileBytes: number;
  changedBytes: number;
  rangeCount: number;
  distribution: Distribution;
}

interface Workload {
  base: Uint8Array;
  expected: Uint8Array;
  ranges: EditRange[];
  dirtySpanBytes: number;
  dirtySpanRatio: number;
  touchedPages: number;
  touchedPageRatio: number;
}

interface Measurement {
  applyMs: number;
  publishMs: number;
  totalMs: number;
  sqlitePayloadBytes: number;
  peakBranchBytes: number;
  retainedGrowthBytes: number;
  databaseGrowthBytes: number;
}

interface RouteAggregate extends Measurement {
  samples: number[][];
}

interface ScenarioResult extends ScenarioDefinition {
  dirtySpanBytes: number;
  dirtySpanRatio: number;
  touchedPages: number;
  touchedPageRatio: number;
  routes: Record<Route, RouteAggregate>;
  currentRoute: Route;
  oracleRoute: Route;
}

interface ThresholdRule {
  maxChangedBytes: number;
  maxRanges: number;
  maxDirtySpanRatio: number;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function scenarioDefinitions(): ScenarioDefinition[] {
  const definitions: ScenarioDefinition[] = [];
  for (const fileBytes of [1 * MIB, 4 * MIB, 16 * MIB]) {
    for (const changedBytes of [4 * KIB, 64 * KIB, 256 * KIB]) {
      for (const rangeCount of [1, 64, 256]) {
        const distributions: Distribution[] = rangeCount === 1
          ? ["midpoint"]
          : ["clustered", "spread"];
        for (const distribution of distributions) {
          definitions.push({
            id: `${fileBytes / MIB}m-${changedBytes / KIB}k-${rangeCount}r-${distribution}`,
            fileBytes,
            changedBytes,
            rangeCount,
            distribution,
          });
        }
      }
    }
  }
  return definitions;
}

function buildWorkload(definition: ScenarioDefinition): Workload {
  if (definition.changedBytes % definition.rangeCount !== 0) {
    throw new Error(`changed bytes must divide evenly: ${definition.id}`);
  }
  const base = fixtureBytes(definition.fileBytes, 0x5a17 + definition.fileBytes / MIB);
  const expected = new Uint8Array(base);
  const rangeBytes = definition.changedBytes / definition.rangeCount;
  const regionBytes = definition.distribution === "spread"
    ? definition.fileBytes
    : definition.distribution === "midpoint"
      ? rangeBytes
      : Math.min(
        definition.fileBytes,
        Math.max(definition.changedBytes * 2, Math.floor(definition.fileBytes / 8)),
      );
  const regionStart = Math.floor((definition.fileBytes - regionBytes) / 2);
  const availableStartSpan = regionBytes - rangeBytes;
  const ranges: EditRange[] = [];
  const pages = new Set<number>();

  for (let index = 0; index < definition.rangeCount; index++) {
    const offset = definition.rangeCount === 1
      ? Math.floor((definition.fileBytes - rangeBytes) / 2)
      : regionStart + Math.floor(availableStartSpan * index / (definition.rangeCount - 1));
    const previous = ranges.at(-1);
    if (previous !== undefined && offset < previous.offset + previous.bytes.byteLength) {
      throw new Error(`overlapping generated ranges: ${definition.id}`);
    }
    const bytes = new Uint8Array(rangeBytes);
    for (let local = 0; local < rangeBytes; local++) {
      bytes[local] = base[offset + local] ^ 0xff;
    }
    expected.set(bytes, offset);
    ranges.push({ offset, bytes });
    const firstPage = Math.floor(offset / (4 * KIB));
    const lastPage = Math.floor((offset + rangeBytes - 1) / (4 * KIB));
    for (let page = firstPage; page <= lastPage; page++) pages.add(page);
  }

  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const dirtySpanBytes = last.offset + last.bytes.byteLength - first.offset;
  return {
    base,
    expected,
    ranges,
    dirtySpanBytes,
    dirtySpanRatio: dirtySpanBytes / definition.fileBytes,
    touchedPages: pages.size,
    touchedPageRatio: pages.size / Math.ceil(definition.fileBytes / (4 * KIB)),
  };
}

async function measure(
  route: Route,
  definition: ScenarioDefinition,
  workload: Workload,
): Promise<Measurement> {
  return withEngine("cas-cdc-cow", async ({ engine, sql }) => {
    const branchEngine = engine as BranchWorkspaceStorageEngine;
    await engine.seedFile("/workspace.bin", workload.base);
    engine.createBranch("agent-a");
    engine.resetCounters();
    const before = engine.snapshot(1);
    const databaseBefore = sql.databaseSize;

    const applyStarted = nowMs();
    if (route === "incremental") {
      for (const range of workload.ranges) {
        await engine.editFile(
          "agent-a",
          "/workspace.bin",
          range.offset,
          range.bytes.byteLength,
          range.bytes,
        );
      }
    } else {
      await branchEngine.writeBranchFile("agent-a", "/workspace.bin", workload.expected);
    }
    const applyMs = nowMs() - applyStarted;
    const afterApply = engine.snapshot(1);

    const publishStarted = nowMs();
    const published = await engine.publish("agent-a");
    const publishMs = nowMs() - publishStarted;
    if (published.outcome !== "merged") {
      throw new Error(`${definition.id}/${route} unexpectedly conflicted`);
    }

    const afterPublish = engine.snapshot(1);
    const actual = await engine.readFile(null, "/workspace.bin");
    if (!bytesEqual(actual, workload.expected)) {
      throw new Error(`${definition.id}/${route} produced incorrect bytes`);
    }
    return {
      applyMs,
      publishMs,
      totalMs: applyMs + publishMs,
      sqlitePayloadBytes: engine.counters.sqlitePayloadBytes,
      peakBranchBytes: afterApply.branchStorage.totalExclusivePayloadBytes,
      retainedGrowthBytes: Math.max(0, afterPublish.storedPayloadBytes - before.storedPayloadBytes),
      databaseGrowthBytes: Math.max(0, sql.databaseSize - databaseBefore),
    };
  });
}

function aggregate(measurements: Measurement[]): RouteAggregate {
  const fields = [
    "applyMs",
    "publishMs",
    "totalMs",
    "sqlitePayloadBytes",
    "peakBranchBytes",
    "retainedGrowthBytes",
    "databaseGrowthBytes",
  ] as const;
  const result = Object.fromEntries(fields.map((field) => [
    field,
    round(median(measurements.map((measurement) => measurement[field]))),
  ])) as unknown as Measurement;
  return {
    ...result,
    samples: measurements.map((measurement) => fields.map((field) => round(measurement[field]))),
  };
}

function currentRoute(result: Pick<ScenarioResult, "changedBytes" | "rangeCount">): Route {
  return result.changedBytes <= CURRENT_MAX_DELTA_BYTES &&
    result.rangeCount <= CURRENT_MAX_RANGES
    ? "incremental"
    : "materialized";
}

function ruleRoute(result: ScenarioResult, rule: ThresholdRule): Route {
  return result.changedBytes <= rule.maxChangedBytes &&
    result.rangeCount <= rule.maxRanges &&
    result.dirtySpanRatio <= rule.maxDirtySpanRatio
    ? "incremental"
    : "materialized";
}

function calibrate(results: ScenarioResult[]): ThresholdRule {
  const training = results.filter((result) => result.fileBytes === 4 * MIB);
  const candidates: ThresholdRule[] = [];
  for (const maxChangedBytes of [0, 4 * KIB, 64 * KIB, 256 * KIB]) {
    for (const maxRanges of [0, 1, 64, 256]) {
      for (const maxDirtySpanRatio of [0, 0.125, 0.5, 1]) {
        candidates.push({ maxChangedBytes, maxRanges, maxDirtySpanRatio });
      }
    }
  }
  return candidates
    .map((rule) => ({
      rule,
      cost: training.reduce(
        (total, result) => total + result.routes[ruleRoute(result, rule)].totalMs,
        0,
      ),
    }))
    .sort((left, right) => left.cost - right.cost ||
      left.rule.maxChangedBytes - right.rule.maxChangedBytes ||
      left.rule.maxRanges - right.rule.maxRanges ||
      left.rule.maxDirtySpanRatio - right.rule.maxDirtySpanRatio)[0].rule;
}

function evaluate(
  results: ScenarioResult[],
  select: (result: ScenarioResult) => Route,
): { totalMs: number; sqlitePayloadBytes: number; selections: Record<Route, number> } {
  const selections: Record<Route, number> = { incremental: 0, materialized: 0 };
  let totalMs = 0;
  let sqlitePayloadBytes = 0;
  for (const result of results) {
    const route = select(result);
    selections[route]++;
    totalMs += result.routes[route].totalMs;
    sqlitePayloadBytes += result.routes[route].sqlitePayloadBytes;
  }
  return { totalMs: round(totalMs), sqlitePayloadBytes, selections };
}

describe("adaptive C3 route selection", () => {
  it("calibrates on 4 MiB and evaluates on held-out file sizes", async () => {
    const warmupDefinition: ScenarioDefinition = {
      id: "warmup",
      fileBytes: 1 * MIB,
      changedBytes: 4 * KIB,
      rangeCount: 1,
      distribution: "midpoint",
    };
    const warmup = buildWorkload(warmupDefinition);
    await measure("incremental", warmupDefinition, warmup);
    await measure("materialized", warmupDefinition, warmup);

    const results: ScenarioResult[] = [];
    for (const definition of scenarioDefinitions()) {
      const workload = buildWorkload(definition);
      const measurements: Record<Route, Measurement[]> = {
        incremental: [],
        materialized: [],
      };
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const order: Route[] = repeat % 2 === 0
          ? ["incremental", "materialized"]
          : ["materialized", "incremental"];
        for (const route of order) {
          measurements[route].push(await measure(route, definition, workload));
        }
      }
      const routes: Record<Route, RouteAggregate> = {
        incremental: aggregate(measurements.incremental),
        materialized: aggregate(measurements.materialized),
      };
      const partial = {
        ...definition,
        dirtySpanBytes: workload.dirtySpanBytes,
        dirtySpanRatio: round(workload.dirtySpanRatio),
        touchedPages: workload.touchedPages,
        touchedPageRatio: round(workload.touchedPageRatio),
        routes,
      };
      const result: ScenarioResult = {
        ...partial,
        currentRoute: currentRoute(partial),
        oracleRoute: routes.incremental.totalMs <= routes.materialized.totalMs
          ? "incremental"
          : "materialized",
      };
      results.push(result);
      console.log(
        `ADAPTIVE_ROUTE_PROGRESS:${result.id}:` +
        `${routes.incremental.totalMs}/${routes.materialized.totalMs}ms`,
      );
    }

    const calibratedRule = calibrate(results);
    const calibration = results.filter((result) => result.fileBytes === 4 * MIB);
    const heldOut = results.filter((result) => result.fileBytes !== 4 * MIB);
    const currentHeldOut = evaluate(heldOut, (result) => result.currentRoute);
    const adaptiveHeldOut = evaluate(heldOut, (result) => ruleRoute(result, calibratedRule));
    const oracleHeldOut = evaluate(heldOut, (result) => result.oracleRoute);
    const opportunityCount = heldOut.filter((result) => {
      const chosen = result.routes[result.currentRoute].totalMs;
      const alternativeRoute: Route = result.currentRoute === "incremental"
        ? "materialized"
        : "incremental";
      const alternative = result.routes[alternativeRoute].totalMs;
      return chosen - alternative >= 0.2 && chosen / alternative >= 1.1;
    }).length;
    const currentExcess = currentHeldOut.totalMs - oracleHeldOut.totalMs;
    const adaptiveExcess = adaptiveHeldOut.totalMs - oracleHeldOut.totalMs;
    const excessRemoved = currentExcess <= 0
      ? 0
      : (currentExcess - adaptiveExcess) / currentExcess;
    const hypotheses = {
      H1_opportunity: {
        passed: opportunityCount / heldOut.length >= 0.2,
        opportunityCount,
        heldOutScenarios: heldOut.length,
      },
      H2_usefulGate: {
        passed: adaptiveHeldOut.totalMs <= currentHeldOut.totalMs * 0.9,
        speedup: round(currentHeldOut.totalMs / adaptiveHeldOut.totalMs),
      },
      H3_lowerRegret: {
        passed: excessRemoved >= 0.25,
        currentExcessMs: round(currentExcess),
        adaptiveExcessMs: round(adaptiveExcess),
        excessRemovedFraction: round(excessRemoved),
      },
      H4_correctness: { passed: true, executions: results.length * 2 * REPEATS + 2 },
    };
    const report = {
      schemaVersion: 1,
      benchmarkLayer: "engine",
      experiment: "adaptive-c3-route-v0.1",
      author: "Wang Runyuan",
      repositoryRevision: "d63eec0a10c327fa52c52e83897cf6e43490df68",
      configuration: {
        repetitions: REPEATS,
        currentRule: {
          maxChangedBytes: CURRENT_MAX_DELTA_BYTES,
          maxRanges: CURRENT_MAX_RANGES,
        },
        calibrationFileBytes: 4 * MIB,
        heldOutFileBytes: [1 * MIB, 16 * MIB],
        sampleColumns: [
          "applyMs",
          "publishMs",
          "totalMs",
          "sqlitePayloadBytes",
          "peakBranchBytes",
          "retainedGrowthBytes",
          "databaseGrowthBytes",
        ],
      },
      calibratedRule,
      aggregates: {
        calibration: {
          current: evaluate(calibration, (result) => result.currentRoute),
          adaptive: evaluate(calibration, (result) => ruleRoute(result, calibratedRule)),
          oracle: evaluate(calibration, (result) => result.oracleRoute),
        },
        heldOut: {
          current: currentHeldOut,
          adaptive: adaptiveHeldOut,
          oracle: oracleHeldOut,
        },
      },
      hypotheses,
      results,
    };

    expect(results).toHaveLength(45);
    expect(hypotheses.H4_correctness.passed).toBe(true);
    console.log(`ADAPTIVE_ROUTE_JSON:${JSON.stringify(report)}`);
  });
});
