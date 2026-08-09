import type { ChangeCursor, ChangeEntry } from "@cloudflare/dofs";
import type { ExecEvent } from "@cloudflare/computer-rpc";
import {
  createWorkspaceClient,
  type WorkspaceClient,
} from "@cloudflare/computer-rpc/client";
import type { BranchWorkspaceStorageEngine } from "./branch-engine/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOGICAL_ROOT = "/workspace";
const WIRE_CHUNK_BYTES = 256 * 1024;
const MAX_COW_DELTA_BYTES = 64 * 1024;
const MAX_COW_RANGES = 256;

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function streamOf<T>(values: Iterable<T>): ReadableStream<T> {
  const iterator = values[Symbol.iterator]();
  return new ReadableStream<T>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const result: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result;
      result.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function normalizeLogicalPath(path: string): string {
  if (path !== LOGICAL_ROOT && !path.startsWith(`${LOGICAL_ROOT}/`)) {
    throw new Error(`branch path must be below ${LOGICAL_ROOT}: ${path}`);
  }
  if (path.includes("/../") || path.endsWith("/..")) {
    throw new Error(`branch path may not escape its root: ${path}`);
  }
  return path;
}

function parentDirectories(path: string): string[] {
  const result: string[] = [];
  let cursor = path;
  while (cursor !== "/") {
    const slash = cursor.lastIndexOf("/");
    cursor = slash <= 0 ? "/" : cursor.slice(0, slash);
    if (cursor !== "/") result.push(cursor);
  }
  return result.reverse();
}

export interface PushMetric {
  durationMs: number;
  files: number;
  objects: number;
  bytes: number;
  cursor: ChangeCursor;
}

export interface ExecMetric {
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PullMetric {
  durationMs: number;
  entries: number;
  filesWritten: number;
  filesDeleted: number;
  cowFiles: number;
  materializedFiles: number;
  objectBytesFetched: number;
  /** Sum of complete changed-file sizes reconstructed before diffing. */
  bytes: number;
}

/**
 * One private C3 branch projected into one independent Computer execution
 * mirror. Computer's wire and computerd/FUSE remain unchanged; this adapter
 * adds the branch identity above the existing RPC boundary.
 */
export class BranchComputerSession {
  readonly #client: WorkspaceClient;
  readonly #remoteRoot: string;

  constructor(
    readonly branchId: string,
    private readonly store: BranchWorkspaceStorageEngine,
    url: string,
    mountPoint: string,
    sessionId: string,
  ) {
    if (!sessionId.match(/^[a-z0-9-]+$/)) throw new Error(`unsafe session id: ${sessionId}`);
    this.#client = createWorkspaceClient({ url });
    this.#remoteRoot = `${mountPoint}/branches/${sessionId}`;
  }

  #toRemote(path: string): string {
    const logical = normalizeLogicalPath(path);
    return logical === LOGICAL_ROOT
      ? this.#remoteRoot
      : `${this.#remoteRoot}${logical.slice(LOGICAL_ROOT.length)}`;
  }

  #toLogical(path: string): string | null {
    if (path === this.#remoteRoot) return LOGICAL_ROOT;
    if (!path.startsWith(`${this.#remoteRoot}/`)) return null;
    return `${LOGICAL_ROOT}${path.slice(this.#remoteRoot.length)}`;
  }

  async push(): Promise<PushMetric> {
    const started = performance.now();
    const now = Date.now();
    const paths = this.store.listFiles(this.branchId);
    const objectsByHash = new Map<string, { hash: Uint8Array; bytes: Uint8Array }>();
    const entries: ChangeEntry[] = [];
    const directories = new Set<string>(parentDirectories(this.#remoteRoot));
    directories.add(this.#remoteRoot);

    const files: Array<{
      path: string;
      bytes: Uint8Array;
      chunks: Array<{ hash: Uint8Array; size: number }>;
    }> = [];
    for (const path of paths) {
      const bytes = await this.store.readFile(this.branchId, path);
      const remotePath = this.#toRemote(path);
      for (const directory of parentDirectories(remotePath)) directories.add(directory);
      const chunks: Array<{ hash: Uint8Array; size: number }> = [];
      for (let offset = 0; offset < bytes.byteLength; offset += WIRE_CHUNK_BYTES) {
        const value = bytes.slice(offset, Math.min(bytes.byteLength, offset + WIRE_CHUNK_BYTES));
        const hash = await sha256(value);
        chunks.push({ hash, size: value.byteLength });
        objectsByHash.set(hex(hash), { hash, bytes: value });
      }
      files.push({ path: remotePath, bytes, chunks });
    }
    for (const path of [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      entries.push({ kind: "dir", rev: 1, path, mode: 0o755, mtime: now });
    }
    for (const file of files) {
      entries.push({
        kind: "file",
        rev: 1,
        path: file.path,
        mode: 0o644,
        mtime: now,
        size: file.bytes.byteLength,
        chunks: file.chunks,
      });
    }

    const objects = [...objectsByHash.values()];
    const wanted = objects.map((object) => object.hash);
    const remoteHas = new Set((await this.#client.sync.hasObjects(wanted)).map(hex));
    const missing = objects.filter((object) => !remoteHas.has(hex(object.hash)));
    if (missing.length > 0) await this.#client.sync.pushObjects(streamOf(missing));
    const response = await this.#client.sync.push({
      // senderRev=0 is Computer RPC's documented external-writer path: the
      // receiver records these entries as local writes for shell/FUSE use.
      senderRev: 0,
      changes: streamOf(entries),
    });
    return {
      durationMs: roundMs(performance.now() - started),
      files: files.length,
      objects: missing.length,
      bytes: missing.reduce((sum, object) => sum + object.bytes.byteLength, 0),
      cursor: { rev: response.rev, path: null },
    };
  }

  async #applyFileDelta(path: string, bytes: Uint8Array): Promise<"cow" | "materialized"> {
    if (!this.store.listFiles(this.branchId).includes(path)) {
      await this.store.writeBranchFile(this.branchId, path, bytes);
      return "materialized";
    }
    const current = await this.store.readFile(this.branchId, path);
    if (current.byteLength !== bytes.byteLength) {
      await this.store.writeBranchFile(this.branchId, path, bytes);
      return "materialized";
    }

    const ranges: Array<{ offset: number; bytes: Uint8Array }> = [];
    let changedBytes = 0;
    for (let index = 0; index < bytes.byteLength;) {
      if (current[index] === bytes[index]) {
        index++;
        continue;
      }
      const start = index;
      while (index < bytes.byteLength && current[index] !== bytes[index]) index++;
      const value = bytes.slice(start, index);
      ranges.push({ offset: start, bytes: value });
      changedBytes += value.byteLength;
      if (changedBytes > MAX_COW_DELTA_BYTES || ranges.length > MAX_COW_RANGES) {
        await this.store.writeBranchFile(this.branchId, path, bytes);
        return "materialized";
      }
    }
    for (const range of ranges) {
      await this.store.editFile(
        this.branchId,
        path,
        range.offset,
        range.bytes.byteLength,
        range.bytes,
      );
    }
    return "cow";
  }

  async exec(source: string): Promise<ExecMetric> {
    const started = performance.now();
    const envelope = await this.#client.shell.exec({ source, cwd: this.#remoteRoot });
    const events = await drain<ExecEvent>(envelope.events);
    let exitCode: number | null = null;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    for (const event of events) {
      if (event.name === "stdout") stdout.push(event.value);
      else if (event.name === "stderr") stderr.push(event.value);
      else exitCode = event.code;
    }
    await this.#client.shell.disposeExec({ id: envelope.id });
    if (exitCode === null) throw new Error(`command ${envelope.id} ended without an exit event`);
    const join = (chunks: Uint8Array[]) => {
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return decoder.decode(bytes);
    };
    const metric = {
      durationMs: roundMs(performance.now() - started),
      exitCode,
      stdout: join(stdout),
      stderr: join(stderr),
    };
    if (exitCode !== 0) throw new Error(`branch command failed: ${JSON.stringify(metric)}`);
    return metric;
  }

  async pull(after: ChangeCursor): Promise<PullMetric> {
    const started = performance.now();
    // fetchChanges invokes computerd's settle hook, so native/FUSE writes are
    // visible in its SQLite VFS before the snapshot cursor is selected.
    const result = await this.#client.sync.fetchChanges({ after, ignore: [] });
    const entries = await drain<ChangeEntry>(result.stream);
    const hashes = new Map<string, Uint8Array>();
    for (const entry of entries) {
      if (entry.kind !== "file" || this.#toLogical(entry.path) === null) continue;
      for (const chunk of entry.chunks) hashes.set(hex(chunk.hash), chunk.hash);
    }
    // Capnweb's proxy resolves a returned stream asynchronously even though
    // the local in-process interface can return it directly.
    const objectStream = hashes.size === 0
      ? null
      : await this.#client.sync.fetchObjects([...hashes.values()]);
    const objects = objectStream === null ? [] : await drain(objectStream);
    const objectBytes = new Map(objects.map((object) => [hex(object.hash), object.bytes]));
    const objectBytesFetched = objects.reduce(
      (sum, object) => sum + object.bytes.byteLength,
      0,
    );

    let filesWritten = 0;
    let filesDeleted = 0;
    let cowFiles = 0;
    let materializedFiles = 0;
    let bytesPulled = 0;
    for (const entry of entries) {
      const logical = this.#toLogical(entry.path);
      if (logical === null || logical === LOGICAL_ROOT) continue;
      if (entry.kind === "dir") continue;
      if (entry.kind === "symlink") {
        throw new Error(`prototype does not publish symlinks: ${logical}`);
      }
      if (entry.kind === "delete") {
        const matches = this.store.listFiles(this.branchId).filter(
          (path) => path === logical || path.startsWith(`${logical}/`),
        );
        for (const path of matches) {
          this.store.deleteBranchFile(this.branchId, path);
          filesDeleted++;
        }
        continue;
      }
      const bytes = new Uint8Array(entry.size);
      let offset = 0;
      for (const chunk of entry.chunks) {
        const value = objectBytes.get(hex(chunk.hash));
        if (value === undefined) throw new Error(`missing pulled object ${hex(chunk.hash)}`);
        bytes.set(value.subarray(0, chunk.size), offset);
        offset += chunk.size;
      }
      const mode = await this.#applyFileDelta(logical, bytes);
      if (mode === "cow") cowFiles++;
      else materializedFiles++;
      filesWritten++;
      bytesPulled += bytes.byteLength;
    }
    return {
      durationMs: roundMs(performance.now() - started),
      entries: entries.length,
      filesWritten,
      filesDeleted,
      cowFiles,
      materializedFiles,
      objectBytesFetched,
      bytes: bytesPulled,
    };
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

export function text(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
