import { describe, expect, it } from "vitest";
import {
  CasCdcCowWorkspaceStore,
  type ExperimentalRangeEdit,
  type ExperimentalRecipeRange,
} from "../engines/cas-cdc-cow";
import { nowMs } from "../engines/util";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const KIB = 1024;
const MIB = 1024 * KIB;
const PAGE_BYTES = 4 * KIB;
const REPEATS = 3;
const BASE_REVISION = "e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3";
const ROUTES = ["full-materialization", "full-recipe-stream", "range-recipe"] as const;
const ACCESS_SHAPES = [
  "first-4k",
  "dirty-neighborhood-8k",
  "three-spread-4k",
  "quarter-sequential",
  "full-sequential",
] as const;

type Route = typeof ROUTES[number];
type AccessShape = typeof ACCESS_SHAPES[number];

interface WorkloadDefinition {
  id: string;
  fileBytes: number;
  dirtyPages: number;
  distribution: "clustered" | "spread";
}

interface ScenarioDefinition extends WorkloadDefinition {
  accessShape: AccessShape;
}

interface Workload {
  base: Uint8Array;
  expected: Uint8Array;
  edits: ExperimentalRangeEdit[];
  editOffsets: number[];
}

interface Measurement {
  localMs: number;
  requestedBytes: number;
  payloadBytes: number;
  recipeMetadataBytes: number;
  planningHashedBytes: number;
  peakAlgorithmicPayloadBytes: number;
  completeFileMaterializations: number;
  objectRangeReadCount: number;
  literalReadCount: number;
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

function workloadDefinitions(): WorkloadDefinition[] {
  return [
    { id: "1m-clustered-1-page", fileBytes: MIB, dirtyPages: 1, distribution: "clustered" },
    { id: "4m-spread-4-pages", fileBytes: 4 * MIB, dirtyPages: 4, distribution: "spread" },
    { id: "16m-spread-16-pages", fileBytes: 16 * MIB, dirtyPages: 16, distribution: "spread" },
  ];
}

function scenarios(): ScenarioDefinition[] {
  return workloadDefinitions().flatMap((definition) => (
    ACCESS_SHAPES.map((accessShape) => ({ ...definition, accessShape }))
  ));
}

function editOffsets(definition: WorkloadDefinition): number[] {
  const filePages = definition.fileBytes / PAGE_BYTES;
  if (definition.distribution === "clustered") {
    const start = Math.floor((filePages - definition.dirtyPages) / 2);
    return Array.from(
      { length: definition.dirtyPages },
      (_, index) => (start + index) * PAGE_BYTES,
    );
  }
  if (definition.dirtyPages === 1) return [Math.floor(filePages / 2) * PAGE_BYTES];
  return Array.from(
    { length: definition.dirtyPages },
    (_, index) => Math.floor((filePages - 1) * index / (definition.dirtyPages - 1)) * PAGE_BYTES,
  );
}

function buildWorkload(definition: WorkloadDefinition): Workload {
  const base = fixtureBytes(
    definition.fileBytes,
    0x6106 + definition.fileBytes / MIB + definition.dirtyPages,
  );
  const expected = new Uint8Array(base);
  const offsets = editOffsets(definition);
  const edits = offsets.map((offset) => {
    const bytes = new Uint8Array(PAGE_BYTES);
    for (let index = 0; index < bytes.byteLength; index++) {
      bytes[index] = base[offset + index] ^ 0xff;
    }
    expected.set(bytes, offset);
    return { offset, bytes };
  });
  return { base, expected, edits, editOffsets: offsets };
}

function requestedRanges(
  definition: ScenarioDefinition,
  input: Workload,
): ExperimentalRecipeRange[] {
  if (definition.accessShape === "first-4k") {
    return [{ offset: 0, length: PAGE_BYTES }];
  }
  if (definition.accessShape === "dirty-neighborhood-8k") {
    const offset = Math.max(
      0,
      Math.min(definition.fileBytes - 2 * PAGE_BYTES, input.editOffsets[0] - PAGE_BYTES),
    );
    return [{ offset, length: 2 * PAGE_BYTES }];
  }
  if (definition.accessShape === "three-spread-4k") {
    return [0.25, 0.5, 0.75].map((fraction) => ({
      offset: Math.floor(definition.fileBytes * fraction / PAGE_BYTES) * PAGE_BYTES,
      length: PAGE_BYTES,
    }));
  }
  if (definition.accessShape === "quarter-sequential") {
    return [{
      offset: Math.floor(definition.fileBytes / (4 * PAGE_BYTES)) * PAGE_BYTES,
      length: definition.fileBytes / 4,
    }];
  }
  return [{ offset: 0, length: definition.fileBytes }];
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
    await c3.editFileRanges("agent-a", "/workspace.bin", input.edits);
    const ranges = requestedRanges(definition, input);
    const before = storageFingerprint(c3, sql);
    let outputs: Uint8Array[];
    let payloadBytes: number;
    let recipeMetadataBytes = 0;
    let planningHashedBytes: number;
    let peakAlgorithmicPayloadBytes: number;
    let completeFileMaterializations: number;
    let objectRangeReadCount = 0;
    let literalReadCount = 0;

    const started = nowMs();
    if (route === "full-materialization") {
      const file = await c3.readFile("agent-a", "/workspace.bin");
      outputs = ranges.map((range) => new Uint8Array(
        file.subarray(range.offset, range.offset + range.length),
      ));
      payloadBytes = definition.fileBytes;
      planningHashedBytes = definition.fileBytes;
      peakAlgorithmicPayloadBytes = definition.fileBytes;
      completeFileMaterializations = 1;
    } else {
      const recipe = c3.exportExperimentalSparseRecipe("agent-a", "/workspace.bin");
      const read = route === "full-recipe-stream"
        ? c3.readExperimentalSparseRecipeRangesViaFullStream(recipe, ranges)
        : c3.readExperimentalSparseRecipeRanges(recipe, ranges);
      outputs = read.bytes;
      payloadBytes = read.metrics.payloadBytes;
      recipeMetadataBytes = read.metrics.recipeMetadataBytes;
      planningHashedBytes = recipe.literalBytes;
      peakAlgorithmicPayloadBytes = Math.max(
        read.metrics.peakAlgorithmicPayloadBytes,
        recipe.metadataBytes + recipe.literalBytes,
      );
      completeFileMaterializations = read.metrics.completeFileMaterializations;
      objectRangeReadCount = read.metrics.objectRangeReadCount;
      literalReadCount = read.metrics.literalReadCount;
    }
    const localMs = nowMs() - started;

    const correctness = outputs.every((bytes, index) => bytesEqual(
      bytes,
      input.expected.subarray(
        ranges[index].offset,
        ranges[index].offset + ranges[index].length,
      ),
    ));
    const after = storageFingerprint(c3, sql);
    return {
      localMs: round(localMs),
      requestedBytes: ranges.reduce((total, range) => total + range.length, 0),
      payloadBytes,
      recipeMetadataBytes,
      planningHashedBytes,
      peakAlgorithmicPayloadBytes,
      completeFileMaterializations,
      objectRangeReadCount,
      literalReadCount,
      correctness,
      storageUnchanged: before === after,
    };
  });
}

function aggregate(samples: Measurement[]) {
  const numericFields = [
    "localMs",
    "requestedBytes",
    "payloadBytes",
    "recipeMetadataBytes",
    "planningHashedBytes",
    "peakAlgorithmicPayloadBytes",
    "completeFileMaterializations",
    "objectRangeReadCount",
    "literalReadCount",
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
  const shift = (scenarioIndex + repeat) % ROUTES.length;
  return [...ROUTES.slice(shift), ...ROUTES.slice(0, shift)];
}

describe("C3 no-cache range recipe v0.6R", () => {
  it("runs the frozen three-route range-consumer benchmark", async () => {
    const definitions = scenarios();
    expect(definitions).toHaveLength(15);

    const warmupDefinition = definitions[0];
    const warmupWorkload = buildWorkload(warmupDefinition);
    for (const route of ROUTES) {
      const result = await measure(route, warmupDefinition, warmupWorkload);
      expect(result.correctness && result.storageUnchanged).toBe(true);
    }

    const results = [];
    for (const [scenarioIndex, definition] of definitions.entries()) {
      const input = buildWorkload(definition);
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
      console.log(`RANGE_RECIPE_PROGRESS:${scenarioIndex + 1}/${definitions.length}:${definition.id}/${definition.accessShape}`);
    }

    const formalRecords = results.flatMap((row) => (
      ROUTES.flatMap((route) => row.routes[route].samples)
    ));
    expect(formalRecords).toHaveLength(135);
    expect(formalRecords.every((record) => record.correctness)).toBe(true);
    expect(formalRecords.every((record) => record.storageUnchanged)).toBe(true);

    console.log(`RANGE_RECIPE_JSON:${JSON.stringify({
      schemaVersion: 1,
      experiment: "c3-no-cache-range-recipe-v0.6R-recovery-rerun",
      date: "2026-08-10",
      author: "Wang Runyuan",
      repositoryBaseRevision: BASE_REVISION,
      recoveryNotice: "fresh rerun after the unpushed local workspace was pruned; not the lost original bytes",
      scope: "read-only engine-layer prototype; consumer-requested ranges; no persistent receiver cache",
      configuration: {
        scenarios: definitions.length,
        routes: ROUTES,
        repetitions: REPEATS,
        formalExecutions: definitions.length * ROUTES.length * REPEATS,
        warmupExecutions: ROUTES.length,
        workloads: workloadDefinitions(),
        accessShapes: ACCESS_SHAPES,
        sparseAccessShapes: ACCESS_SHAPES.slice(0, 3),
        routeOrder: "three-repeat cyclic rotation; each route occupies every order position",
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
