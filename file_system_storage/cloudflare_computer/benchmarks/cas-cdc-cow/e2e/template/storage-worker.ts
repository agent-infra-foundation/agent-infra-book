import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorageLike } from "@cloudflare/dofs";
import {
  type BackendHandle,
  Workspace,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
import { BranchComputerSession, decode, text } from "./branch-computer";
import { createEngine } from "./branch-engine/factory";

interface Env {
  PipelineStorage: DurableObjectNamespace<PipelineStorage>;
  BENCHMARK_MOUNT: string;
  BENCHMARK_VARIANT: string;
  COMPUTERD_URL: string;
  BENCHMARK_MOUNT_A?: string;
  BENCHMARK_MOUNT_B?: string;
  COMPUTERD_URL_A?: string;
  COMPUTERD_URL_B?: string;
}

interface ExecMetric {
  command: string;
  durationMs: number;
  pushed: number;
  pulled: number;
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

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function fixtureBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.byteLength; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const GENERATE_SCRIPT = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const [path, sizeText] = process.argv.slice(2);
let remaining = Number(sizeText);
const fd = fs.openSync(path, "w");
const cipher = crypto.createCipheriv("aes-256-ctr", Buffer.alloc(32, 7), Buffer.alloc(16, 3));
const zero = Buffer.alloc(1024 * 1024);
while (remaining > 0) {
  const count = Math.min(remaining, zero.length);
  const block = cipher.update(zero.subarray(0, count));
  fs.writeSync(fd, block);
  remaining -= count;
}
const tail = cipher.final();
if (tail.length > 0) fs.writeSync(fd, tail);
fs.fsyncSync(fd);
fs.closeSync(fd);
`;

const EDIT_SCRIPT = String.raw`
const fs = require("node:fs");
const [path, offsetText, marker] = process.argv.slice(2);
const fd = fs.openSync(path, "r+");
const bytes = Buffer.from(marker);
fs.writeSync(fd, bytes, 0, bytes.length, Number(offsetText));
fs.fsyncSync(fd);
fs.closeSync(fd);
`;

const PREPEND_SCRIPT = String.raw`
const fs = require("node:fs");
const [path, marker] = process.argv.slice(2);
const temporary = path + ".prepend.tmp";
const input = fs.openSync(path, "r");
const output = fs.openSync(temporary, "w");
fs.writeSync(output, Buffer.from(marker));
const buffer = Buffer.alloc(1024 * 1024);
while (true) {
  const count = fs.readSync(input, buffer, 0, buffer.length, null);
  if (count === 0) break;
  fs.writeSync(output, buffer, 0, count);
}
fs.fsyncSync(output);
fs.closeSync(input);
fs.closeSync(output);
fs.renameSync(temporary, path);
`;

export class PipelineStorage extends DurableObject<Env> {
  readonly #env: Env;
  readonly #state: DurableObjectState;
  readonly #mountPoint: string;
  readonly #variant: string;
  readonly #workspace: Workspace;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const safeMountPattern = /^\/tmp\/(?:cloudflare-computer-c3|cloudflare-computer-branch-(?:baseline|c3))-[a-z0-9-]+\/workspace$/;
    if (!env.BENCHMARK_MOUNT.match(safeMountPattern)) {
      throw new Error(`unsafe BENCHMARK_MOUNT: ${env.BENCHMARK_MOUNT}`);
    }
    if (!new Set(["baseline", "c3"]).has(env.BENCHMARK_VARIANT)) {
      throw new Error(`invalid BENCHMARK_VARIANT: ${env.BENCHMARK_VARIANT}`);
    }
    this.#env = env;
    this.#state = state;
    this.#mountPoint = env.BENCHMARK_MOUNT;
    this.#variant = env.BENCHMARK_VARIANT;
    this.#workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
    });
  }

  #storageSnapshot() {
    const one = <T extends Record<string, SqlStorageValue>>(query: string): T => {
      const row = this.#state.storage.sql.exec<T>(query).toArray()[0];
      if (row === undefined) throw new Error(`query returned no row: ${query}`);
      return row;
    };
    const files = one<{ count: number; bytes: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM vfs_nodes WHERE type = 'file'",
    );
    const chunks = one<{ count: number }>("SELECT COUNT(*) AS count FROM vfs_chunks");
    const blobs = one<{ count: number; bytes: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM vfs_blobs",
    );
    const reachable = one<{ bytes: number }>(
      `SELECT COALESCE(SUM(size), 0) AS bytes FROM vfs_blobs AS blob
        WHERE EXISTS (SELECT 1 FROM vfs_chunks AS chunk WHERE chunk.hash = blob.hash)`,
    );
    const manifests = one<{ count: number; bytes: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(encoded)), 0) AS bytes FROM vfs_manifests",
    );
    return {
      databaseBytes: this.#state.storage.sql.databaseSize,
      logicalBytes: files.bytes,
      fileCount: files.count,
      chunkReferences: chunks.count,
      uniqueBlobCount: blobs.count,
      uniqueBlobBytes: blobs.bytes,
      reachableBlobBytes: reachable.bytes,
      orphanedBlobBytes: Math.max(0, blobs.bytes - reachable.bytes),
      manifestCount: manifests.count,
      manifestBytes: manifests.bytes,
    };
  }

  async #exec(command: string): Promise<ExecMetric> {
    const started = performance.now();
    const handle = await this.#workspace.runtime.exec(command, {
      backend: "local-computerd",
      encoding: "utf8",
    });
    let result;
    try {
      result = await handle.result();
    } finally {
      handle[Symbol.dispose]();
    }
    if (result.exitCode !== 0 || result.sync.status !== "complete") {
      const syncError = result.sync.status === "pending" ? result.sync.error : "";
      throw new Error(
        `command failed: exit=${result.exitCode} sync=${result.sync.status} error=${syncError} stderr=${result.stderr}`,
      );
    }
    return {
      command,
      durationMs: roundMs(performance.now() - started),
      pushed: result.sync.pushed,
      pulled: result.sync.pulled,
    };
  }

  async #run(profile: "smoke" | "volume") {
    const size = profile === "smoke" ? 4 * 1024 * 1024 : 32 * 1024 * 1024;
    const checkpoints = profile === "smoke" ? 2 : 16;
    const file = `${this.#mountPoint}/payload.bin`;
    const generate = `${this.#mountPoint}/generate.cjs`;
    const edit = `${this.#mountPoint}/edit.cjs`;
    const prepend = `${this.#mountPoint}/prepend.cjs`;
    const fs = this.#workspace.fs;

    await fs.mkdir(this.#mountPoint, { recursive: true });
    await fs.writeFile(generate, GENERATE_SCRIPT);
    await fs.writeFile(edit, EDIT_SCRIPT);
    await fs.writeFile(prepend, PREPEND_SCRIPT);
    const empty = this.#storageSnapshot();

    const create = await this.#exec(`node ${shellQuote(generate)} ${shellQuote(file)} ${size}`);
    const afterCreate = this.#storageSnapshot();

    const edits: ExecMetric[] = [];
    for (let index = 0; index < checkpoints; index++) {
      const offset = Number((BigInt(index + 1) * 2_654_435_761n) % BigInt(size - 10));
      const marker = `E${String(index + 1).padStart(9, "0")}`;
      edits.push(
        await this.#exec(
          `node ${shellQuote(edit)} ${shellQuote(file)} ${offset} ${shellQuote(marker)}`,
        ),
      );
    }
    const afterEdits = this.#storageSnapshot();

    const marker = "PREPEND010";
    const frontInsert = await this.#exec(
      `node ${shellQuote(prepend)} ${shellQuote(file)} ${shellQuote(marker)}`,
    );
    const afterFrontInsert = this.#storageSnapshot();
    const read = await this.#exec(`sha256sum ${shellQuote(file)}`);

    const stat = await fs.stat(file);
    const bytes = await new Response(await fs.readFile(file)).arrayBuffer();
    const prefix = new TextDecoder().decode(bytes.slice(0, marker.length));
    if (stat.size !== size + marker.length || prefix !== marker) {
      throw new Error(`authoritative verification failed: size=${stat.size} prefix=${prefix}`);
    }

    return {
      variant: this.#variant,
      profile,
      fileBytes: size,
      checkpoints,
      pipeline:
        "Workspace DO SQLite -> push -> computerd -> FUSE -> command -> pull -> Workspace DO SQLite -> verify",
      timing: {
        createMs: create.durationMs,
        checkpointEditsMs: roundMs(edits.reduce((sum, metric) => sum + metric.durationMs, 0)),
        meanCheckpointEditMs: roundMs(
          edits.reduce((sum, metric) => sum + metric.durationMs, 0) / edits.length,
        ),
        frontInsertMs: frontInsert.durationMs,
        readMs: read.durationMs,
      },
      storage: { empty, afterCreate, afterEdits, afterFrontInsert },
      verification: { size: stat.size, prefix },
      operations: { create, edits, frontInsert, read },
    };
  }

  async #runBranches() {
    const urlA = this.#env.COMPUTERD_URL_A;
    const urlB = this.#env.COMPUTERD_URL_B;
    const mountA = this.#env.BENCHMARK_MOUNT_A;
    const mountB = this.#env.BENCHMARK_MOUNT_B;
    for (const [name, value] of Object.entries({ urlA, urlB, mountA, mountB })) {
      if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
    }
    const mountPattern = /^\/tmp\/cloudflare-computer-branch-[a-z0-9-]+\/workspace$/;
    if (!mountA!.match(mountPattern) || !mountB!.match(mountPattern) || mountA === mountB) {
      throw new Error(`branch mounts must be distinct and safe: ${mountA}, ${mountB}`);
    }

    const store = createEngine(
      this.#variant === "baseline" ? "naive" : "cas-cdc-cow",
      this.#state.storage as unknown as DurableObjectStorage,
    );
    store.initialize();
    const expect = (condition: boolean, message: string) => {
      if (!condition) throw new Error(`branch verification failed: ${message}`);
    };
    const mainText = async (path: string) => decode(await store.readFile(null, path));
    const mainMissing = (path: string) => !store.listFiles(null).includes(path);
    const seed = async (path: string, value: string) => store.seedFile(path, text(value));

    await seed("/workspace/a.txt", "a base\n");
    await seed("/workspace/b.txt", "b base\n");
    await seed("/workspace/delete-a.txt", "delete me\n");
    await seed("/workspace/rename-a.txt", "rename me\n");
    await seed("/workspace/shared.txt", "shared base\n");
    await seed("/workspace/delete-edit.txt", "delete-edit base\n");
    await seed("/workspace/rename-edit.txt", "rename-edit base\n");
    await store.seedFile("/workspace/large-a.bin", fixtureBytes(1024 * 1024, 0xa11ce));
    await store.seedFile("/workspace/large-b.bin", fixtureBytes(1024 * 1024, 0xb0b));

    const runPair = async (label: string, commandA: string, commandB: string) => {
      const storageBefore = store.snapshot(1);
      const branchA = `${label}-a`;
      const branchB = `${label}-b`;
      store.createBranch(branchA);
      store.createBranch(branchB);
      const sessionA = new BranchComputerSession(
        branchA,
        store,
        urlA!,
        mountA!,
        branchA,
      );
      const sessionB = new BranchComputerSession(
        branchB,
        store,
        urlB!,
        mountB!,
        branchB,
      );
      try {
        const pairStarted = performance.now();
        let phaseStarted = performance.now();
        const [pushA, pushB] = await Promise.all([sessionA.push(), sessionB.push()]);
        const pushWallMs = roundMs(performance.now() - phaseStarted);
        phaseStarted = performance.now();
        const [execA, execB] = await Promise.all([
          sessionA.exec(commandA),
          sessionB.exec(commandB),
        ]);
        const shellWallMs = roundMs(performance.now() - phaseStarted);
        phaseStarted = performance.now();
        const [pullA, pullB] = await Promise.all([
          sessionA.pull(pushA.cursor),
          sessionB.pull(pushB.cursor),
        ]);
        const pullWallMs = roundMs(performance.now() - phaseStarted);
        const privateStorage = store.snapshot(1);
        phaseStarted = performance.now();
        let publishStarted = performance.now();
        const publishA = {
          ...await store.publish(branchA),
          durationMs: roundMs(performance.now() - publishStarted),
        };
        publishStarted = performance.now();
        const publishB = {
          ...await store.publish(branchB),
          durationMs: roundMs(performance.now() - publishStarted),
        };
        const publishWallMs = roundMs(performance.now() - phaseStarted);
        return {
          branches: [branchA, branchB],
          privateCowPagePayloadBytes: privateStorage.branchStorage.cowPageBytes,
          privateBranchExclusivePayloadBytes:
            privateStorage.branchStorage.totalExclusivePayloadBytes,
          privateBranchDatabaseGrowthBytes: Math.max(
            0,
            privateStorage.databaseBytes - storageBefore.databaseBytes,
          ),
          privateStorage: privateStorage.branchStorage,
          phases: {
            pushWallMs,
            shellWallMs,
            pullWallMs,
            publishWallMs,
            totalWallMs: roundMs(performance.now() - pairStarted),
          },
          agentA: { push: pushA, exec: execA, pull: pullA, publish: publishA },
          agentB: { push: pushB, exec: execB, pull: pullB, publish: publishB },
        };
      } finally {
        await Promise.all([sessionA.close(), sessionB.close()]);
      }
    };

    const disjoint = await runPair(
      "disjoint",
      "printf 'a by agent-a\\n' > a.txt; printf 'new a\\n' > new-a.txt; rm delete-a.txt; mv rename-a.txt renamed-a.txt; printf 'Z' | dd of=large-a.bin bs=1 seek=524288 conv=notrunc status=none",
      "printf 'b by agent-b\\n' > b.txt; printf 'new b\\n' > new-b.txt; printf 'Y' | dd of=large-b.bin bs=1 seek=524288 conv=notrunc status=none",
    );
    expect(disjoint.agentA.publish.outcome === "merged", "agent-a disjoint publish");
    expect(disjoint.agentB.publish.outcome === "merged", "agent-b disjoint publish");
    expect(await mainText("/workspace/a.txt") === "a by agent-a\n", "agent-a file");
    expect(await mainText("/workspace/b.txt") === "b by agent-b\n", "agent-b file");
    expect(await mainText("/workspace/new-a.txt") === "new a\n", "agent-a create");
    expect(await mainText("/workspace/new-b.txt") === "new b\n", "agent-b create");
    expect(mainMissing("/workspace/delete-a.txt"), "agent-a delete");
    expect(mainMissing("/workspace/rename-a.txt"), "rename source removed");
    expect(await mainText("/workspace/renamed-a.txt") === "rename me\n", "rename target");
    expect(
      (await store.readFile(null, "/workspace/large-a.bin"))[524288] === 0x5a,
      "agent-a sparse COW edit",
    );
    expect(
      (await store.readFile(null, "/workspace/large-b.bin"))[524288] === 0x59,
      "agent-b sparse COW edit",
    );
    if (this.#variant === "c3") {
      expect(disjoint.agentA.pull.cowFiles >= 1, "agent-a pulled sparse edit through COW");
      expect(disjoint.agentB.pull.cowFiles >= 1, "agent-b pulled sparse edit through COW");
      expect(
        disjoint.privateCowPagePayloadBytes === 8 * 1024,
        "two private 4 KiB COW pages",
      );
    } else {
      expect(
        disjoint.privateStorage.exclusiveObjectBytes >= 2 * 512 * 1024,
        "two private fixed chunks",
      );
    }

    const sameFile = await runPair(
      "same-file",
      "printf 'shared by agent-a\\n' > shared.txt",
      "printf 'shared by agent-b\\n' > shared.txt",
    );
    expect(sameFile.agentA.publish.outcome === "merged", "first same-file publish");
    if (this.#variant === "c3") {
      expect(sameFile.agentB.publish.outcome === "conflict", "stale same-file writer rejected");
      expect(sameFile.agentB.publish.conflicts.includes("/workspace/shared.txt"), "same-file path");
      expect(await mainText("/workspace/shared.txt") === "shared by agent-a\n", "no lost update");
      store.discardBranch(sameFile.branches[1]);
    } else {
      expect(sameFile.agentB.publish.outcome === "merged", "fixed baseline accepts stale writer");
      expect(await mainText("/workspace/shared.txt") === "shared by agent-b\n", "last writer wins");
    }

    const createCollision = await runPair(
      "create-collision",
      "printf 'created by agent-a\\n' > collision.txt",
      "printf 'created by agent-b\\n' > collision.txt",
    );
    expect(createCollision.agentA.publish.outcome === "merged", "first create publish");
    if (this.#variant === "c3") {
      expect(createCollision.agentB.publish.outcome === "conflict", "create collision rejected");
      expect(
        createCollision.agentB.publish.conflicts.includes("/workspace/collision.txt"),
        "create conflict path",
      );
      expect(await mainText("/workspace/collision.txt") === "created by agent-a\n", "create winner");
      store.discardBranch(createCollision.branches[1]);
    } else {
      expect(createCollision.agentB.publish.outcome === "merged", "fixed baseline overwrites create");
      expect(await mainText("/workspace/collision.txt") === "created by agent-b\n", "last create wins");
    }

    const deleteEdit = await runPair(
      "delete-edit",
      "rm delete-edit.txt",
      "printf 'edited by agent-b\\n' > delete-edit.txt",
    );
    expect(deleteEdit.agentA.publish.outcome === "merged", "delete publish");
    if (this.#variant === "c3") {
      expect(deleteEdit.agentB.publish.outcome === "conflict", "delete/edit conflict");
      expect(mainMissing("/workspace/delete-edit.txt"), "delete/edit winner");
      store.discardBranch(deleteEdit.branches[1]);
    } else {
      expect(deleteEdit.agentB.publish.outcome === "merged", "fixed baseline resurrects deleted file");
      expect(await mainText("/workspace/delete-edit.txt") === "edited by agent-b\n", "stale edit wins");
    }

    const renameEdit = await runPair(
      "rename-edit",
      "mv rename-edit.txt renamed-edit.txt",
      "printf 'edited old path by agent-b\\n' > rename-edit.txt",
    );
    expect(renameEdit.agentA.publish.outcome === "merged", "rename publish");
    if (this.#variant === "c3") {
      expect(renameEdit.agentB.publish.outcome === "conflict", "rename/edit conflict");
      expect(mainMissing("/workspace/rename-edit.txt"), "rename/edit old path removed");
      expect(
        await mainText("/workspace/renamed-edit.txt") === "rename-edit base\n",
        "rename/edit new path",
      );
      store.discardBranch(renameEdit.branches[1]);
    } else {
      expect(renameEdit.agentB.publish.outcome === "merged", "fixed baseline accepts old-path edit");
      expect(await mainText("/workspace/rename-edit.txt") === "edited old path by agent-b\n", "old path returns");
      expect(await mainText("/workspace/renamed-edit.txt") === "rename-edit base\n", "rename target remains");
    }

    return {
      variant: this.#variant,
      pipeline:
        "Durable Object-owned branch store -> push -> dedicated computerd/FUSE -> shell -> pull -> branch -> publish",
      topology: {
        authoritativeSQLiteDatabases: 1,
        privateBranches: 2,
        independentComputerdProcesses: 2,
        independentFuseMounts: 2,
      },
      scenarios: { disjoint, sameFile, createCollision, deleteEdit, renameEdit },
      storage: store.snapshot(1),
      verification: {
        disjointMerged: true,
        sameFileConflict: this.#variant === "c3",
        createCollisionConflict: this.#variant === "c3",
        deleteEditConflict: this.#variant === "c3",
        renameEditConflict: this.#variant === "c3",
        silentLostUpdates: this.#variant === "c3" ? 0 : 4,
      },
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname.endsWith("/ping")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/storage")) return json(this.#storageSnapshot());
    if (url.pathname.endsWith("/run")) {
      const profile = url.searchParams.get("profile") === "volume" ? "volume" : "smoke";
      return json(await this.#run(profile));
    }
    if (url.pathname.endsWith("/branches")) return json(await this.#runBranches());
    if (url.pathname.endsWith("/reset")) {
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
    const match = url.pathname.match(/^\/c\/([^/]+)\/(ping|run|branches|storage|reset)\/?$/);
    if (!match) return new Response("not found", { status: 404 });
    const id = env.PipelineStorage.idFromName(decodeURIComponent(match[1]));
    return env.PipelineStorage.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
