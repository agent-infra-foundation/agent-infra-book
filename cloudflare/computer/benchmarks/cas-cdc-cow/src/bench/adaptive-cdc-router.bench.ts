import { describe, expect, it } from "vitest";
import {
  CasCdcCowWorkspaceStore,
  EXPERIMENTAL_ADAPTIVE_C3_POLICY,
  type C3ExperimentMetrics,
  type ExperimentalRangeEdit,
} from "../engines/cas-cdc-cow";
import { nowMs } from "../engines/util";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const KIB = 1024;
const MIB = 1024 * KIB;
const PAGE_BYTES = 4 * KIB;
const MAX_RANGE_BYTES = 64 * KIB;
const REPEATS = 5;

const ROUTES = [
  "single-window-cow",
  "raw-multi-window-cow",
  "coalesced-multi-window-cow",
  "adaptive-cow",
  "materialized",
] as const;

type Route = typeof ROUTES[number];
type Distribution = "midpoint" | "clustered" | "spread";

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
  ranges: ExperimentalRangeEdit[];
  dirtySpanBytes: number;
  dirtySpanRatio: number;
  touchedPages: number;
  touchedPageRatio: number;
}

interface Measurement extends C3ExperimentMetrics {
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
  fastestRoute: Route;
}

const SAMPLE_COLUMNS = [
  "applyMs",
  "publishMs",
  "totalMs",
  "sqlitePayloadBytes",
  "peakBranchBytes",
  "retainedGrowthBytes",
  "databaseGrowthBytes",
  "cdcScanBytes",
  "cdcWindowCount",
  "fullManifestCount",
  "pageLoadBytes",
  "pageLoadCount",
  "pageUpsertCount",
  "editFileCalls",
  "editFileRangesCalls",
  "multiWindowMergeCount",
  "multiWindowResyncCount",
  "multiWindowOriginalRunCount",
  "multiWindowPlannedRunCount",
  "scanBudgetAbortCount",
  "adaptivePlanCount",
  "adaptiveOriginalRunCount",
  "adaptiveCoalescedRunCount",
  "adaptiveEstimatedSingleScanBytes",
  "adaptiveEstimatedMultiScanBytes",
  "adaptiveScanBudgetBytes",
  "adaptiveSelectedSingleWindowCount",
  "adaptiveSelectedMultiWindowCount",
  "adaptiveSelectedFullScanCount",
  "adaptiveBudgetFallbackCount",
] as const satisfies ReadonlyArray<keyof Measurement>;

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function scenarioDefinitions(): ScenarioDefinition[] {
  const definitions: ScenarioDefinition[] = [];
  for (const fileBytes of [4 * MIB, 16 * MIB]) {
    for (const changedBytes of [16 * KIB, 64 * KIB, 256 * KIB]) {
      for (const rangeCount of [1, 4, 16, 64]) {
        const rangeBytes = changedBytes / rangeCount;
        if (!Number.isInteger(rangeBytes) || rangeBytes > MAX_RANGE_BYTES) continue;
        const distributions: Distribution[] = rangeCount === 1
          ? ["midpoint"]
          : ["clustered", "spread"];
        for (const distribution of distributions) {
          definitions.push({
            id: [
              `${fileBytes / MIB}m`,
              `${changedBytes / KIB}k`,
              `${rangeCount}r`,
              distribution,
            ].join("-"),
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

function rangeOffsets(definition: ScenarioDefinition, rangeBytes: number): number[] {
  if (definition.rangeCount === 1) {
    return [Math.floor((definition.fileBytes - rangeBytes) / (2 * PAGE_BYTES)) * PAGE_BYTES];
  }
  const filePages = Math.floor(definition.fileBytes / PAGE_BYTES);
  const rangePages = Math.ceil(rangeBytes / PAGE_BYTES);
  const minimumRegionPages = definition.rangeCount * rangePages;
  const desiredRegionBytes = definition.distribution === "spread"
    ? definition.fileBytes
    : Math.max(definition.changedBytes * 2, Math.floor(definition.fileBytes / 8));
  const regionPages = Math.min(
    filePages,
    Math.max(minimumRegionPages, Math.ceil(desiredRegionBytes / PAGE_BYTES)),
  );
  const regionStartPage = Math.floor((filePages - regionPages) / 2);
  const availableStartPages = regionPages - rangePages;
  const offsets: number[] = [];
  for (let index = 0; index < definition.rangeCount; index++) {
    const relativePage = Math.floor(
      availableStartPages * index / (definition.rangeCount - 1),
    );
    const offset = (regionStartPage + relativePage) * PAGE_BYTES;
    const previous = offsets.at(-1);
    if (previous !== undefined && offset < previous + rangeBytes) {
      throw new Error(`overlapping page-aligned ranges: ${definition.id}`);
    }
    if (offset + rangeBytes > definition.fileBytes) {
      throw new Error(`range exceeds file: ${definition.id}`);
    }
    offsets.push(offset);
  }
  return offsets;
}

function buildWorkload(definition: ScenarioDefinition): Workload {
  const base = fixtureBytes(definition.fileBytes, 0x5a17 + definition.fileBytes / MIB);
  const expected = new Uint8Array(base);
  const rangeBytes = definition.changedBytes / definition.rangeCount;
  const offsets = rangeOffsets(definition, rangeBytes);
  const ranges: ExperimentalRangeEdit[] = [];
  const pages = new Set<number>();

  for (const offset of offsets) {
    const bytes = new Uint8Array(rangeBytes);
    for (let local = 0; local < rangeBytes; local++) {
      bytes[local] = base[offset + local] ^ 0xff;
    }
    expected.set(bytes, offset);
    ranges.push({ offset, bytes });
    const firstPage = Math.floor(offset / PAGE_BYTES);
    const lastPage = Math.floor((offset + rangeBytes - 1) / PAGE_BYTES);
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
    touchedPageRatio: pages.size / Math.ceil(definition.fileBytes / PAGE_BYTES),
  };
}

async function measure(
  route: Route,
  definition: ScenarioDefinition,
  workload: Workload,
): Promise<Measurement> {
  return withEngine("cas-cdc-cow", async ({ engine, sql }) => {
    const c3 = engine as CasCdcCowWorkspaceStore;
    await c3.seedFile("/workspace.bin", workload.base);
    c3.createBranch("agent-a");
    c3.resetCounters();
    if (route === "raw-multi-window-cow") {
      c3.setExperimentalPagePublishStrategy("agent-a", "multi-window");
    } else if (route === "coalesced-multi-window-cow") {
      c3.setExperimentalPagePublishStrategy("agent-a", "coalesced-multi-window");
    } else if (route === "adaptive-cow") {
      c3.setExperimentalPagePublishStrategy("agent-a", "adaptive");
    }
    const before = c3.snapshot(1);
    const databaseBefore = sql.databaseSize;

    const applyStarted = nowMs();
    if (route === "materialized") {
      await c3.writeBranchFile("agent-a", "/workspace.bin", workload.expected);
    } else {
      await c3.editFileRanges("agent-a", "/workspace.bin", workload.ranges);
    }
    const applyMs = nowMs() - applyStarted;
    const afterApply = c3.snapshot(1);

    const publishStarted = nowMs();
    const published = await c3.publish("agent-a");
    const publishMs = nowMs() - publishStarted;
    if (published.outcome !== "merged") {
      throw new Error(`${definition.id}/${route} unexpectedly conflicted`);
    }

    const afterPublish = c3.snapshot(1);
    const actual = await c3.readFile(null, "/workspace.bin");
    if (!bytesEqual(actual, workload.expected)) {
      throw new Error(`${definition.id}/${route} produced incorrect bytes`);
    }
    return {
      applyMs,
      publishMs,
      totalMs: applyMs + publishMs,
      sqlitePayloadBytes: c3.counters.sqlitePayloadBytes,
      peakBranchBytes: afterApply.branchStorage.totalExclusivePayloadBytes,
      retainedGrowthBytes: Math.max(0, afterPublish.storedPayloadBytes - before.storedPayloadBytes),
      databaseGrowthBytes: Math.max(0, sql.databaseSize - databaseBefore),
      ...c3.experimentalMetrics,
    };
  });
}

function aggregate(measurements: Measurement[]): RouteAggregate {
  const values = Object.fromEntries(SAMPLE_COLUMNS.map((field) => [
    field,
    round(median(measurements.map((measurement) => measurement[field]))),
  ])) as unknown as Measurement;
  return {
    ...values,
    samples: measurements.map((measurement) => (
      SAMPLE_COLUMNS.map((field) => round(measurement[field]))
    )),
  };
}

function rotatedRoutes(scenarioIndex: number, repeat: number): Route[] {
  const shift = (scenarioIndex + repeat) % ROUTES.length;
  return [...ROUTES.slice(shift), ...ROUTES.slice(0, shift)];
}

describe("C3 adaptive CDC router", () => {
  it("runs the frozen five-route v0.4 engineering benchmark", async () => {
    const definitions = scenarioDefinitions();
    expect(definitions).toHaveLength(40);

    const warmupDefinition: ScenarioDefinition = {
      id: "warmup",
      fileBytes: 4 * MIB,
      changedBytes: 16 * KIB,
      rangeCount: 4,
      distribution: "spread",
    };
    const warmup = buildWorkload(warmupDefinition);
    for (const route of ROUTES) await measure(route, warmupDefinition, warmup);

    const results: ScenarioResult[] = [];
    for (let scenarioIndex = 0; scenarioIndex < definitions.length; scenarioIndex++) {
      const definition = definitions[scenarioIndex];
      const workload = buildWorkload(definition);
      const measurements = Object.fromEntries(
        ROUTES.map((route) => [route, [] as Measurement[]]),
      ) as Record<Route, Measurement[]>;
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        for (const route of rotatedRoutes(scenarioIndex, repeat)) {
          measurements[route].push(await measure(route, definition, workload));
        }
      }
      const routes = Object.fromEntries(ROUTES.map((route) => [
        route,
        aggregate(measurements[route]),
      ])) as Record<Route, RouteAggregate>;
      const fastestRoute = [...ROUTES].sort(
        (left, right) => routes[left].totalMs - routes[right].totalMs,
      )[0];
      const result: ScenarioResult = {
        ...definition,
        dirtySpanBytes: workload.dirtySpanBytes,
        dirtySpanRatio: round(workload.dirtySpanRatio),
        touchedPages: workload.touchedPages,
        touchedPageRatio: round(workload.touchedPageRatio),
        routes,
        fastestRoute,
      };
      results.push(result);
      if ((scenarioIndex + 1) % 5 === 0 || scenarioIndex + 1 === definitions.length) {
        console.log(
          `ADAPTIVE_CDC_ROUTER_PROGRESS:${scenarioIndex + 1}/${definitions.length}:` +
          `${result.id}:` +
          ROUTES.map((route) => `${route}=${routes[route].totalMs}ms`).join(","),
        );
      }
    }

    const retainedGrowthMismatches = results.filter((result) => {
      const values = ROUTES.map((route) => result.routes[route].retainedGrowthBytes);
      return new Set(values).size !== 1;
    });
    const report = {
      schemaVersion: 1,
      benchmarkLayer: "engine",
      experiment: "c3-adaptive-cdc-router-v0.4",
      date: "2026-08-09",
      author: "Wang Runyuan",
      repositoryBaseRevision: "d63eec0a10c327fa52c52e83897cf6e43490df68",
      scope: "experimental five-route comparison; no production default change",
      configuration: {
        repetitions: REPEATS,
        scenarios: definitions.length,
        routes: ROUTES,
        formalExecutions: definitions.length * ROUTES.length * REPEATS,
        warmupCorrectnessExecutions: ROUTES.length,
        correctnessExecutions: definitions.length * ROUTES.length * REPEATS + ROUTES.length,
        fileBytes: [4 * MIB, 16 * MIB],
        changedBytes: [16 * KIB, 64 * KIB, 256 * KIB],
        rangeCounts: [1, 4, 16, 64],
        layouts: ["midpoint", "clustered", "spread"],
        casState: "cold/fresh Durable Object per route measurement",
        routeOrder: "five-repeat cyclic rotation; every route occupies every order position",
        adaptivePolicy: EXPERIMENTAL_ADAPTIVE_C3_POLICY,
        expectedAdaptiveSelections: {
          singleWindow: 22,
          multiWindow: 6,
          fullScan: 12,
        },
        sampleColumns: SAMPLE_COLUMNS,
      },
      retainedGrowthMismatches: retainedGrowthMismatches.map((result) => result.id),
      results,
    };

    expect(retainedGrowthMismatches).toHaveLength(0);
    console.log(`ADAPTIVE_CDC_ROUTER_JSON:${JSON.stringify(report)}`);
  });
});
