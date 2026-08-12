import { env, runInDurableObject } from "cloudflare:test";
import type { TestBindings } from "../../tests/worker";
import { createEngine } from "../engines/factory";
import type { EngineName, WorkspaceStorageEngine } from "../engines/types";

export interface EngineContext {
  engine: WorkspaceStorageEngine;
  sql: DurableObjectStorage["sql"];
  storage: DurableObjectStorage;
}

function freshStub(): DurableObjectStub {
  const namespace = (env as unknown as TestBindings).BenchmarkStorage;
  return namespace.get(namespace.newUniqueId());
}

export async function withEngine<T>(
  name: EngineName,
  operation: (context: EngineContext) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(
    freshStub(),
    async (_instance: unknown, state: DurableObjectState) => {
      const engine = createEngine(name, state.storage);
      engine.initialize();
      return operation({ engine, sql: state.storage.sql, storage: state.storage });
    },
  );
}
