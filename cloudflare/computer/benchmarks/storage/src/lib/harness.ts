import {
  type DurableObjectStorageLike,
  Workspace,
} from "@cloudflare/computer";
import { env, runInDurableObject } from "cloudflare:test";
import type { TestBindings } from "../../tests/worker";
import {
  computerRead,
  initializeRawSchema,
  rawDelete,
  rawList,
  rawRead,
  rawStat,
  rawWrite,
  snapshotComputer,
  snapshotRaw,
} from "./storage";
import type { BenchmarkEngine, StorageSnapshot } from "./types";

type Sql = DurableObjectStorage["sql"];

export interface FileAdapter {
  readonly engine: BenchmarkEngine;
  readonly sql: Sql;
  prepareDirectory(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  stat(path: string): Promise<number>;
  snapshot(): StorageSnapshot;
}

function freshStub(): DurableObjectStub {
  const namespace = (env as unknown as TestBindings).BenchmarkStorage;
  return namespace.get(namespace.newUniqueId());
}

export async function withEngine<T>(
  engine: BenchmarkEngine,
  operation: (adapter: FileAdapter) => T | Promise<T>,
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const sql = state.storage.sql;
    if (engine === "raw-sqlite") {
      initializeRawSchema(sql);
      const adapter: FileAdapter = {
        engine,
        sql,
        async prepareDirectory() {},
        async write(path, bytes) {
          rawWrite(state.storage, path, bytes);
        },
        async read(path) {
          return rawRead(sql, path);
        },
        async remove(path) {
          rawDelete(state.storage, path);
        },
        async list(prefix) {
          return rawList(sql, prefix);
        },
        async stat(path) {
          return rawStat(sql, path);
        },
        snapshot() {
          return snapshotRaw(sql);
        },
      };
      return operation(adapter);
    }

    const workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      sessionId: state.id.toString(),
    });
    const adapter: FileAdapter = {
      engine,
      sql,
      async prepareDirectory(path) {
        await workspace.fs.mkdir(path, { recursive: true });
      },
      async write(path, bytes) {
        await workspace.fs.writeFile(path, bytes);
      },
      async read(path) {
        return computerRead(workspace, path);
      },
      async remove(path) {
        await workspace.fs.rm(path, { force: true, recursive: true });
      },
      async list(prefix) {
        return workspace.fs.ls(prefix);
      },
      async stat(path) {
        return (await workspace.fs.stat(path)).size;
      },
      snapshot() {
        return snapshotComputer(sql);
      },
    };

    try {
      return await operation(adapter);
    } finally {
      await workspace.close();
    }
  });
}
