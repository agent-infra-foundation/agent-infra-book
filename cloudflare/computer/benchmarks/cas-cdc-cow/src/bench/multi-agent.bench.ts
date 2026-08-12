import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  EngineName,
  PublishResult,
  StorageSnapshot,
} from "../engines/types";
import type { TestBindings } from "../../tests/worker";

const AGENTS = 50;
const FILE_BYTES = 256 * 1024;
const EDIT_OFFSET = 100_003;
const engines: EngineName[] = ["naive", "cas-cdc-cow"];

interface ScenarioResult {
  editMs: number;
  publishMs: number;
  privateCowPagePayloadBytes: number;
  branchExclusiveContentBytes: number;
  branchDatabaseGrowthBytes: number;
  merged: number;
  conflicts: number;
  silentLostUpdates: number;
  correctFiles: number;
}

interface EngineResult {
  disjoint: ScenarioResult;
  sameFile: ScenarioResult;
}

function nowMs(): number {
  return Math.round(performance.now() * 1_000) / 1_000;
}

function freshStub(): DurableObjectStub {
  const namespace = (env as unknown as TestBindings).BenchmarkStorage;
  return namespace.get(namespace.newUniqueId());
}

async function post<T>(stub: DurableObjectStub, path: string, body: unknown): Promise<T> {
  const response = await stub.fetch(`http://benchmark${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json<T & { error?: string }>();
  if (!response.ok) throw new Error(result.error ?? `request failed: ${response.status}`);
  return result;
}

async function get<T>(stub: DurableObjectStub, path: string): Promise<T> {
  const response = await stub.fetch(`http://benchmark${path}`);
  const result = await response.json<T & { error?: string }>();
  if (!response.ok) throw new Error(result.error ?? `request failed: ${response.status}`);
  return result;
}

async function runDisjoint(engine: EngineName): Promise<ScenarioResult> {
  const stub = freshStub();
  await post(stub, "/seed", {
    engine,
    files: Array.from({ length: AGENTS }, (_, index) => ({
      path: `/agent-${index}.bin`,
      size: FILE_BYTES,
      seed: 30_000 + index,
    })),
  });
  const seeded = await get<StorageSnapshot>(stub, "/snapshot");

  const editStart = nowMs();
  await Promise.all(Array.from({ length: AGENTS }, (_, index) => post(
    stub,
    "/edit",
    {
      branchId: `agent-${index}`,
      path: `/agent-${index}.bin`,
      offset: EDIT_OFFSET,
      value: index + 1,
    },
  )));
  const editMs = nowMs() - editStart;
  const snapshot = await get<StorageSnapshot>(stub, "/snapshot");

  const publishStart = nowMs();
  const publications = await Promise.all(Array.from(
    { length: AGENTS },
    (_, index) => post<PublishResult>(stub, "/publish", { branchId: `agent-${index}` }),
  ));
  const publishMs = nowMs() - publishStart;
  const values = await Promise.all(Array.from({ length: AGENTS }, (_, index) => get<{
    value: number;
  }>(stub, `/byte?path=${encodeURIComponent(`/agent-${index}.bin`)}&offset=${EDIT_OFFSET}`)));
  const correctFiles = values.filter(({ value }, index) => value === index + 1).length;

  return {
    editMs,
    publishMs,
    privateCowPagePayloadBytes: snapshot.branchStorage.cowPageBytes,
    branchExclusiveContentBytes: snapshot.branchStorage.totalExclusivePayloadBytes,
    branchDatabaseGrowthBytes: Math.max(0, snapshot.databaseBytes - seeded.databaseBytes),
    merged: publications.filter(({ outcome }) => outcome === "merged").length,
    conflicts: publications.filter(({ outcome }) => outcome === "conflict").length,
    silentLostUpdates: AGENTS - correctFiles,
    correctFiles,
  };
}

async function runSameFile(engine: EngineName): Promise<ScenarioResult> {
  const stub = freshStub();
  await post(stub, "/seed", {
    engine,
    files: [{ path: "/shared.bin", size: FILE_BYTES, seed: 40_000 }],
  });
  const seeded = await get<StorageSnapshot>(stub, "/snapshot");

  const editStart = nowMs();
  await Promise.all(Array.from({ length: AGENTS }, (_, index) => post(
    stub,
    "/edit",
    {
      branchId: `agent-${index}`,
      path: "/shared.bin",
      offset: EDIT_OFFSET,
      value: index + 1,
    },
  )));
  const editMs = nowMs() - editStart;
  const snapshot = await get<StorageSnapshot>(stub, "/snapshot");

  const publishStart = nowMs();
  const publications = await Promise.all(Array.from(
    { length: AGENTS },
    (_, index) => post<PublishResult>(stub, "/publish", { branchId: `agent-${index}` }),
  ));
  const publishMs = nowMs() - publishStart;
  const merged = publications.filter(({ outcome }) => outcome === "merged").length;
  const conflicts = publications.filter(({ outcome }) => outcome === "conflict").length;
  const final = await get<{ value: number }>(
    stub,
    `/byte?path=${encodeURIComponent("/shared.bin")}&offset=${EDIT_OFFSET}`,
  );
  const winningValues = publications.flatMap((result, index) =>
    result.outcome === "merged" ? [index + 1] : []
  );
  const finalIsDeclaredWinner = winningValues.includes(final.value);

  return {
    editMs,
    publishMs,
    privateCowPagePayloadBytes: snapshot.branchStorage.cowPageBytes,
    branchExclusiveContentBytes: snapshot.branchStorage.totalExclusivePayloadBytes,
    branchDatabaseGrowthBytes: Math.max(0, snapshot.databaseBytes - seeded.databaseBytes),
    merged,
    conflicts,
    silentLostUpdates: finalIsDeclaredWinner ? Math.max(0, merged - 1) : merged,
    correctFiles: Number(finalIsDeclaredWinner),
  };
}

describe("50-agent branch publication", () => {
  it("measures logically concurrent requests through one Durable Object", async () => {
    const results = {} as Record<EngineName, EngineResult>;
    for (const engine of engines) {
      results[engine] = {
        disjoint: await runDisjoint(engine),
        sameFile: await runSameFile(engine),
      };
    }

    expect(results["cas-cdc-cow"].disjoint.correctFiles).toBe(AGENTS);
    expect(results["cas-cdc-cow"].sameFile.merged).toBe(1);
    expect(results["cas-cdc-cow"].sameFile.conflicts).toBe(AGENTS - 1);
    expect(results["cas-cdc-cow"].sameFile.silentLostUpdates).toBe(0);
    console.log(`MULTI_AGENT_JSON:${JSON.stringify({
      schemaVersion: 1,
      benchmarkLayer: "Durable Object request",
      configuration: { agents: AGENTS, fileBytes: FILE_BYTES, editBytes: 1 },
      results,
    })}`);
  });
});
