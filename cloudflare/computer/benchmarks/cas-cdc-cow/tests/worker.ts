import { DurableObject } from "cloudflare:workers";
import { createEngine } from "../src/engines/factory";
import type { EngineName, WorkspaceStorageEngine } from "../src/engines/types";
import { fixtureBytes } from "../src/lib/fixtures";

export interface TestBindings {
  BenchmarkStorage: DurableObjectNamespace<BenchmarkStorage>;
}

interface SeedRequest {
  engine?: EngineName;
  files: Array<{ path: string; size: number; seed: number }>;
}

interface EditRequest {
  branchId: string;
  path: string;
  offset: number;
  value: number;
}

interface PublishRequest {
  branchId: string;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

/**
 * Test-only Durable Object surface for exercising independent agent requests.
 *
 * The regular benchmark calls the engine directly with runInDurableObject().
 * These endpoints deliberately send branch edits and publications through
 * separate Durable Object requests so Promise.all() tests include the object
 * input gate and request scheduling, not only in-process method calls.
 */
export class BenchmarkStorage extends DurableObject<TestBindings> {
  #engine: WorkspaceStorageEngine | undefined;

  constructor(state: DurableObjectState, env: TestBindings) {
    super(state, env);
  }

  #requireEngine(): WorkspaceStorageEngine {
    if (this.#engine === undefined) throw new Error("seed must be called first");
    return this.#engine;
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/seed") {
        const body = await request.json<SeedRequest>();
        if (this.#engine !== undefined) throw new Error("engine is already initialized");
        this.#engine = createEngine(body.engine ?? "cas-cdc-cow", this.ctx.storage);
        this.#engine.initialize();
        for (const file of body.files) {
          await this.#engine.seedFile(file.path, fixtureBytes(file.size, file.seed));
        }
        return json({ seeded: body.files.length });
      }

      if (request.method === "POST" && url.pathname === "/edit") {
        const body = await request.json<EditRequest>();
        const engine = this.#requireEngine();
        engine.createBranch(body.branchId);
        await engine.editFile(
          body.branchId,
          body.path,
          body.offset,
          1,
          new Uint8Array([body.value]),
        );
        return json({ branchId: body.branchId, state: "active" });
      }

      if (request.method === "POST" && url.pathname === "/publish") {
        const body = await request.json<PublishRequest>();
        return json(await this.#requireEngine().publish(body.branchId));
      }

      if (request.method === "GET" && url.pathname === "/byte") {
        const path = url.searchParams.get("path");
        const offset = Number(url.searchParams.get("offset"));
        if (path === null || !Number.isSafeInteger(offset) || offset < 0) {
          return json({ error: "invalid path or offset" }, 400);
        }
        const bytes = await this.#requireEngine().readFile(null, path);
        return json({ value: bytes[offset] });
      }

      if (request.method === "GET" && url.pathname === "/snapshot") {
        return json(this.#requireEngine().snapshot(1));
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("CAS + CDC + COW benchmark", { status: 200 });
  },
} satisfies ExportedHandler<TestBindings>;
