import type {
  EngineCounters,
  GcResult,
  PublishResult,
  StorageSnapshot,
  BranchWorkspaceStorageEngine,
} from "./types";
import {
  applyEdit,
  asBytes,
  encodeText,
  maybeOne,
  nowMs,
  one,
  sha256Hex,
} from "./util";

type Sql = DurableObjectStorage["sql"];

const FIXED_CHUNK_BYTES = 512 * 1024;
const DELETED_MANIFEST = "__deleted__";

interface FixedChunk {
  hash: string;
  bytes?: Uint8Array;
  size: number;
}

interface FixedManifest {
  hash: string;
  size: number;
  chunks: FixedChunk[];
}

/**
 * Baseline: fixed 512 KiB content-addressed chunks and full file manifests.
 *
 * This deliberately keeps last-writer-wins publication and creates a new
 * manifest on every branch edit. It represents the fixed-boundary design we
 * want to improve, while respecting Durable Object SQLite's BLOB limit.
 */
export class NaiveWorkspaceStore implements BranchWorkspaceStorageEngine {
  readonly name = "naive" as const;
  readonly counters: EngineCounters = { sqlitePayloadBytes: 0 };

  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): Sql {
    return this.storage.sql;
  }

  initialize(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
      )
    `);
    this.sql.exec("INSERT OR IGNORE INTO naive_meta(k, v) VALUES ('main_commit', 0)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_commits (
        commit_id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        writer_id TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_objects (
        hash TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        size INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_manifests (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_manifest_chunks (
        manifest_hash TEXT NOT NULL,
        idx INTEGER NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (manifest_hash, idx)
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS naive_chunk_objects ON naive_manifest_chunks(object_hash)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_main_files (
        path TEXT PRIMARY KEY,
        commit_id INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        size INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_versions (
        commit_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (commit_id, path)
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS naive_versions_path ON naive_versions(path, commit_id DESC)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_branches (
        branch_id TEXT PRIMARY KEY,
        base_commit INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'merged', 'discarded'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS naive_branch_files (
        branch_id TEXT NOT NULL,
        path TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (branch_id, path)
      )
    `);
  }

  resetCounters(): void {
    this.counters.sqlitePayloadBytes = 0;
  }

  private mainCommit(): number {
    return one<{ v: number }>(
      this.sql,
      "SELECT v FROM naive_meta WHERE k = 'main_commit'",
    ).v;
  }

  private branch(branchId: string): { base_commit: number; state: string } {
    return one<{ base_commit: number; state: string }>(
      this.sql,
      "SELECT base_commit, state FROM naive_branches WHERE branch_id = ?",
      branchId,
    );
  }

  private versionAt(path: string, commit: number): { manifest_hash: string; size: number } {
    return one<{ manifest_hash: string; size: number }>(
      this.sql,
      `SELECT manifest_hash, size FROM naive_versions
        WHERE path = ? AND commit_id <= ?
        ORDER BY commit_id DESC LIMIT 1`,
      path,
      commit,
    );
  }

  private async prepareManifest(bytes: Uint8Array): Promise<FixedManifest> {
    const chunks: FixedChunk[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += FIXED_CHUNK_BYTES) {
      const chunk = new Uint8Array(bytes.subarray(
        offset,
        Math.min(bytes.byteLength, offset + FIXED_CHUNK_BYTES),
      ));
      chunks.push({
        hash: await sha256Hex(chunk),
        bytes: chunk,
        size: chunk.byteLength,
      });
    }
    const descriptor = chunks.map((chunk) => `${chunk.hash}:${chunk.size}`).join("\n");
    return {
      hash: await sha256Hex(encodeText(`${bytes.byteLength}\n${descriptor}`)),
      size: bytes.byteLength,
      chunks,
    };
  }

  private async prepareOverwrite(
    manifestHash: string,
    fileSize: number,
    offset: number,
    insert: Uint8Array,
  ): Promise<FixedManifest> {
    const chunks = this.sql.exec<{
      idx: number;
      object_hash: string;
      size: number;
    }>(
      `SELECT idx, object_hash, size FROM naive_manifest_chunks
        WHERE manifest_hash = ? ORDER BY idx`,
      manifestHash,
    ).toArray().map<FixedChunk>((row) => ({
      hash: row.object_hash,
      size: row.size,
    }));
    const firstChunk = Math.floor(offset / FIXED_CHUNK_BYTES);
    const lastChunk = Math.floor((offset + insert.byteLength - 1) / FIXED_CHUNK_BYTES);
    for (let index = firstChunk; index <= lastChunk; index++) {
      const existing = one<{ bytes: ArrayBuffer }>(
        this.sql,
        `SELECT o.bytes FROM naive_manifest_chunks AS mc
          JOIN naive_objects AS o ON o.hash = mc.object_hash
         WHERE mc.manifest_hash = ? AND mc.idx = ?`,
        manifestHash,
        index,
      );
      const bytes = new Uint8Array(asBytes(existing.bytes));
      const chunkOffset = index * FIXED_CHUNK_BYTES;
      const editStart = Math.max(offset, chunkOffset);
      const editEnd = Math.min(offset + insert.byteLength, chunkOffset + bytes.byteLength);
      bytes.set(
        insert.subarray(editStart - offset, editEnd - offset),
        editStart - chunkOffset,
      );
      chunks[index] = {
        hash: await sha256Hex(bytes),
        bytes,
        size: bytes.byteLength,
      };
    }
    const descriptor = chunks.map((chunk) => `${chunk.hash}:${chunk.size}`).join("\n");
    return {
      hash: await sha256Hex(encodeText(`${fileSize}\n${descriptor}`)),
      size: fileSize,
      chunks,
    };
  }

  private persistManifest(manifest: FixedManifest): void {
    for (const chunk of manifest.chunks) {
      if (chunk.bytes === undefined) continue;
      const exists = maybeOne<{ present: number }>(
        this.sql,
        "SELECT 1 AS present FROM naive_objects WHERE hash = ?",
        chunk.hash,
      );
      if (exists === undefined) {
        this.sql.exec(
          "INSERT INTO naive_objects(hash, bytes, size) VALUES (?, ?, ?)",
          chunk.hash,
          chunk.bytes,
          chunk.size,
        );
        this.counters.sqlitePayloadBytes += chunk.size;
      }
    }
    const exists = maybeOne<{ present: number }>(
      this.sql,
      "SELECT 1 AS present FROM naive_manifests WHERE hash = ?",
      manifest.hash,
    );
    if (exists !== undefined) return;
    this.sql.exec(
      "INSERT INTO naive_manifests(hash, size) VALUES (?, ?)",
      manifest.hash,
      manifest.size,
    );
    manifest.chunks.forEach((chunk, index) => {
      this.sql.exec(
        `INSERT INTO naive_manifest_chunks(manifest_hash, idx, object_hash, size)
         VALUES (?, ?, ?, ?)`,
        manifest.hash,
        index,
        chunk.hash,
        chunk.size,
      );
    });
  }

  private readManifest(manifestHash: string, size: number): Uint8Array {
    const chunks = this.sql.exec<{ bytes: ArrayBuffer; size: number }>(
      `SELECT o.bytes, mc.size
         FROM naive_manifest_chunks AS mc
         JOIN naive_objects AS o ON o.hash = mc.object_hash
        WHERE mc.manifest_hash = ?
        ORDER BY mc.idx`,
      manifestHash,
    ).toArray();
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = asBytes(chunk.bytes).subarray(0, chunk.size);
      result.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (offset !== size) throw new Error(`manifest ${manifestHash} reconstructed ${offset} of ${size} bytes`);
    return result;
  }

  async seedFile(path: string, bytes: Uint8Array): Promise<void> {
    const manifest = await this.prepareManifest(bytes);
    const parent = this.mainCommit();
    const commit = parent + 1;
    this.storage.transactionSync(() => {
      this.persistManifest(manifest);
      this.sql.exec(
        "INSERT INTO naive_commits(commit_id, parent_id, writer_id) VALUES (?, ?, 'seed')",
        commit,
        parent === 0 ? null : parent,
      );
      this.sql.exec(
        "INSERT INTO naive_versions(commit_id, path, manifest_hash, size) VALUES (?, ?, ?, ?)",
        commit,
        path,
        manifest.hash,
        manifest.size,
      );
      this.sql.exec(
        `INSERT INTO naive_main_files(path, commit_id, manifest_hash, size)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           commit_id = excluded.commit_id,
           manifest_hash = excluded.manifest_hash,
           size = excluded.size`,
        path,
        commit,
        manifest.hash,
        manifest.size,
      );
      this.sql.exec("UPDATE naive_meta SET v = ? WHERE k = 'main_commit'", commit);
    });
  }

  createBranch(branchId: string): void {
    this.sql.exec(
      "INSERT INTO naive_branches(branch_id, base_commit, state) VALUES (?, ?, 'active')",
      branchId,
      this.mainCommit(),
    );
  }

  async readFile(branchId: string | null, path: string): Promise<Uint8Array> {
    if (branchId !== null) {
      const changed = maybeOne<{ manifest_hash: string; size: number }>(
        this.sql,
        "SELECT manifest_hash, size FROM naive_branch_files WHERE branch_id = ? AND path = ?",
        branchId,
        path,
      );
      const manifest = changed ?? this.versionAt(path, this.branch(branchId).base_commit);
      if (manifest.manifest_hash === DELETED_MANIFEST) {
        throw new Error(`no such file in branch: ${path}`);
      }
      return this.readManifest(manifest.manifest_hash, manifest.size);
    }
    const current = one<{ manifest_hash: string; size: number }>(
      this.sql,
      "SELECT manifest_hash, size FROM naive_main_files WHERE path = ?",
      path,
    );
    return this.readManifest(current.manifest_hash, current.size);
  }

  listFiles(branchId: string | null): string[] {
    if (branchId === null) {
      return this.sql.exec<{ path: string }>(
        "SELECT path FROM naive_main_files ORDER BY path",
      ).toArray().map((row) => row.path);
    }
    const branch = this.branch(branchId);
    const paths = new Set<string>();
    for (const row of this.sql.exec<{ path: string }>(
      "SELECT DISTINCT path FROM naive_versions WHERE commit_id <= ?",
      branch.base_commit,
    )) {
      const version = this.versionAt(row.path, branch.base_commit);
      if (version.manifest_hash !== DELETED_MANIFEST) paths.add(row.path);
    }
    for (const row of this.sql.exec<{ path: string; manifest_hash: string }>(
      "SELECT path, manifest_hash FROM naive_branch_files WHERE branch_id = ?",
      branchId,
    )) {
      if (row.manifest_hash === DELETED_MANIFEST) paths.delete(row.path);
      else paths.add(row.path);
    }
    return [...paths].sort();
  }

  async writeBranchFile(branchId: string, path: string, bytes: Uint8Array): Promise<void> {
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const manifest = await this.prepareManifest(bytes);
    this.storage.transactionSync(() => {
      this.persistManifest(manifest);
      this.sql.exec(
        `INSERT INTO naive_branch_files(branch_id, path, manifest_hash, size)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(branch_id, path) DO UPDATE SET
           manifest_hash = excluded.manifest_hash,
           size = excluded.size`,
        branchId,
        path,
        manifest.hash,
        manifest.size,
      );
    });
  }

  deleteBranchFile(branchId: string, path: string): void {
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    if (!this.listFiles(branchId).includes(path)) throw new Error(`no such file in branch: ${path}`);
    this.sql.exec(
      `INSERT INTO naive_branch_files(branch_id, path, manifest_hash, size)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(branch_id, path) DO UPDATE SET
         manifest_hash = excluded.manifest_hash,
         size = 0`,
      branchId,
      path,
      DELETED_MANIFEST,
    );
  }

  async renameBranchFile(branchId: string, oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const bytes = await this.readFile(branchId, oldPath);
    await this.writeBranchFile(branchId, newPath, bytes);
    this.deleteBranchFile(branchId, oldPath);
  }

  async editFile(
    branchId: string,
    path: string,
    offset: number,
    deleteLength: number,
    insert: Uint8Array,
  ): Promise<void> {
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const current = maybeOne<{ manifest_hash: string; size: number }>(
      this.sql,
      "SELECT manifest_hash, size FROM naive_branch_files WHERE branch_id = ? AND path = ?",
      branchId,
      path,
    ) ?? this.versionAt(path, branch.base_commit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.size) {
      throw new RangeError(`invalid edit offset ${offset}`);
    }
    if (
      !Number.isSafeInteger(deleteLength) ||
      deleteLength < 0 ||
      offset + deleteLength > current.size
    ) {
      throw new RangeError(`invalid delete length ${deleteLength}`);
    }
    const manifest = deleteLength === insert.byteLength && insert.byteLength > 0
      ? await this.prepareOverwrite(current.manifest_hash, current.size, offset, insert)
      : await this.prepareManifest(applyEdit(
        this.readManifest(current.manifest_hash, current.size),
        offset,
        deleteLength,
        insert,
      ));
    this.storage.transactionSync(() => {
      this.persistManifest(manifest);
      this.sql.exec(
        `INSERT INTO naive_branch_files(branch_id, path, manifest_hash, size)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(branch_id, path) DO UPDATE SET
           manifest_hash = excluded.manifest_hash,
           size = excluded.size`,
        branchId,
        path,
        manifest.hash,
        manifest.size,
      );
    });
  }

  async publish(branchId: string, _operationId?: string): Promise<PublishResult> {
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const changes = this.sql.exec<{ path: string; manifest_hash: string; size: number }>(
      "SELECT path, manifest_hash, size FROM naive_branch_files WHERE branch_id = ? ORDER BY path",
      branchId,
    ).toArray();
    const parent = this.mainCommit();
    const commit = parent + 1;
    this.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO naive_commits(commit_id, parent_id, writer_id) VALUES (?, ?, ?)",
        commit,
        parent,
        branchId,
      );
      for (const change of changes) {
        this.sql.exec(
          "INSERT INTO naive_versions(commit_id, path, manifest_hash, size) VALUES (?, ?, ?, ?)",
          commit,
          change.path,
          change.manifest_hash,
          change.size,
        );
        if (change.manifest_hash === DELETED_MANIFEST) {
          this.sql.exec("DELETE FROM naive_main_files WHERE path = ?", change.path);
        } else {
          this.sql.exec(
            `INSERT INTO naive_main_files(path, commit_id, manifest_hash, size)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               commit_id = excluded.commit_id,
               manifest_hash = excluded.manifest_hash,
               size = excluded.size`,
            change.path,
            commit,
            change.manifest_hash,
            change.size,
          );
        }
      }
      this.sql.exec("UPDATE naive_meta SET v = ? WHERE k = 'main_commit'", commit);
      this.sql.exec("DELETE FROM naive_branch_files WHERE branch_id = ?", branchId);
      this.sql.exec("UPDATE naive_branches SET state = 'merged' WHERE branch_id = ?", branchId);
    });
    return { outcome: "merged", commit, conflicts: [] };
  }

  discardBranch(branchId: string): void {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM naive_branch_files WHERE branch_id = ?", branchId);
      this.sql.exec("UPDATE naive_branches SET state = 'discarded' WHERE branch_id = ?", branchId);
    });
  }

  private rootManifests(retainLatestCommits: number, includeBranches: boolean): Set<string> {
    const roots = new Set(
      this.sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM naive_main_files",
      ).toArray().map((row) => row.manifest_hash),
    );
    const commits = this.sql.exec<{ commit_id: number }>(
      "SELECT commit_id FROM naive_commits ORDER BY commit_id DESC LIMIT ?",
      retainLatestCommits,
    ).toArray();
    for (const commit of commits) {
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM naive_versions WHERE commit_id = ?",
        commit.commit_id,
      )) if (row.manifest_hash !== DELETED_MANIFEST) roots.add(row.manifest_hash);
    }
    if (includeBranches) {
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        `SELECT bf.manifest_hash
           FROM naive_branch_files AS bf
           JOIN naive_branches AS b ON b.branch_id = bf.branch_id
          WHERE b.state = 'active'`,
      )) if (row.manifest_hash !== DELETED_MANIFEST) roots.add(row.manifest_hash);
    }
    return roots;
  }

  private objectHashes(manifests: Set<string>): Set<string> {
    const hashes = new Set<string>();
    for (const manifest of manifests) {
      for (const row of this.sql.exec<{ object_hash: string }>(
        "SELECT object_hash FROM naive_manifest_chunks WHERE manifest_hash = ?",
        manifest,
      )) hashes.add(row.object_hash);
    }
    return hashes;
  }

  private objectBytes(hashes: Set<string>): number {
    let bytes = 0;
    for (const hash of hashes) {
      bytes += one<{ size: number }>(
        this.sql,
        "SELECT size FROM naive_objects WHERE hash = ?",
        hash,
      ).size;
    }
    return bytes;
  }

  private manifestPayloadBytes(manifests: Set<string>): number {
    let bytes = 0;
    for (const hash of manifests) {
      bytes += one<{ bytes: number }>(
        this.sql,
        `SELECT COALESCE(SUM(LENGTH(object_hash) + 16), 0) AS bytes
           FROM naive_manifest_chunks WHERE manifest_hash = ?`,
        hash,
      ).bytes;
    }
    return bytes;
  }

  snapshot(retainLatestCommits = 1): StorageSnapshot {
    const logical = one<{ bytes: number }>(
      this.sql,
      "SELECT COALESCE(SUM(size), 0) AS bytes FROM naive_main_files",
    ).bytes;
    const objects = one<{ count: number; bytes: number }>(
      this.sql,
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM naive_objects",
    );
    const mainObjects = this.objectHashes(this.rootManifests(retainLatestCommits, false));
    const allReachableObjects = this.objectHashes(this.rootManifests(retainLatestCommits, true));
    const reachable = this.objectBytes(allReachableObjects);
    const branchOnly = new Set([...allReachableObjects].filter((hash) => !mainObjects.has(hash)));
    const mainManifests = this.rootManifests(retainLatestCommits, false);
    const allManifests = this.rootManifests(retainLatestCommits, true);
    const branchOnlyManifests = new Set(
      [...allManifests].filter((hash) => !mainManifests.has(hash)),
    );
    const exclusiveObjectBytes = this.objectBytes(branchOnly);
    const exclusiveManifestBytes = this.manifestPayloadBytes(branchOnlyManifests);
    return {
      databaseBytes: this.sql.databaseSize,
      logicalBytes: logical,
      storedPayloadBytes: objects.bytes,
      reachablePayloadBytes: reachable,
      orphanPayloadBytes: Math.max(0, objects.bytes - reachable),
      branchPayloadBytes: exclusiveObjectBytes,
      branchStorage: {
        cowPageBytes: 0,
        patchBytes: 0,
        exclusiveObjectBytes,
        exclusiveManifestBytes,
        totalExclusivePayloadBytes: exclusiveObjectBytes + exclusiveManifestBytes,
      },
      objectCount: objects.count,
      versionCount: one<{ count: number }>(
        this.sql,
        "SELECT COUNT(*) AS count FROM naive_versions",
      ).count,
    };
  }

  gc(retainLatestCommits = 1): GcResult {
    const started = nowMs();
    const before = this.snapshot(retainLatestCommits);
    const recordsBefore = one<{ count: number }>(
      this.sql,
      `SELECT
         (SELECT COUNT(*) FROM naive_objects) +
         (SELECT COUNT(*) FROM naive_manifests) +
         (SELECT COUNT(*) FROM naive_versions) AS count`,
    ).count;

    this.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM naive_versions
          WHERE NOT EXISTS (
            SELECT 1 FROM naive_main_files AS m
             WHERE m.path = naive_versions.path
               AND m.commit_id = naive_versions.commit_id
          )
            AND commit_id NOT IN (
              SELECT commit_id FROM naive_commits
               ORDER BY commit_id DESC LIMIT ?
            )`,
        retainLatestCommits,
      );

      const roots = new Set(
        this.sql.exec<{ manifest_hash: string }>(
          "SELECT manifest_hash FROM naive_versions",
        ).toArray().map((row) => row.manifest_hash),
      );
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM naive_main_files",
      )) roots.add(row.manifest_hash);
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        `SELECT bf.manifest_hash
           FROM naive_branch_files AS bf
           JOIN naive_branches AS b ON b.branch_id = bf.branch_id
          WHERE b.state = 'active'`,
      )) roots.add(row.manifest_hash);

      for (const row of this.sql.exec<{ hash: string }>("SELECT hash FROM naive_manifests")) {
        if (!roots.has(row.hash)) {
          this.sql.exec("DELETE FROM naive_manifest_chunks WHERE manifest_hash = ?", row.hash);
          this.sql.exec("DELETE FROM naive_manifests WHERE hash = ?", row.hash);
        }
      }
      this.sql.exec(
        `DELETE FROM naive_objects
          WHERE NOT EXISTS (
            SELECT 1 FROM naive_manifest_chunks AS mc
             WHERE mc.object_hash = naive_objects.hash
          )`,
      );
      this.sql.exec("DELETE FROM naive_branches WHERE state != 'active'");
    });

    const after = this.snapshot(retainLatestCommits);
    const recordsAfter = one<{ count: number }>(
      this.sql,
      `SELECT
         (SELECT COUNT(*) FROM naive_objects) +
         (SELECT COUNT(*) FROM naive_manifests) +
         (SELECT COUNT(*) FROM naive_versions) AS count`,
    ).count;
    return {
      elapsedMs: nowMs() - started,
      payloadBytesReclaimed: Math.max(0, before.storedPayloadBytes - after.storedPayloadBytes),
      recordsDeleted: recordsBefore - recordsAfter,
    };
  }
}
