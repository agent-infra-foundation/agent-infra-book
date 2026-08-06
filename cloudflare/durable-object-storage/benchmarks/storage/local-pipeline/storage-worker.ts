import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorageLike } from "@cloudflare/dofs";
import {
  type BackendHandle,
  Workspace,
  type WorkspaceBackend,
  type WorkspaceAttributes,
  type WorkspaceObserver,
  type WorkspaceSpan,
} from "@cloudflare/computer";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";

interface Env {
  PipelineStorage: DurableObjectNamespace<PipelineStorage>;
  BENCHMARK_MOUNT: string;
  BENCHMARK_WORKLOAD: string;
  COMPUTERD_URL: string;
}

interface TimingSpanRecord {
  name: string;
  durationMs: number;
  attributes: Record<string, boolean | number | string>;
}

class TimingObserver implements WorkspaceObserver {
  #records: TimingSpanRecord[] = [];

  clear(): void {
    this.#records = [];
  }

  snapshot(): TimingSpanRecord[] {
    return this.#records.map((record) => ({
      ...record,
      attributes: { ...record.attributes },
    }));
  }

  async span<T>(
    name: string,
    attributes: WorkspaceAttributes,
    run: (span: WorkspaceSpan) => Promise<T>,
  ): Promise<T> {
    const recordedAttributes: Record<string, boolean | number | string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) recordedAttributes[key] = value;
    }
    const span: WorkspaceSpan = {
      setAttribute(key, value) {
        if (value !== undefined) recordedAttributes[key] = value;
      },
    };
    const started = performance.now();
    try {
      return await run(span);
    } finally {
      this.#records.push({
        name,
        durationMs: roundMs(performance.now() - started),
        attributes: recordedAttributes,
      });
    }
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class LocalComputerdBackend implements WorkspaceBackend {
  readonly id = "local-computerd";
  readonly type = "local-computerd";

  constructor(private readonly url: string) {}

  async connect(): Promise<BackendHandle> {
    const client = createWorkspaceClient({ url: this.url });
    return {
      rpc: client,
      sync: "remote",
      close: () => client.close(),
    };
  }
}

export class PipelineStorage extends DurableObject<Env> {
  readonly #mountPoint: string;
  readonly #state: DurableObjectState;
  readonly #workloadScript: string;
  readonly #workspace: Workspace;
  readonly #observer = new TimingObserver();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    if (!env.BENCHMARK_MOUNT.match(/^\/tmp\/cloudflare-computer-benchmark-[a-f0-9]{12}\/workspace$/)) {
      throw new Error(`unsafe BENCHMARK_MOUNT: ${env.BENCHMARK_MOUNT}`);
    }
    if (!env.BENCHMARK_WORKLOAD.endsWith("/medium-workload.sh")) {
      throw new Error(`unsafe BENCHMARK_WORKLOAD: ${env.BENCHMARK_WORKLOAD}`);
    }
    this.#mountPoint = env.BENCHMARK_MOUNT;
    this.#state = state;
    this.#workloadScript = env.BENCHMARK_WORKLOAD;
    this.#workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
      observer: this.#observer,
    });
  }

  #storageSnapshot() {
    const one = <T extends Record<string, SqlStorageValue>>(query: string): T => {
      const row = this.#state.storage.sql.exec<T>(query).toArray()[0];
      if (row === undefined) throw new Error(`query returned no row: ${query}`);
      return row;
    };
    const files = one<{ files: number; bytes: number }>(
      "SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM vfs_nodes WHERE type = 'file'",
    );
    const nodes = one<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_nodes");
    const chunks = one<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_chunks");
    const blobs = one<{ count: number; bytes: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM vfs_blobs",
    );
    const reachable = one<{ bytes: number }>(
      `SELECT COALESCE(SUM(blob.size), 0) AS bytes
         FROM vfs_blobs AS blob
        WHERE EXISTS (SELECT 1 FROM vfs_chunks AS chunk WHERE chunk.hash = blob.hash)`,
    );
    const manifests = one<{ count: number; bytes: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(encoded)), 0) AS bytes FROM vfs_manifests",
    );
    return {
      databaseBytes: this.#state.storage.sql.databaseSize,
      logicalBytes: files.bytes,
      fileCount: files.files,
      nodeCount: nodes.count,
      chunkReferenceCount: chunks.count,
      uniqueBlobCount: blobs.count,
      uniqueBlobBytes: blobs.bytes,
      reachableBlobBytes: reachable.bytes,
      orphanedBlobBytes: Math.max(0, blobs.bytes - reachable.bytes),
      manifestCount: manifests.count,
      manifestBytes: manifests.bytes,
    };
  }

  async #verifyMediumPhase(phase: string) {
    const baseBytes = 288_129_024;
    const baseFiles = 6_385;
    const duplicated = !["initialize", "list", "read", "delete-copy", "delete-all"].includes(phase);
    const appended = ["append", "prepend", "delete-copy"].includes(phase);
    const prepended = ["prepend", "delete-copy"].includes(phase);
    const expectedFiles = phase === "delete-all" ? 0 : baseFiles * (duplicated ? 2 : 1);
    const expectedBytes =
      phase === "delete-all"
        ? 0
        : baseBytes * (duplicated ? 2 : 1) + (appended ? 10 : 0) + (prepended ? 10 : 0);
    const storage = this.#storageSnapshot();
    if (storage.fileCount !== expectedFiles || storage.logicalBytes !== expectedBytes) {
      throw new Error(
        `${phase} authoritative state mismatch: files=${storage.fileCount}/${expectedFiles} bytes=${storage.logicalBytes}/${expectedBytes}`,
      );
    }

    const readBytes = async (relativePath: string): Promise<ArrayBuffer> =>
      new Response(await this.#workspace.fs.readFile(`${this.#mountPoint}/${relativePath}`)).arrayBuffer();
    const marker = async (relativePath: string, offset: number, length: number): Promise<string> => {
      const bytes = await readBytes(relativePath);
      return new TextDecoder().decode(bytes.slice(offset, offset + length));
    };
    const sentinels: Record<string, unknown> = {};
    if (phase === "initialize") {
      const bytes = await readBytes("medium/large/large-000000.bin");
      sentinels.initialLargeSha256 = await sha256(bytes);
    } else if (phase === "duplicate") {
      const original = await readBytes("medium/large/large-000000.bin");
      const copy = await readBytes("medium-copy/large/large-000000.bin");
      const originalHash = await sha256(original);
      const copyHash = await sha256(copy);
      if (originalHash !== copyHash) throw new Error("duplicate sentinel hash mismatch");
      sentinels.duplicateLargeSha256 = originalHash;
    } else if (phase === "edit-one") {
      const actual = await marker("medium/large/large-000000.bin", 1_024, 10);
      if (actual !== "EDIT-ONE10") throw new Error(`edit-one marker mismatch: ${actual}`);
      sentinels.marker = actual;
    } else if (phase.startsWith("edit-separate-")) {
      const step = Number(phase.at(-1));
      const expected = `S${step.toString().padStart(9, "0")}`;
      const actual = await marker("medium/large/large-000001.bin", 1_024, 10);
      if (actual !== expected) throw new Error(`${phase} marker mismatch: ${actual}`);
      sentinels.marker = actual;
    } else if (phase === "edit-five-bracket") {
      const actual = await marker("medium/large/large-000002.bin", 1_024, 10);
      if (actual !== "B000000005") throw new Error(`edit-five-bracket marker mismatch: ${actual}`);
      sentinels.marker = actual;
    } else if (phase === "append") {
      const actual = await marker("medium/large/large-000003.bin", 1_048_576, 10);
      if (actual !== "APPEND-010") throw new Error(`append marker mismatch: ${actual}`);
      sentinels.marker = actual;
    } else if (phase === "prepend") {
      const actual = await marker("medium/boundary/shift.bin", 0, 10);
      if (actual !== "PREPEND010") throw new Error(`prepend marker mismatch: ${actual}`);
      sentinels.marker = actual;
    }
    return { expectedFiles, expectedBytes, sentinels, storage };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.url.includes("/ping")) return new Response(null, { status: 204 });

    const url = new URL(request.url);
    const fs = this.#workspace.fs;
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (request.url.includes("/pull")) {
      const result = await this.#workspace.pull();
      return json(result);
    }

    if (request.url.includes("/runtime-smoke")) {
      const path = url.searchParams.get("path");
      if (
        !path?.match(
          /^\/tmp\/cloudflare-computer-benchmark-[a-f0-9]{12}\/workspace\/runtime-smoke\.bin$/,
        )
      ) {
        return json({ error: "unexpected runtime smoke path" }, 400);
      }

      const run = async (
        operation: "write" | "read" | "edit" | "delete",
        command: string,
      ) => {
        this.#observer.clear();
        const totalStarted = performance.now();
        const spawnStarted = performance.now();
        const handle = await this.#workspace.runtime.exec(command, {
          backend: "local-computerd",
          encoding: "utf8",
        });
        const spawned = performance.now();
        let result;
        try {
          result = await handle.result();
        } finally {
          handle[Symbol.dispose]();
        }
        const settled = performance.now();
        if (result.exitCode !== 0 || result.sync.status !== "complete") {
          throw new Error(
            `${operation} failed: exit=${result.exitCode} sync=${result.sync.status} stderr=${result.stderr}`,
          );
        }

        const verifyStarted = performance.now();
        let verification: Record<string, unknown>;
        if (operation === "delete") {
          try {
            await fs.stat(path);
            throw new Error("runtime-smoke.bin still exists after delete");
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          }
          verification = { missing: true };
        } else {
          const stat = await fs.stat(path);
          if (stat.size !== 1_048_576) {
            throw new Error(`runtime-smoke.bin has size ${stat.size}; expected 1048576`);
          }
          const bytes = await new Response(await fs.readFile(path)).arrayBuffer();
          if (operation === "edit") {
            const edited = new TextDecoder().decode(bytes.slice(1_024, 1_034));
            if (edited !== "0123456789") {
              throw new Error(`runtime-smoke.bin edit mismatch: ${JSON.stringify(edited)}`);
            }
          }
          verification = { size: stat.size, sha256: await sha256(bytes) };
        }
        const verified = performance.now();

        return {
          operation,
          timing: {
            prePushConnectAndSpawnMs: roundMs(spawned - spawnStarted),
            commandDrainAndPullMs: roundMs(settled - spawned),
            verificationMs: roundMs(verified - verifyStarted),
            durableTotalMs: roundMs(verified - totalStarted),
          },
          sync: {
            pushed: result.pushed,
            pulled: result.pulled,
            status: result.sync.status,
            skipped: result.skipped.length,
          },
          verification,
          spans: this.#observer.snapshot(),
        };
      };

      const operations = [];
      operations.push(
        await run(
          "write",
          "dd if=/dev/zero of=runtime-smoke.bin bs=1M count=1 conv=fsync status=none",
        ),
      );
      operations.push(await run("read", "cat runtime-smoke.bin >/dev/null"));
      operations.push(
        await run(
          "edit",
          "printf '0123456789' | dd of=runtime-smoke.bin bs=1 seek=1024 conv=notrunc,fsync status=none",
        ),
      );
      operations.push(await run("delete", "rm runtime-smoke.bin"));
      return json({
        profile: "workspace-runtime-exec-bracket",
        bracket: "Workspace.push -> shell.exec -> drain events -> Workspace.pull",
        operations,
      });
    }

    if (request.url.includes("/runtime-medium")) {
      const phase = url.searchParams.get("phase") ?? "";
      const commandArguments: Record<string, string[]> = {
        list: ["list", "."],
        read: ["read", "."],
        duplicate: ["duplicate", "."],
        "edit-one": ["edit-one", "."],
        "edit-separate-1": ["edit-separate", ".", "1"],
        "edit-separate-2": ["edit-separate", ".", "2"],
        "edit-separate-3": ["edit-separate", ".", "3"],
        "edit-separate-4": ["edit-separate", ".", "4"],
        "edit-separate-5": ["edit-separate", ".", "5"],
        "edit-five-bracket": ["edit-five-bracket", "."],
        append: ["append", "."],
        prepend: ["prepend", "."],
        "delete-copy": ["delete-copy", "."],
        "delete-all": ["delete-all", "."],
      };
      const commands: string[][] = [];
      const addBatches = (
        action: "initialize-batch" | "duplicate-batch",
        name: string,
        total: number,
        batchSize: number,
      ) => {
        for (let start = 0; start < total; start += batchSize) {
          commands.push([
            action,
            ".",
            name,
            start.toString(),
            Math.min(batchSize, total - start).toString(),
          ]);
        }
      };
      if (phase === "initialize") {
        commands.push(["initialize-reset", "."]);
        // Ordinary classes stay at no more than 40 newly written hashes per
        // bracket. The single 32 MiB boundary file necessarily references 64.
        // In practice the first change set can become visible to the following
        // bracket, so adjacent ordinary batches still stay below 100 bindings.
        // The pinned local Durable Object SQLite fails a 256-hash probe
        // with "too many SQL variables" before it applies the batch.
        addBatches("initialize-batch", "small", 5_000, 40);
        addBatches("initialize-batch", "medium", 1_000, 40);
        addBatches("initialize-batch", "artifacts", 256, 40);
        addBatches("initialize-batch", "large", 128, 20);
        addBatches("initialize-batch", "boundary", 1, 1);
      } else if (phase === "duplicate") {
        commands.push(["duplicate-reset", "."]);
        addBatches("duplicate-batch", "small", 5_000, 40);
        addBatches("duplicate-batch", "medium", 1_000, 40);
        addBatches("duplicate-batch", "artifacts", 256, 40);
        addBatches("duplicate-batch", "large", 128, 20);
        addBatches("duplicate-batch", "boundary", 1, 1);
      } else {
        const args = commandArguments[phase];
        if (args === undefined) return json({ error: `unknown medium phase: ${phase}` }, 400);
        commands.push(args);
      }

      this.#observer.clear();
      const totalStarted = performance.now();
      let setupPushAndSpawnMs = 0;
      let commandDrainAndPullMs = 0;
      let workloadCommandMs = 0;
      let inspectionMs = 0;
      let pushed = 0;
      let pulled = 0;
      let skipped = 0;
      let finalCommandReport: Record<string, unknown> = {};
      for (const args of commands) {
        const command = ["bash", this.#workloadScript, ...args].map(shellQuote).join(" ");
        const execStarted = performance.now();
        const handle = await this.#workspace.runtime.exec(command, {
          backend: "local-computerd",
          encoding: "utf8",
        });
        const spawned = performance.now();
        let result;
        try {
          result = await handle.result();
        } finally {
          handle[Symbol.dispose]();
        }
        const settled = performance.now();
        if (result.exitCode !== 0 || result.sync.status !== "complete") {
          const syncError = result.sync.status === "pending" ? result.sync.error : "";
          throw new Error(
            `${phase}/${args.join(":")} failed: exit=${result.exitCode} sync=${result.sync.status} applied=${result.sync.applied} error=${syncError} stderr=${result.stderr}`,
          );
        }
        const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
        const commandMs = Number(parsed.commandMs);
        workloadCommandMs += commandMs;
        finalCommandReport = parsed;
        setupPushAndSpawnMs += spawned - execStarted;
        commandDrainAndPullMs += settled - spawned;
        pushed += result.pushed;
        pulled += result.pulled;
        skipped += result.skipped.length;
      }
      const settled = performance.now();
      const commandReport = {
        ...finalCommandReport,
        phase,
        commandMs: roundMs(workloadCommandMs),
        inspectionMs: roundMs(inspectionMs),
        executionBrackets: commands.length,
        mutationBrackets: commands.length,
      };
      const verificationStarted = performance.now();
      const verification = await this.#verifyMediumPhase(phase);
      const verified = performance.now();
      return json({
        phase,
        command: commandReport,
        timing: {
          setupPushAndSpawnMs: roundMs(setupPushAndSpawnMs),
          commandDrainAndPullMs: roundMs(commandDrainAndPullMs),
          durableExecMs: roundMs(settled - totalStarted),
          verificationMs: roundMs(verified - verificationStarted),
          verifiedTotalMs: roundMs(verified - totalStarted),
        },
        sync: {
          pushed,
          pulled,
          status: "complete",
          skipped,
        },
        spans: this.#observer.snapshot(),
        verification,
      });
    }

    if (request.url.includes("/verify")) {
      const path = url.searchParams.get("path");
      if (!path?.match(/^\/tmp\/cloudflare-computer-benchmark-[a-f0-9]{12}\/workspace\/smoke\.bin$/)) {
        return json({ error: "unexpected smoke path" }, 400);
      }
      const expectMissing = url.searchParams.get("missing") === "1";
      let stat;
      try {
        stat = await fs.stat(path);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return expectMissing ? new Response(null, { status: 204 }) : json({ ready: false }, 409);
        }
        throw error;
      }
      if (expectMissing) return json({ ready: false, reason: "path still exists" }, 409);
      const expectedSize = url.searchParams.get("size");
      if (expectedSize !== null && stat.size !== Number(expectedSize)) {
        return json({ ready: false, size: stat.size }, 409);
      }
      const expectedHash = url.searchParams.get("sha256");
      if (expectedHash !== null) {
        const bytes = await new Response(await fs.readFile(path)).arrayBuffer();
        const actual = await sha256(bytes);
        if (actual !== expectedHash) return json({ ready: false, sha256: actual }, 409);
      }
      return new Response(null, { status: 204 });
    }

    if (request.url.includes("/storage")) {
      return json(this.#storageSnapshot());
    }

    if (request.url.includes("/reset")) {
      await this.#workspace.close();
      await this.#state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok\n");
    const match = url.pathname.match(
      /^\/c\/([^/]+)\/(ping|pull|runtime-smoke|runtime-medium|verify|storage|reset)\/?$/,
    );
    if (!match) return new Response("not found", { status: 404 });
    const id = env.PipelineStorage.idFromName(decodeURIComponent(match[1]));
    return env.PipelineStorage.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
