import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { StorageSnapshot } from "../engines/types";
import type { TestBindings } from "../../tests/worker";

interface PublishResponse {
  outcome: "merged" | "conflict";
  commit: number | null;
  conflicts: string[];
}

const AGENTS = 50;
const FILE_BYTES = 256 * 1024;
const EDIT_OFFSET = 100_003;

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

describe("multi-agent Durable Object request boundary", () => {
  it("publishes 50 disjoint agent branches without copying their base files", async () => {
    const stub = freshStub();
    await post(stub, "/seed", {
      files: Array.from({ length: AGENTS }, (_, index) => ({
        path: `/agent-${index}.bin`,
        size: FILE_BYTES,
        seed: 10_000 + index,
      })),
    });

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

    const privateState = await get<StorageSnapshot>(stub, "/snapshot");
    expect(privateState.branchPayloadBytes).toBe(AGENTS * 4 * 1024);

    const publications = await Promise.all(Array.from(
      { length: AGENTS },
      (_, index) => post<PublishResponse>(stub, "/publish", { branchId: `agent-${index}` }),
    ));
    expect(publications.every((result) => result.outcome === "merged")).toBe(true);

    const values = await Promise.all(Array.from({ length: AGENTS }, (_, index) => get<{
      value: number;
    }>(stub, `/byte?path=${encodeURIComponent(`/agent-${index}.bin`)}&offset=${EDIT_OFFSET}`)));
    expect(values.map(({ value }) => value)).toEqual(
      Array.from({ length: AGENTS }, (_, index) => index + 1),
    );
  });

  it("turns 49 stale same-file publications into explicit conflicts", async () => {
    const stub = freshStub();
    await post(stub, "/seed", {
      files: [{ path: "/shared.bin", size: FILE_BYTES, seed: 20_000 }],
    });

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

    const publications = await Promise.all(Array.from(
      { length: AGENTS },
      (_, index) => post<PublishResponse>(stub, "/publish", { branchId: `agent-${index}` }),
    ));
    const merged = publications.filter((result) => result.outcome === "merged");
    const conflicts = publications.filter((result) => result.outcome === "conflict");
    expect(merged).toHaveLength(1);
    expect(conflicts).toHaveLength(AGENTS - 1);
    expect(conflicts.every((result) => result.conflicts[0] === "/shared.bin")).toBe(true);

    const final = await get<{ value: number }>(
      stub,
      `/byte?path=${encodeURIComponent("/shared.bin")}&offset=${EDIT_OFFSET}`,
    );
    const winner = publications.findIndex((result) => result.outcome === "merged") + 1;
    expect(final.value).toBe(winner);
  });
});
