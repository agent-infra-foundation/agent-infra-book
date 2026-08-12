import { describe, expect, it } from "vitest";
import {
  CasCdcCowWorkspaceStore,
  type ExperimentalRangeEdit,
} from "../engines/cas-cdc-cow";
import { nowMs } from "../engines/util";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const KIB = 1024;
const MIB = 1024 * KIB;
const PAGE_BYTES = 4 * KIB;
const REPEATS = 6;
const BASE_REVISION = "e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3";
const ROUTES = ["full-materialization", "manifest-overlay-stream"] as const;

type Route = typeof ROUTES[number];
type Distribution = "clustered" | "spread";

interface ScenarioDefinition {
  id: string;
  fileBytes: number;
  pageCount: number;
  distribution: Distribution;
}

interface Workload {
  base: Uint8Array;
  expected: Uint8Array;
  ranges: ExperimentalRangeEdit[];
}

interface Measurement {
  localMs: number;
  wirePayloadBytes: number;
  hashedBytes: number;
  peakAlgorithmicPayloadBytes: number;
  completeFileMaterializations: number;
  recipeMetadataBytes: number;
  literalBytes: number;
  referencedBytes: number;
  extentCount: number;
  objectRangeReadCount: number;
  correctness: boolean;
  storageUnchanged: boolean;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function definitions(): ScenarioDefinition[] {
  const rows: ScenarioDefinition[] = [];
  for (const fileBytes of [MIB, 16 * MIB]) {
    for (const pageCount of [1, 4, 16]) {
      for (const distribution of ["clustered", "spread"] as const) {
        rows.push({
          id: `${fileBytes / MIB}m-${distribution}-${pageCount}-pages`,
          fileBytes,
          pageCount,
          distribution,
        });
      }
    }
  }
  return rows;
}

function pageOffsets(definition: ScenarioDefinition): number[] {
  const filePages = definition.fileBytes / PAGE_BYTES;
  if (definition.distribution === "clustered") {
    const start = Math.floor((filePages - definition.pageCount) / 2);
    return Array.from(
      { length: definition.pageCount },
      (_, index) => (start + index) * PAGE_BYTES,
    );
  }
  if (definition.pageCount === 1) return [Math.floor(filePages / 2) * PAGE_BYTES];
  return Array.from(
    { length: definition.pageCount },
    (_, index) => Math.floor((filePages - 1) * index / (definition.pageCount - 1)) * PAGE_BYTES,
  );
}

function workload(definition: ScenarioDefinition): Workload {
  const base = fixtureBytes(
    definition.fileBytes,
    0x5105 + definition.fileBytes / MIB + definition.pageCount,
  );
  const expected = new Uint8Array(base);
  const ranges = pageOffsets(definition).map((offset) => {
    const bytes = new Uint8Array(PAGE_BYTES);
    for (let index = 0; index < bytes.byteLength; index++) {
      bytes[index] = base[offset + index] ^ 0xff;
    }
    expected.set(bytes, offset);
    return { offset, bytes };
  });
  return { base, expected, ranges };
}

function storageFingerprint(
  c3: CasCdcCowWorkspaceStore,
  sql: DurableObjectStorage["sql"],
): string {
  return JSON.stringify({ snapshot: c3.snapshot(1), databaseSize: sql.databaseSize });
}

async function measure(
  route: Route,
  definition: ScenarioDefinition,
  input: Workload,
): Promise<Measurement> {
  return withEngine("cas-cdc-cow", async ({ engine, sql }) => {
    const c3 = engine as CasCdcCowWorkspaceStore;
    await c3.seedFile("/workspace.bin", input.base);
    c3.createBranch("agent-a");
    await c3.editFileRanges("agent-a", "/workspace.bin", input.ranges);
    const before = storageFingerprint(c3, sql);

    let actual: Uint8Array | undefined;
    let recipe: ReturnType<CasCdcCowWorkspaceStore["exportExperimentalSparseRecipe"]> | undefined;
    let objectRangeReadCount = 0;
    let peakAlgorithmicPayloadBytes = definition.fileBytes;
    const started = nowMs();
    if (route === "full-materialization") {
      actual = await c3.readFile("agent-a", "/workspace.bin");
    } else {
      recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      const consumed = c3.consumeExperimentalSparseRecipe(recipe);
      objectRangeReadCount = consumed.objectRangeReadCount;
      peakAlgorithmicPayloadBytes = Math.max(
        consumed.peakAlgorithmicPayloadBytes,
        recipe.metadataBytes + recipe.literalBytes,
      );
    }
    const localMs = nowMs() - started;

    const correctness = route === "full-materialization"
      ? actual !== undefined && bytesEqual(actual, input.expected)
      : recipe !== undefined && c3.verifyExperimentalSparseRecipe(recipe, input.expected);
    const after = storageFingerprint(c3, sql);
    return {
      localMs: round(localMs),
      wirePayloadBytes: definition.fileBytes,
      hashedBytes: route === "full-materialization"
        ? definition.fileBytes
        : recipe!.literalBytes,
      peakAlgorithmicPayloadBytes,
      completeFileMaterializations: route === "full-materialization" ? 1 : 0,
      recipeMetadataBytes: recipe?.metadataBytes ?? 0,
      literalBytes: recipe?.literalBytes ?? definition.fileBytes,
      referencedBytes: recipe?.referencedBytes ?? 0,
      extentCount: recipe?.extents.length ?? 1,
      objectRangeReadCount,
      correctness,
      storageUnchanged: before === after,
    };
  });
}

function aggregate(samples: Measurement[]) {
  const numericFields = [
    "localMs",
    "wirePayloadBytes",
    "hashedBytes",
    "peakAlgorithmicPayloadBytes",
    "completeFileMaterializations",
    "recipeMetadataBytes",
    "literalBytes",
    "referencedBytes",
    "extentCount",
    "objectRangeReadCount",
  ] as const satisfies ReadonlyArray<keyof Measurement>;
  return {
    ...Object.fromEntries(numericFields.map((field) => [
      field,
      round(median(samples.map((sample) => sample[field] as number))),
    ])),
    correctness: samples.every((sample) => sample.correctness),
    storageUnchanged: samples.every((sample) => sample.storageUnchanged),
    samples,
  };
}

function rotatedRoutes(scenarioIndex: number, repeat: number): Route[] {
  return (scenarioIndex + repeat) % 2 === 0
    ? [...ROUTES]
    : [ROUTES[1], ROUTES[0]];
}

describe("C3 no-cache sparse transfer v0.5", () => {
  it("runs the frozen two-route mechanism benchmark", async () => {
    const scenarios = definitions();
    expect(scenarios).toHaveLength(12);

    const warmupDefinition = scenarios[0];
    const warmupWorkload = workload(warmupDefinition);
    for (const route of ROUTES) {
      const result = await measure(route, warmupDefinition, warmupWorkload);
      expect(result.correctness && result.storageUnchanged).toBe(true);
    }

    const results = [];
    for (const [scenarioIndex, definition] of scenarios.entries()) {
      const input = workload(definition);
      const routeSamples = Object.fromEntries(
        ROUTES.map((route) => [route, [] as Measurement[]]),
      ) as Record<Route, Measurement[]>;
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        for (const route of rotatedRoutes(scenarioIndex, repeat)) {
          routeSamples[route].push(await measure(route, definition, input));
        }
      }
      const routes = Object.fromEntries(ROUTES.map((route) => [
        route,
        aggregate(routeSamples[route]),
      ]));
      results.push({ ...definition, routes });
      console.log(`SPARSE_TRANSFER_PROGRESS:${scenarioIndex + 1}/${scenarios.length}:${definition.id}`);
    }

    const formalRecords = results.flatMap((row) => (
      ROUTES.flatMap((route) => row.routes[route].samples)
    ));
    expect(formalRecords).toHaveLength(144);
    expect(formalRecords.every((record) => record.correctness)).toBe(true);
    expect(formalRecords.every((record) => record.storageUnchanged)).toBe(true);

    console.log(`SPARSE_TRANSFER_JSON:${JSON.stringify({
      schemaVersion: 1,
      experiment: "c3-no-cache-sparse-transfer-v0.5-recovery-rerun",
      date: "2026-08-10",
      author: "Wang Runyuan",
      repositoryBaseRevision: BASE_REVISION,
      recoveryNotice: "fresh rerun after the unpushed local workspace was pruned; not the lost original bytes",
      scope: "read-only engine-layer prototype; no persistent receiver cache; no default route change",
      configuration: {
        scenarios: scenarios.length,
        routes: ROUTES,
        repetitions: REPEATS,
        formalExecutions: scenarios.length * ROUTES.length * REPEATS,
        warmupExecutions: ROUTES.length,
        fileBytes: [MIB, 16 * MIB],
        pageCounts: [1, 4, 16],
        distributions: ["clustered", "spread"],
        routeOrder: "balanced alternating order",
        receiverCache: "none",
      },
      correctness: {
        formalPassed: formalRecords.filter((record) => record.correctness).length,
        storageUnchanged: formalRecords.filter((record) => record.storageUnchanged).length,
      },
      results,
    })}`);
  });
});
