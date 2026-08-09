import {
  decodeManifest,
  encodeManifest,
  prepareExplicitChunks,
  prepareFullManifest,
  prepareManifestFromEntries,
  type ManifestEntry,
  type PreparedChunk,
  type PreparedManifest,
} from "./compact-manifest";
import { DEFAULT_FASTCDC, fastCdc } from "./fastcdc";
import type {
  BranchWorkspaceStorageEngine,
  EngineCounters,
  GcResult,
  PublishResult,
  StorageSnapshot,
} from "./types";
import {
  applyEdit,
  asBytes,
  maybeOne,
  nowMs,
  one,
} from "./util";

type Sql = DurableObjectStorage["sql"];

interface PatchRow extends Record<string, SqlStorageValue> {
  offset: number;
  delete_length: number;
  insert_size: number;
  bytes: ArrayBuffer;
}

interface PageRow extends Record<string, SqlStorageValue> {
  page_index: number;
  byte_length: number;
  bytes: ArrayBuffer;
}

interface BranchFileRow {
  base_manifest: string;
  base_size: number;
  materialized_manifest: string | null;
  materialized_size: number | null;
}

const COW_PAGE_BYTES = 4 * 1024;
const MAX_PAGE_EDIT_BYTES = 64 * 1024;
const MAX_PATCH_BLOB_BYTES = 512 * 1024;
const HASH_QUERY_BATCH = 64;
const OBJECT_INSERT_BATCH = 4;
// Sentinels are outside the lowercase SHA-256 hexadecimal alphabet.
const MISSING_MANIFEST = "@c3/missing";
const DELETED_MANIFEST = "@c3/deleted";

function isContentManifest(hash: string): boolean {
  return hash !== MISSING_MANIFEST && hash !== DELETED_MANIFEST;
}

export class CasCdcCowWorkspaceStore implements BranchWorkspaceStorageEngine {
  readonly name = "cas-cdc-cow" as const;
  readonly counters: EngineCounters = { sqlitePayloadBytes: 0 };

  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): Sql {
    return this.storage.sql;
  }

  initialize(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
      )
    `);
    this.sql.exec("INSERT OR IGNORE INTO ccdc_meta(k, v) VALUES ('main_commit', 0)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_commits (
        commit_id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        writer_id TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_objects (
        hash TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        size INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_manifests (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        encoded BLOB
      )
    `);
    const manifestColumns = this.sql.exec<{ name: string }>(
      "PRAGMA table_info(ccdc_manifests)",
    ).toArray();
    if (!manifestColumns.some((column) => column.name === "encoded")) {
      this.sql.exec("ALTER TABLE ccdc_manifests ADD COLUMN encoded BLOB");
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_manifest_chunks (
        manifest_hash TEXT NOT NULL,
        idx INTEGER NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (manifest_hash, idx)
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS ccdc_chunk_objects ON ccdc_manifest_chunks(object_hash)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_main_files (
        path TEXT PRIMARY KEY,
        commit_id INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        size INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_versions (
        commit_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (commit_id, path)
      )
    `);
    this.sql.exec("CREATE INDEX IF NOT EXISTS ccdc_versions_path ON ccdc_versions(path, commit_id DESC)");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_branches (
        branch_id TEXT PRIMARY KEY,
        base_commit INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'merged', 'discarded'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_branch_files (
        branch_id TEXT NOT NULL,
        path TEXT NOT NULL,
        base_manifest TEXT NOT NULL,
        base_size INTEGER NOT NULL,
        materialized_manifest TEXT,
        materialized_size INTEGER,
        PRIMARY KEY (branch_id, path)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_patches (
        branch_id TEXT NOT NULL,
        path TEXT NOT NULL,
        seq INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        delete_length INTEGER NOT NULL,
        insert_size INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (branch_id, path, seq)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_branch_pages (
        branch_id TEXT NOT NULL,
        path TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        byte_length INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (branch_id, path, page_index)
      ) WITHOUT ROWID
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_publish_results (
        operation_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('merged', 'conflict')),
        commit_id INTEGER,
        conflicts_json TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ccdc_gc_live_objects (
        hash TEXT PRIMARY KEY
      ) WITHOUT ROWID
    `);
  }

  resetCounters(): void {
    this.counters.sqlitePayloadBytes = 0;
  }

  private mainCommit(): number {
    return one<{ v: number }>(
      this.sql,
      "SELECT v FROM ccdc_meta WHERE k = 'main_commit'",
    ).v;
  }

  private branch(branchId: string): { base_commit: number; state: string } {
    return one<{ base_commit: number; state: string }>(
      this.sql,
      "SELECT base_commit, state FROM ccdc_branches WHERE branch_id = ?",
      branchId,
    );
  }

  private versionAt(path: string, commit: number): { manifest_hash: string; size: number } {
    return one<{ manifest_hash: string; size: number }>(
      this.sql,
      `SELECT manifest_hash, size FROM ccdc_versions
        WHERE path = ? AND commit_id <= ?
        ORDER BY commit_id DESC LIMIT 1`,
      path,
      commit,
    );
  }

  private maybeVersionAt(
    path: string,
    commit: number,
  ): { manifest_hash: string; size: number } | undefined {
    return maybeOne<{ manifest_hash: string; size: number }>(
      this.sql,
      `SELECT manifest_hash, size FROM ccdc_versions
        WHERE path = ? AND commit_id <= ?
        ORDER BY commit_id DESC LIMIT 1`,
      path,
      commit,
    );
  }

  private baseMatches(baseManifest: string, currentManifest: string | undefined): boolean {
    return baseManifest === MISSING_MANIFEST
      ? currentManifest === undefined
      : currentManifest === baseManifest;
  }

  private async prepareManifest(bytes: Uint8Array): Promise<PreparedManifest> {
    return prepareFullManifest(bytes);
  }

  private persistManifest(manifest: PreparedManifest): void {
    const existingManifest = maybeOne<{ present: number }>(
      this.sql,
      "SELECT 1 AS present FROM ccdc_manifests WHERE hash = ?",
      manifest.hash,
    );
    if (existingManifest !== undefined) return;

    const uniqueChunks = new Map<string, PreparedChunk>();
    for (const chunk of manifest.chunks) uniqueChunks.set(chunk.hash, chunk);
    const hashes = [...uniqueChunks.keys()];
    const existingObjects = new Set<string>();
    for (let start = 0; start < hashes.length; start += HASH_QUERY_BATCH) {
      const batch = hashes.slice(start, start + HASH_QUERY_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      for (const row of this.sql.exec<{ hash: string }>(
        `SELECT hash FROM ccdc_objects WHERE hash IN (${placeholders})`,
        ...batch,
      )) existingObjects.add(row.hash);
    }

    const missing = [...uniqueChunks.values()].filter(
      (chunk) => !existingObjects.has(chunk.hash),
    );
    for (let start = 0; start < missing.length; start += OBJECT_INSERT_BATCH) {
      const batch = missing.slice(start, start + OBJECT_INSERT_BATCH);
      const values = batch.map(() => "(?, ?, ?)").join(", ");
      const bindings = batch.flatMap((chunk) => [chunk.hash, chunk.bytes, chunk.size]);
      this.sql.exec(
        `INSERT OR IGNORE INTO ccdc_objects(hash, bytes, size) VALUES ${values}`,
        ...bindings,
      );
      for (const chunk of batch) this.counters.sqlitePayloadBytes += chunk.size;
    }

    this.sql.exec(
      "INSERT INTO ccdc_manifests(hash, size, encoded) VALUES (?, ?, ?)",
      manifest.hash,
      manifest.size,
      manifest.encoded,
    );
  }

  private manifestEntries(manifestHash: string, expectedSize?: number): ManifestEntry[] {
    const manifest = one<{ size: number; encoded: ArrayBuffer | null }>(
      this.sql,
      "SELECT size, encoded FROM ccdc_manifests WHERE hash = ?",
      manifestHash,
    );
    let entries: ManifestEntry[];
    if (manifest.encoded !== null) {
      entries = decodeManifest(asBytes(manifest.encoded));
    } else {
      entries = this.sql.exec<{ object_hash: string; size: number }>(
        `SELECT object_hash, size FROM ccdc_manifest_chunks
          WHERE manifest_hash = ? ORDER BY idx`,
        manifestHash,
      ).toArray().map((row) => ({ hash: row.object_hash, size: row.size }));
      this.sql.exec(
        "UPDATE ccdc_manifests SET encoded = ? WHERE hash = ?",
        encodeManifest(entries),
        manifestHash,
      );
    }
    const actualSize = entries.reduce((total, entry) => total + entry.size, 0);
    const requiredSize = expectedSize ?? manifest.size;
    if (manifest.size !== requiredSize || actualSize !== requiredSize) {
      throw new Error(
        `manifest ${manifestHash} describes ${actualSize}/${manifest.size}, expected ${requiredSize}`,
      );
    }
    return entries;
  }

  private readObjects(hashes: string[]): Map<string, Uint8Array> {
    const objects = new Map<string, Uint8Array>();
    const unique = [...new Set(hashes)];
    for (let start = 0; start < unique.length; start += HASH_QUERY_BATCH) {
      const batch = unique.slice(start, start + HASH_QUERY_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      for (const row of this.sql.exec<{ hash: string; bytes: ArrayBuffer }>(
        `SELECT hash, bytes FROM ccdc_objects WHERE hash IN (${placeholders})`,
        ...batch,
      )) objects.set(row.hash, asBytes(row.bytes));
    }
    for (const hash of unique) {
      if (!objects.has(hash)) throw new Error(`missing CAS object ${hash}`);
    }
    return objects;
  }

  private readManifest(manifestHash: string, expectedSize: number): Uint8Array {
    const entries = this.manifestEntries(manifestHash, expectedSize);
    const objects = this.readObjects(entries.map((entry) => entry.hash));
    const result = new Uint8Array(expectedSize);
    let offset = 0;
    for (const entry of entries) {
      const bytes = objects.get(entry.hash);
      if (bytes === undefined) throw new Error(`missing CAS object ${entry.hash}`);
      result.set(bytes.subarray(0, entry.size), offset);
      offset += entry.size;
    }
    return result;
  }

  private readManifestRangeFromEntries(
    entries: ManifestEntry[],
    manifestSize: number,
    offset: number,
    length: number,
  ): Uint8Array {
    if (offset < 0 || length < 0 || offset + length > manifestSize) {
      throw new RangeError(`invalid manifest range ${offset}:${length} for ${manifestSize}`);
    }
    const result = new Uint8Array(length);
    if (length === 0) return result;

    const rangeEnd = offset + length;
    const selected: Array<{ entry: ManifestEntry; offset: number }> = [];
    let chunkOffset = 0;
    for (const entry of entries) {
      const chunkEnd = chunkOffset + entry.size;
      if (chunkEnd > offset && chunkOffset < rangeEnd) {
        selected.push({ entry, offset: chunkOffset });
      }
      chunkOffset = chunkEnd;
      if (chunkOffset >= rangeEnd) break;
    }
    const objects = this.readObjects(selected.map(({ entry }) => entry.hash));
    for (const selectedChunk of selected) {
      const chunkEnd = selectedChunk.offset + selectedChunk.entry.size;
      const overlapStart = Math.max(offset, selectedChunk.offset);
      const overlapEnd = Math.min(rangeEnd, chunkEnd);
      const source = objects.get(selectedChunk.entry.hash);
      if (source === undefined) throw new Error(`missing CAS object ${selectedChunk.entry.hash}`);
      result.set(
        source.subarray(
          overlapStart - selectedChunk.offset,
          overlapEnd - selectedChunk.offset,
        ),
        overlapStart - offset,
      );
    }
    return result;
  }

  private readManifestRange(
    manifestHash: string,
    manifestSize: number,
    offset: number,
    length: number,
  ): Uint8Array {
    return this.readManifestRangeFromEntries(
      this.manifestEntries(manifestHash, manifestSize),
      manifestSize,
      offset,
      length,
    );
  }

  private ensureBranchFile(
    branchId: string,
    path: string,
    baseCommit: number,
  ): BranchFileRow {
    const existing = maybeOne<BranchFileRow & Record<string, SqlStorageValue>>(
      this.sql,
      `SELECT base_manifest, base_size, materialized_manifest, materialized_size
         FROM ccdc_branch_files
        WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    );
    if (existing !== undefined) return existing;

    const base = this.versionAt(path, baseCommit);
    if (!isContentManifest(base.manifest_hash)) {
      throw new Error(`no such file in branch base: ${path}`);
    }
    this.sql.exec(
      `INSERT INTO ccdc_branch_files(branch_id, path, base_manifest, base_size)
       VALUES (?, ?, ?, ?)`,
      branchId,
      path,
      base.manifest_hash,
      base.size,
    );
    return {
      base_manifest: base.manifest_hash,
      base_size: base.size,
      materialized_manifest: null,
      materialized_size: null,
    };
  }

  private patchStats(branchId: string, path: string): { count: number; size_delta: number } {
    return one<{ count: number; size_delta: number }>(
      this.sql,
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(insert_size - delete_length), 0) AS size_delta
         FROM ccdc_patches
        WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    );
  }

  private applyBranchPages(branchId: string, path: string, result: Uint8Array): void {
    for (const page of this.sql.exec<PageRow>(
      `SELECT page_index, byte_length, bytes
         FROM ccdc_branch_pages
        WHERE branch_id = ? AND path = ?
        ORDER BY page_index`,
      branchId,
      path,
    )) {
      const offset = page.page_index * COW_PAGE_BYTES;
      result.set(asBytes(page.bytes).subarray(0, page.byte_length), offset);
    }
  }

  private writeBranchPages(
    branchId: string,
    path: string,
    manifestHash: string,
    fileSize: number,
    offset: number,
    insert: Uint8Array,
  ): void {
    const firstPage = Math.floor(offset / COW_PAGE_BYTES);
    const lastPage = Math.floor((offset + insert.byteLength - 1) / COW_PAGE_BYTES);
    const pages: Array<{ index: number; bytes: Uint8Array }> = [];

    for (let pageIndex = firstPage; pageIndex <= lastPage; pageIndex++) {
      const pageOffset = pageIndex * COW_PAGE_BYTES;
      const pageLength = Math.min(COW_PAGE_BYTES, fileSize - pageOffset);
      const existing = maybeOne<{ bytes: ArrayBuffer; byte_length: number }>(
        this.sql,
        `SELECT bytes, byte_length FROM ccdc_branch_pages
          WHERE branch_id = ? AND path = ? AND page_index = ?`,
        branchId,
        path,
        pageIndex,
      );
      const page = existing === undefined
        ? this.readManifestRange(manifestHash, fileSize, pageOffset, pageLength)
        : new Uint8Array(asBytes(existing.bytes).subarray(0, existing.byte_length));
      const editStart = Math.max(offset, pageOffset);
      const editEnd = Math.min(offset + insert.byteLength, pageOffset + pageLength);
      page.set(
        insert.subarray(editStart - offset, editEnd - offset),
        editStart - pageOffset,
      );
      pages.push({ index: pageIndex, bytes: page });
    }

    this.storage.transactionSync(() => {
      for (const page of pages) {
        this.sql.exec(
          `INSERT INTO ccdc_branch_pages(
             branch_id, path, page_index, byte_length, bytes
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(branch_id, path, page_index) DO UPDATE SET
             byte_length = excluded.byte_length,
             bytes = excluded.bytes`,
          branchId,
          path,
          page.index,
          page.bytes.byteLength,
          page.bytes,
        );
        this.counters.sqlitePayloadBytes += page.bytes.byteLength;
      }
    });
  }

  private manifestLayout(entries: ManifestEntry[]): {
    starts: number[];
    boundaryToIndex: Map<number, number>;
  } {
    const starts: number[] = [];
    const boundaryToIndex = new Map<number, number>();
    let offset = 0;
    boundaryToIndex.set(0, 0);
    entries.forEach((entry, index) => {
      starts.push(offset);
      offset += entry.size;
      boundaryToIndex.set(offset, index + 1);
    });
    return { starts, boundaryToIndex };
  }

  private chunkIndexAt(
    entries: ManifestEntry[],
    starts: number[],
    offset: number,
  ): number {
    if (entries.length === 0) return 0;
    for (let index = 0; index < entries.length; index++) {
      if (starts[index] + entries[index].size > offset) return index;
    }
    return entries.length - 1;
  }

  private overlayPages(
    bytes: Uint8Array,
    windowOffset: number,
    pages: PageRow[],
  ): void {
    const windowEnd = windowOffset + bytes.byteLength;
    for (const page of pages) {
      const pageOffset = page.page_index * COW_PAGE_BYTES;
      const pageEnd = pageOffset + page.byte_length;
      if (pageEnd <= windowOffset || pageOffset >= windowEnd) continue;
      const overlapStart = Math.max(pageOffset, windowOffset);
      const overlapEnd = Math.min(pageEnd, windowEnd);
      const pageBytes = asBytes(page.bytes);
      bytes.set(
        pageBytes.subarray(overlapStart - pageOffset, overlapEnd - pageOffset),
        overlapStart - windowOffset,
      );
    }
  }

  private async spliceLocalManifest(
    fileSize: number,
    entries: ManifestEntry[],
    startIndex: number,
    windowOffset: number,
    windowBytes: Uint8Array,
    dirtyEnd: number,
    boundaryToIndex: Map<number, number>,
    boundaryDelta: number,
    isWholeFileEnd: boolean,
  ): Promise<PreparedManifest | null> {
    if (windowBytes.byteLength === 0) {
      const suffixIndex = boundaryToIndex.get(windowOffset - boundaryDelta);
      if (!isWholeFileEnd || windowOffset < dirtyEnd || suffixIndex === undefined) return null;
      return prepareManifestFromEntries(
        fileSize,
        [...entries.slice(0, startIndex), ...entries.slice(suffixIndex)],
        [],
      );
    }
    const boundaries = fastCdc(windowBytes);
    let resyncOffset: number | null = null;
    let suffixIndex: number | null = null;
    for (const boundary of boundaries) {
      const absoluteEnd = windowOffset + boundary.offset + boundary.length;
      if (absoluteEnd < dirtyEnd) continue;
      if (
        absoluteEnd === windowOffset + windowBytes.byteLength &&
        !isWholeFileEnd
      ) continue;
      const candidate = boundaryToIndex.get(absoluteEnd - boundaryDelta);
      if (candidate !== undefined) {
        resyncOffset = absoluteEnd;
        suffixIndex = candidate;
        break;
      }
    }
    if (resyncOffset === null || suffixIndex === null) return null;

    const chunkBytes: Uint8Array[] = [];
    for (const boundary of boundaries) {
      const absoluteEnd = windowOffset + boundary.offset + boundary.length;
      if (absoluteEnd > resyncOffset) break;
      chunkBytes.push(new Uint8Array(windowBytes.subarray(
        boundary.offset,
        boundary.offset + boundary.length,
      )));
      if (absoluteEnd === resyncOffset) break;
    }
    const chunks = await prepareExplicitChunks(chunkBytes);
    const nextEntries: ManifestEntry[] = [
      ...entries.slice(0, startIndex),
      ...chunks.map(({ hash, size }) => ({ hash, size })),
      ...entries.slice(suffixIndex),
    ];
    return prepareManifestFromEntries(fileSize, nextEntries, chunks);
  }

  private async preparePageManifest(
    branchId: string,
    path: string,
    manifestHash: string,
    fileSize: number,
  ): Promise<PreparedManifest> {
    const pages = this.sql.exec<PageRow>(
      `SELECT page_index, byte_length, bytes FROM ccdc_branch_pages
        WHERE branch_id = ? AND path = ? ORDER BY page_index`,
      branchId,
      path,
    ).toArray();
    if (pages.length === 0) throw new Error(`branch ${branchId} has no pages for ${path}`);

    const entries = this.manifestEntries(manifestHash, fileSize);
    const { starts, boundaryToIndex } = this.manifestLayout(entries);
    const dirtyStart = pages[0].page_index * COW_PAGE_BYTES;
    const lastPage = pages[pages.length - 1];
    const dirtyEnd = lastPage.page_index * COW_PAGE_BYTES + lastPage.byte_length;
    const startIndex = this.chunkIndexAt(entries, starts, dirtyStart);
    const windowOffset = starts[startIndex] ?? 0;
    let windowEnd = Math.min(
      fileSize,
      Math.max(
        dirtyEnd + DEFAULT_FASTCDC.maxSize * 2,
        windowOffset + DEFAULT_FASTCDC.maxSize * 2,
      ),
    );

    while (true) {
      const window = this.readManifestRangeFromEntries(
        entries,
        fileSize,
        windowOffset,
        windowEnd - windowOffset,
      );
      this.overlayPages(window, windowOffset, pages);
      const prepared = await this.spliceLocalManifest(
        fileSize,
        entries,
        startIndex,
        windowOffset,
        window,
        dirtyEnd,
        boundaryToIndex,
        0,
        windowEnd === fileSize,
      );
      if (prepared !== null) return prepared;
      if (windowEnd === fileSize) {
        throw new Error(`local CDC failed to terminate at EOF for ${path}`);
      }
      windowEnd = Math.min(fileSize, windowEnd + DEFAULT_FASTCDC.maxSize * 2);
    }
  }

  private async prepareStructuralManifest(
    manifestHash: string,
    fileSize: number,
    patch: PatchRow,
  ): Promise<PreparedManifest> {
    const entries = this.manifestEntries(manifestHash, fileSize);
    const { starts, boundaryToIndex } = this.manifestLayout(entries);
    const startIndex = this.chunkIndexAt(entries, starts, patch.offset);
    const windowOffset = starts[startIndex] ?? 0;
    const oldDirtyEnd = patch.offset + patch.delete_length;
    const insert = asBytes(patch.bytes).subarray(0, patch.insert_size);
    const delta = patch.insert_size - patch.delete_length;
    const nextSize = fileSize + delta;
    const newDirtyEnd = patch.offset + patch.insert_size;
    let oldWindowEnd = Math.min(
      fileSize,
      Math.max(
        oldDirtyEnd + DEFAULT_FASTCDC.maxSize * 2,
        windowOffset + DEFAULT_FASTCDC.maxSize * 2,
      ),
    );

    while (true) {
      const oldWindow = this.readManifestRangeFromEntries(
        entries,
        fileSize,
        windowOffset,
        oldWindowEnd - windowOffset,
      );
      const nextWindow = applyEdit(
        oldWindow,
        patch.offset - windowOffset,
        patch.delete_length,
        insert,
      );
      const prepared = await this.spliceLocalManifest(
        nextSize,
        entries,
        startIndex,
        windowOffset,
        nextWindow,
        newDirtyEnd,
        boundaryToIndex,
        delta,
        oldWindowEnd === fileSize,
      );
      if (prepared !== null) return prepared;
      if (oldWindowEnd === fileSize) {
        throw new Error("local structural CDC failed to terminate at EOF");
      }
      oldWindowEnd = Math.min(fileSize, oldWindowEnd + DEFAULT_FASTCDC.maxSize * 2);
    }
  }

  async seedFile(path: string, bytes: Uint8Array): Promise<void> {
    const manifest = await this.prepareManifest(bytes);
    const parent = this.mainCommit();
    const commit = parent + 1;
    this.storage.transactionSync(() => {
      this.persistManifest(manifest);
      this.sql.exec(
        "INSERT INTO ccdc_commits(commit_id, parent_id, writer_id) VALUES (?, ?, 'seed')",
        commit,
        parent === 0 ? null : parent,
      );
      this.sql.exec(
        "INSERT INTO ccdc_versions(commit_id, path, manifest_hash, size) VALUES (?, ?, ?, ?)",
        commit,
        path,
        manifest.hash,
        manifest.size,
      );
      this.sql.exec(
        `INSERT INTO ccdc_main_files(path, commit_id, manifest_hash, size)
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
      this.sql.exec("UPDATE ccdc_meta SET v = ? WHERE k = 'main_commit'", commit);
    });
  }

  createBranch(branchId: string): void {
    this.sql.exec(
      "INSERT INTO ccdc_branches(branch_id, base_commit, state) VALUES (?, ?, 'active')",
      branchId,
      this.mainCommit(),
    );
  }

  listFiles(branchId: string | null): string[] {
    if (branchId === null) {
      return this.sql.exec<{ path: string }>(
        "SELECT path FROM ccdc_main_files ORDER BY path",
      ).toArray().map((row) => row.path);
    }

    const branch = this.branch(branchId);
    const paths = new Set(this.sql.exec<{ path: string }>(
      `WITH latest AS (
         SELECT path, MAX(commit_id) AS commit_id
           FROM ccdc_versions
          WHERE commit_id <= ?
          GROUP BY path
       )
       SELECT version.path
         FROM ccdc_versions AS version
         JOIN latest
           ON latest.path = version.path
          AND latest.commit_id = version.commit_id
        WHERE version.manifest_hash != ?`,
      branch.base_commit,
      DELETED_MANIFEST,
    ).toArray().map((row) => row.path));

    for (const row of this.sql.exec<{
      path: string;
      base_manifest: string;
      materialized_manifest: string | null;
    }>(
      `SELECT path, base_manifest, materialized_manifest
         FROM ccdc_branch_files
        WHERE branch_id = ?`,
      branchId,
    )) {
      if (row.materialized_manifest === DELETED_MANIFEST) paths.delete(row.path);
      else paths.add(row.path);
    }
    return [...paths].sort();
  }

  async readFile(branchId: string | null, path: string): Promise<Uint8Array> {
    if (branchId === null) {
      const current = maybeOne<{ manifest_hash: string; size: number }>(
        this.sql,
        "SELECT manifest_hash, size FROM ccdc_main_files WHERE path = ?",
        path,
      );
      if (current === undefined) throw new Error(`no such file: ${path}`);
      return this.readManifest(current.manifest_hash, current.size);
    }

    const branch = this.branch(branchId);
    const changed = maybeOne<BranchFileRow & Record<string, SqlStorageValue>>(
      this.sql,
      `SELECT base_manifest, base_size, materialized_manifest, materialized_size
         FROM ccdc_branch_files
        WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    );
    const base = changed ?? this.versionAt(path, branch.base_commit);
    const manifestHash = "base_manifest" in base
      ? (base.materialized_manifest ?? base.base_manifest)
      : base.manifest_hash;
    const baseSize = "base_size" in base
      ? (base.materialized_size ?? base.base_size)
      : base.size;
    if (!isContentManifest(manifestHash)) throw new Error(`no such file: ${path}`);
    let result = this.readManifest(manifestHash, baseSize);
    this.applyBranchPages(branchId, path, result);
    const patches = this.sql.exec<PatchRow>(
      `SELECT offset, delete_length, insert_size, bytes
         FROM ccdc_patches
        WHERE branch_id = ? AND path = ?
        ORDER BY seq`,
      branchId,
      path,
    ).toArray();
    for (const patch of patches) {
      result = applyEdit(
        result,
        patch.offset,
        patch.delete_length,
        asBytes(patch.bytes).subarray(0, patch.insert_size),
      );
    }
    return result;
  }

  async writeBranchFile(branchId: string, path: string, bytes: Uint8Array): Promise<void> {
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const existing = maybeOne<BranchFileRow & Record<string, SqlStorageValue>>(
      this.sql,
      `SELECT base_manifest, base_size, materialized_manifest, materialized_size
         FROM ccdc_branch_files
        WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    );
    const historical = existing === undefined
      ? this.maybeVersionAt(path, branch.base_commit)
      : undefined;
    const baseManifest = existing !== undefined
      ? existing.base_manifest
      : historical !== undefined && isContentManifest(historical.manifest_hash)
        ? historical.manifest_hash
        : MISSING_MANIFEST;
    const baseSize = existing !== undefined
      ? existing.base_size
      : historical !== undefined && isContentManifest(historical.manifest_hash)
        ? historical.size
        : 0;
    const manifest = await this.prepareManifest(bytes);
    this.storage.transactionSync(() => {
      this.persistManifest(manifest);
      this.sql.exec(
        `INSERT INTO ccdc_branch_files(
           branch_id, path, base_manifest, base_size, materialized_manifest, materialized_size
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(branch_id, path) DO UPDATE SET
           materialized_manifest = excluded.materialized_manifest,
           materialized_size = excluded.materialized_size`,
        branchId,
        path,
        baseManifest,
        baseSize,
        manifest.hash,
        manifest.size,
      );
      this.sql.exec("DELETE FROM ccdc_patches WHERE branch_id = ? AND path = ?", branchId, path);
      this.sql.exec(
        "DELETE FROM ccdc_branch_pages WHERE branch_id = ? AND path = ?",
        branchId,
        path,
      );
    });
  }

  deleteBranchFile(branchId: string, path: string): void {
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const existing = maybeOne<BranchFileRow & Record<string, SqlStorageValue>>(
      this.sql,
      `SELECT base_manifest, base_size, materialized_manifest, materialized_size
         FROM ccdc_branch_files
        WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    );
    if (existing?.base_manifest === MISSING_MANIFEST) {
      this.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM ccdc_patches WHERE branch_id = ? AND path = ?", branchId, path);
        this.sql.exec(
          "DELETE FROM ccdc_branch_pages WHERE branch_id = ? AND path = ?",
          branchId,
          path,
        );
        this.sql.exec(
          "DELETE FROM ccdc_branch_files WHERE branch_id = ? AND path = ?",
          branchId,
          path,
        );
      });
      return;
    }
    const historical = existing === undefined
      ? this.maybeVersionAt(path, branch.base_commit)
      : undefined;
    const baseManifest = existing?.base_manifest ?? historical?.manifest_hash;
    if (baseManifest === undefined || !isContentManifest(baseManifest)) {
      throw new Error(`no such file in branch: ${path}`);
    }
    const baseSize = existing?.base_size ?? historical?.size ?? 0;
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO ccdc_branch_files(
           branch_id, path, base_manifest, base_size, materialized_manifest, materialized_size
         ) VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(branch_id, path) DO UPDATE SET
           materialized_manifest = excluded.materialized_manifest,
           materialized_size = 0`,
        branchId,
        path,
        baseManifest,
        baseSize,
        DELETED_MANIFEST,
      );
      this.sql.exec("DELETE FROM ccdc_patches WHERE branch_id = ? AND path = ?", branchId, path);
      this.sql.exec(
        "DELETE FROM ccdc_branch_pages WHERE branch_id = ? AND path = ?",
        branchId,
        path,
      );
    });
  }

  async renameBranchFile(branchId: string, oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const bytes = await this.readFile(branchId, oldPath);
    const manifest = await this.prepareManifest(bytes);
    const existing = (path: string) => maybeOne<BranchFileRow & Record<string, SqlStorageValue>>(
      this.sql,
      `SELECT base_manifest, base_size, materialized_manifest, materialized_size
         FROM ccdc_branch_files WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    );
    const oldExisting = existing(oldPath);
    const newExisting = existing(newPath);
    const oldHistorical = oldExisting === undefined
      ? this.maybeVersionAt(oldPath, branch.base_commit)
      : undefined;
    const newHistorical = newExisting === undefined
      ? this.maybeVersionAt(newPath, branch.base_commit)
      : undefined;
    const oldBaseManifest = oldExisting?.base_manifest ?? oldHistorical?.manifest_hash;
    const oldBaseSize = oldExisting?.base_size ?? oldHistorical?.size ?? 0;
    if (oldBaseManifest === undefined || !isContentManifest(
      oldExisting?.materialized_manifest ?? oldBaseManifest,
    )) {
      throw new Error(`no such file in branch: ${oldPath}`);
    }
    const newBaseManifest = newExisting?.base_manifest ?? (
      newHistorical !== undefined && isContentManifest(newHistorical.manifest_hash)
        ? newHistorical.manifest_hash
        : MISSING_MANIFEST
    );
    const newBaseSize = newExisting?.base_size ?? (
      newHistorical !== undefined && isContentManifest(newHistorical.manifest_hash)
        ? newHistorical.size
        : 0
    );

    this.storage.transactionSync(() => {
      this.persistManifest(manifest);
      this.sql.exec(
        `INSERT INTO ccdc_branch_files(
           branch_id, path, base_manifest, base_size, materialized_manifest, materialized_size
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(branch_id, path) DO UPDATE SET
           materialized_manifest = excluded.materialized_manifest,
           materialized_size = excluded.materialized_size`,
        branchId,
        newPath,
        newBaseManifest,
        newBaseSize,
        manifest.hash,
        manifest.size,
      );
      this.sql.exec(
        "DELETE FROM ccdc_patches WHERE branch_id = ? AND path IN (?, ?)",
        branchId,
        oldPath,
        newPath,
      );
      this.sql.exec(
        "DELETE FROM ccdc_branch_pages WHERE branch_id = ? AND path IN (?, ?)",
        branchId,
        oldPath,
        newPath,
      );
      if (oldExisting?.base_manifest === MISSING_MANIFEST) {
        this.sql.exec(
          "DELETE FROM ccdc_branch_files WHERE branch_id = ? AND path = ?",
          branchId,
          oldPath,
        );
      } else {
        this.sql.exec(
          `INSERT INTO ccdc_branch_files(
             branch_id, path, base_manifest, base_size, materialized_manifest, materialized_size
           ) VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT(branch_id, path) DO UPDATE SET
             materialized_manifest = excluded.materialized_manifest,
             materialized_size = 0`,
          branchId,
          oldPath,
          oldBaseManifest,
          oldBaseSize,
          DELETED_MANIFEST,
        );
      }
    });
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

    const branchFile = this.ensureBranchFile(branchId, path, branch.base_commit);
    const manifestHash = branchFile.materialized_manifest ?? branchFile.base_manifest;
    const manifestSize = branchFile.materialized_size ?? branchFile.base_size;
    const patches = this.patchStats(branchId, path);
    const currentSize = manifestSize + patches.size_delta;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > currentSize) {
      throw new RangeError(`invalid edit offset ${offset}`);
    }
    if (
      !Number.isSafeInteger(deleteLength) ||
      deleteLength < 0 ||
      offset + deleteLength > currentSize
    ) {
      throw new RangeError(`invalid delete length ${deleteLength}`);
    }

    // Equal-length small writes are page-keyed COW. Only the touched 4 KiB
    // pages are read and upserted; repeated writes to a page replace one row.
    if (
      deleteLength === insert.byteLength &&
      insert.byteLength > 0 &&
      insert.byteLength <= MAX_PAGE_EDIT_BYTES &&
      patches.count === 0
    ) {
      this.writeBranchPages(
        branchId,
        path,
        manifestHash,
        manifestSize,
        offset,
        insert,
      );
      return;
    }

    // Large replacements go directly to CDC + CAS. Keeping a second full-size
    // patch copy until publish would create avoidable 2x write amplification.
    if (insert.byteLength > MAX_PATCH_BLOB_BYTES) {
      const current = await this.readFile(branchId, path);
      const edited = applyEdit(current, offset, deleteLength, insert);
      const manifest = await this.prepareManifest(edited);
      this.storage.transactionSync(() => {
        this.persistManifest(manifest);
        this.sql.exec(
          `UPDATE ccdc_branch_files
              SET materialized_manifest = ?, materialized_size = ?
            WHERE branch_id = ? AND path = ?`,
          manifest.hash,
          manifest.size,
          branchId,
          path,
        );
        this.sql.exec(
          "DELETE FROM ccdc_patches WHERE branch_id = ? AND path = ?",
          branchId,
          path,
        );
        this.sql.exec(
          "DELETE FROM ccdc_branch_pages WHERE branch_id = ? AND path = ?",
          branchId,
          path,
        );
      });
      return;
    }

    let next = one<{ seq: number }>(
      this.sql,
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ccdc_patches
        WHERE branch_id = ? AND path = ?`,
      branchId,
      path,
    ).seq;
    const segments: Uint8Array[] = [];
    if (insert.byteLength <= COW_PAGE_BYTES) {
      const record = new Uint8Array(COW_PAGE_BYTES);
      record.set(insert);
      segments.push(record);
    } else {
      for (let start = 0; start < insert.byteLength; start += MAX_PATCH_BLOB_BYTES) {
        segments.push(new Uint8Array(insert.subarray(
          start,
          Math.min(insert.byteLength, start + MAX_PATCH_BLOB_BYTES),
        )));
      }
    }

    let inserted = 0;
    this.storage.transactionSync(() => {
      segments.forEach((stored, index) => {
        const insertSize = insert.byteLength <= COW_PAGE_BYTES
          ? insert.byteLength
          : stored.byteLength;
        this.sql.exec(
          `INSERT INTO ccdc_patches(
             branch_id, path, seq, offset, delete_length, insert_size, bytes
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          branchId,
          path,
          next++,
          offset + inserted,
          index === 0 ? deleteLength : 0,
          insertSize,
          stored,
        );
        inserted += insertSize;
        this.counters.sqlitePayloadBytes += stored.byteLength;
      });
    });
  }

  async publish(branchId: string, operationId?: string): Promise<PublishResult> {
    if (operationId !== undefined) {
      if (operationId.length === 0 || operationId.length > 200) {
        throw new Error("publish operation id must contain 1-200 characters");
      }
      const previous = maybeOne<{
        branch_id: string;
        outcome: "merged" | "conflict";
        commit_id: number | null;
        conflicts_json: string;
      }>(
        this.sql,
        `SELECT branch_id, outcome, commit_id, conflicts_json
           FROM ccdc_publish_results WHERE operation_id = ?`,
        operationId,
      );
      if (previous !== undefined) {
        if (previous.branch_id !== branchId) {
          throw new Error(`publish operation ${operationId} belongs to ${previous.branch_id}`);
        }
        return {
          outcome: previous.outcome,
          commit: previous.commit_id,
          conflicts: JSON.parse(previous.conflicts_json) as string[],
        };
      }
    }
    const branch = this.branch(branchId);
    if (branch.state !== "active") throw new Error(`branch ${branchId} is not active`);
    const changes = this.sql.exec<{
      path: string;
      base_manifest: string;
      base_size: number;
      materialized_manifest: string | null;
      materialized_size: number | null;
    }>(
      `SELECT path, base_manifest, base_size, materialized_manifest, materialized_size
         FROM ccdc_branch_files
        WHERE branch_id = ? ORDER BY path`,
      branchId,
    ).toArray();

    const conflicts = changes.flatMap((change) => {
      const current = maybeOne<{ manifest_hash: string }>(
        this.sql,
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = ?",
        change.path,
      );
      return this.baseMatches(change.base_manifest, current?.manifest_hash) ? [] : [change.path];
    });
    if (conflicts.length > 0) {
      const result: PublishResult = { outcome: "conflict", commit: null, conflicts };
      if (operationId !== undefined) {
        this.sql.exec(
          `INSERT INTO ccdc_publish_results(
             operation_id, branch_id, outcome, commit_id, conflicts_json
           ) VALUES (?, ?, 'conflict', NULL, ?)`,
          operationId,
          branchId,
          JSON.stringify(conflicts),
        );
      }
      return result;
    }

    const prepared: Array<{
      path: string;
      hash: string;
      size: number;
      manifest?: PreparedManifest;
      deleted?: boolean;
    }> = [];
    for (const change of changes) {
      if (change.materialized_manifest === DELETED_MANIFEST) {
        prepared.push({ path: change.path, hash: DELETED_MANIFEST, size: 0, deleted: true });
        continue;
      }
      const patches = this.sql.exec<PatchRow>(
        `SELECT offset, delete_length, insert_size, bytes FROM ccdc_patches
          WHERE branch_id = ? AND path = ? ORDER BY seq`,
        branchId,
        change.path,
      ).toArray();
      const pageCount = one<{ count: number }>(
        this.sql,
        "SELECT COUNT(*) AS count FROM ccdc_branch_pages WHERE branch_id = ? AND path = ?",
        branchId,
        change.path,
      ).count;
      if (
        change.materialized_manifest !== null &&
        change.materialized_size !== null &&
        patches.length === 0 &&
        pageCount === 0
      ) {
        prepared.push({
          path: change.path,
          hash: change.materialized_manifest,
          size: change.materialized_size,
        });
      } else {
        const sourceManifest = change.materialized_manifest ?? change.base_manifest;
        const sourceSize = change.materialized_size ?? change.base_size;
        if (!isContentManifest(sourceManifest)) {
          throw new Error(`branch ${branchId} has no materialized content for ${change.path}`);
        }
        let manifest: PreparedManifest;
        if (pageCount > 0 && patches.length === 0) {
          manifest = await this.preparePageManifest(
            branchId,
            change.path,
            sourceManifest,
            sourceSize,
          );
        } else if (
          pageCount === 0 &&
          patches.length === 1 &&
          patches[0].insert_size + patches[0].delete_length <= MAX_PAGE_EDIT_BYTES
        ) {
          manifest = await this.prepareStructuralManifest(
            sourceManifest,
            sourceSize,
            patches[0],
          );
        } else {
          const bytes = await this.readFile(branchId, change.path);
          manifest = await this.prepareManifest(bytes);
        }
        prepared.push({
          path: change.path,
          hash: manifest.hash,
          size: manifest.size,
          manifest,
        });
      }
    }

    // Hashing and local CDC await Web Crypto. Re-check after those yields so a
    // concurrent publisher becomes a normal conflict, not a transaction error.
    const lateConflicts = changes.flatMap((change) => {
      const current = maybeOne<{ manifest_hash: string }>(
        this.sql,
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = ?",
        change.path,
      );
      return this.baseMatches(change.base_manifest, current?.manifest_hash) ? [] : [change.path];
    });
    if (lateConflicts.length > 0) {
      const result: PublishResult = {
        outcome: "conflict",
        commit: null,
        conflicts: lateConflicts,
      };
      if (operationId !== undefined) {
        this.sql.exec(
          `INSERT INTO ccdc_publish_results(
             operation_id, branch_id, outcome, commit_id, conflicts_json
           ) VALUES (?, ?, 'conflict', NULL, ?)`,
          operationId,
          branchId,
          JSON.stringify(lateConflicts),
        );
      }
      return result;
    }

    const parent = this.mainCommit();
    const commit = parent + 1;
    this.storage.transactionSync(() => {
      // The DO is single-threaded, but keep the compare in the transaction so
      // the merge rule remains explicit if this engine is reused elsewhere.
      for (const change of changes) {
        const current = maybeOne<{ manifest_hash: string }>(
          this.sql,
          "SELECT manifest_hash FROM ccdc_main_files WHERE path = ?",
          change.path,
        );
        if (!this.baseMatches(change.base_manifest, current?.manifest_hash)) {
          throw new Error(`publish race on ${change.path}`);
        }
      }
      this.sql.exec(
        "INSERT INTO ccdc_commits(commit_id, parent_id, writer_id) VALUES (?, ?, ?)",
        commit,
        parent,
        branchId,
      );
      for (const change of prepared) {
        if (change.manifest !== undefined) this.persistManifest(change.manifest);
        this.sql.exec(
          `INSERT INTO ccdc_versions(commit_id, path, manifest_hash, size)
           VALUES (?, ?, ?, ?)`,
          commit,
          change.path,
          change.hash,
          change.size,
        );
        if (change.deleted === true) {
          this.sql.exec("DELETE FROM ccdc_main_files WHERE path = ?", change.path);
        } else {
          this.sql.exec(
            `INSERT INTO ccdc_main_files(path, commit_id, manifest_hash, size)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               commit_id = excluded.commit_id,
               manifest_hash = excluded.manifest_hash,
               size = excluded.size`,
            change.path,
            commit,
            change.hash,
            change.size,
          );
        }
      }
      this.sql.exec("UPDATE ccdc_meta SET v = ? WHERE k = 'main_commit'", commit);
      this.sql.exec("DELETE FROM ccdc_patches WHERE branch_id = ?", branchId);
      this.sql.exec("DELETE FROM ccdc_branch_pages WHERE branch_id = ?", branchId);
      this.sql.exec("DELETE FROM ccdc_branch_files WHERE branch_id = ?", branchId);
      this.sql.exec("UPDATE ccdc_branches SET state = 'merged' WHERE branch_id = ?", branchId);
      if (operationId !== undefined) {
        this.sql.exec(
          `INSERT INTO ccdc_publish_results(
             operation_id, branch_id, outcome, commit_id, conflicts_json
           ) VALUES (?, ?, 'merged', ?, '[]')`,
          operationId,
          branchId,
          commit,
        );
      }
    });

    return { outcome: "merged", commit, conflicts: [] };
  }

  discardBranch(branchId: string): void {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ccdc_patches WHERE branch_id = ?", branchId);
      this.sql.exec("DELETE FROM ccdc_branch_pages WHERE branch_id = ?", branchId);
      this.sql.exec("DELETE FROM ccdc_branch_files WHERE branch_id = ?", branchId);
      this.sql.exec("UPDATE ccdc_branches SET state = 'discarded' WHERE branch_id = ?", branchId);
    });
  }

  private retainedManifestHashes(
    retainLatestCommits: number,
    includeBranches = true,
  ): Set<string> {
    const roots = new Set(
      this.sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files",
      ).toArray().map((row) => row.manifest_hash),
    );
    const commits = this.sql.exec<{ commit_id: number }>(
      "SELECT commit_id FROM ccdc_commits ORDER BY commit_id DESC LIMIT ?",
      retainLatestCommits,
    ).toArray();
    for (const commit of commits) {
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_versions WHERE commit_id = ?",
        commit.commit_id,
      )) {
        if (isContentManifest(row.manifest_hash)) roots.add(row.manifest_hash);
      }
    }
    if (!includeBranches) return roots;
    for (const row of this.sql.exec<{
      base_manifest: string;
      materialized_manifest: string | null;
    }>(
      `SELECT bf.base_manifest, bf.materialized_manifest
         FROM ccdc_branch_files AS bf
         JOIN ccdc_branches AS b ON b.branch_id = bf.branch_id
        WHERE b.state = 'active'`,
    )) {
      if (isContentManifest(row.base_manifest)) roots.add(row.base_manifest);
      if (
        row.materialized_manifest !== null &&
        isContentManifest(row.materialized_manifest)
      ) roots.add(row.materialized_manifest);
    }
    return roots;
  }

  private objectHashes(manifests: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const manifest of manifests) {
      for (const entry of this.manifestEntries(manifest)) result.add(entry.hash);
    }
    return result;
  }

  private objectBytes(hashes: Set<string>): number {
    let bytes = 0;
    const values = [...hashes];
    for (let start = 0; start < values.length; start += HASH_QUERY_BATCH) {
      const batch = values.slice(start, start + HASH_QUERY_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      bytes += one<{ bytes: number }>(
        this.sql,
        `SELECT COALESCE(SUM(size), 0) AS bytes
           FROM ccdc_objects WHERE hash IN (${placeholders})`,
        ...batch,
      ).bytes;
    }
    return bytes;
  }

  snapshot(retainLatestCommits = 1): StorageSnapshot {
    const logical = one<{ bytes: number }>(
      this.sql,
      "SELECT COALESCE(SUM(size), 0) AS bytes FROM ccdc_main_files",
    ).bytes;
    const objects = one<{ count: number; bytes: number }>(
      this.sql,
      "SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM ccdc_objects",
    );
    const patches = one<{ count: number; bytes: number }>(
      this.sql,
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(bytes)), 0) AS bytes FROM ccdc_patches",
    );
    const pages = one<{ count: number; bytes: number }>(
      this.sql,
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(bytes)), 0) AS bytes FROM ccdc_branch_pages",
    );
    const mainRoots = this.retainedManifestHashes(retainLatestCommits, false);
    const roots = this.retainedManifestHashes(retainLatestCommits, true);
    const mainObjects = this.objectHashes(mainRoots);
    const reachableObjects = this.objectHashes(roots);
    const reachableObjectBytes = this.objectBytes(reachableObjects);
    const exclusiveObjects = new Set(
      [...reachableObjects].filter((hash) => !mainObjects.has(hash)),
    );
    const exclusiveManifests = [...roots].filter((hash) => !mainRoots.has(hash));
    let exclusiveManifestBytes = 0;
    for (const hash of exclusiveManifests) {
      exclusiveManifestBytes += one<{ bytes: number }>(
        this.sql,
        `SELECT COALESCE(length(encoded), 0) AS bytes
           FROM ccdc_manifests WHERE hash = ?`,
        hash,
      ).bytes;
    }
    const versions = one<{ count: number }>(
      this.sql,
      "SELECT COUNT(*) AS count FROM ccdc_versions",
    ).count;
    const branchBytes = patches.bytes + pages.bytes;
    const branchStorage = {
      cowPageBytes: pages.bytes,
      patchBytes: patches.bytes,
      exclusiveObjectBytes: this.objectBytes(exclusiveObjects),
      exclusiveManifestBytes,
      totalExclusivePayloadBytes: 0,
    };
    branchStorage.totalExclusivePayloadBytes =
      branchStorage.cowPageBytes +
      branchStorage.patchBytes +
      branchStorage.exclusiveObjectBytes +
      branchStorage.exclusiveManifestBytes;
    const stored = objects.bytes + branchBytes;
    const reachable = reachableObjectBytes + branchBytes;
    return {
      databaseBytes: this.sql.databaseSize,
      logicalBytes: logical,
      storedPayloadBytes: stored,
      reachablePayloadBytes: reachable,
      orphanPayloadBytes: Math.max(0, stored - reachable),
      branchPayloadBytes: branchBytes,
      branchStorage,
      objectCount: objects.count + patches.count + pages.count,
      versionCount: versions,
    };
  }

  gc(retainLatestCommits = 1): GcResult {
    const started = nowMs();
    const before = this.snapshot(retainLatestCommits);
    const recordsBefore = one<{ count: number }>(
      this.sql,
      `SELECT
         (SELECT COUNT(*) FROM ccdc_objects) +
         (SELECT COUNT(*) FROM ccdc_manifests) +
         (SELECT COUNT(*) FROM ccdc_versions) AS count`,
    ).count;

    this.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM ccdc_versions
          WHERE NOT EXISTS (
            SELECT 1 FROM ccdc_main_files AS m
             WHERE m.path = ccdc_versions.path
               AND m.commit_id = ccdc_versions.commit_id
          )
            AND commit_id NOT IN (
              SELECT commit_id FROM ccdc_commits
               ORDER BY commit_id DESC LIMIT ?
            )`,
        retainLatestCommits,
      );

      const roots = new Set<string>();
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        "SELECT DISTINCT manifest_hash FROM ccdc_versions",
      )) {
        if (isContentManifest(row.manifest_hash)) roots.add(row.manifest_hash);
      }
      for (const row of this.sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files",
      )) {
        if (isContentManifest(row.manifest_hash)) roots.add(row.manifest_hash);
      }

      this.sql.exec("DELETE FROM ccdc_gc_live_objects");
      const liveObjects = new Set<string>();
      for (const root of roots) {
        for (const entry of this.manifestEntries(root)) liveObjects.add(entry.hash);
      }
      const liveHashes = [...liveObjects];
      for (let start = 0; start < liveHashes.length; start += HASH_QUERY_BATCH) {
        const batch = liveHashes.slice(start, start + HASH_QUERY_BATCH);
        const values = batch.map(() => "(?)").join(", ");
        this.sql.exec(
          `INSERT OR IGNORE INTO ccdc_gc_live_objects(hash) VALUES ${values}`,
          ...batch,
        );
      }

      for (const row of this.sql.exec<{ hash: string }>("SELECT hash FROM ccdc_manifests")) {
        if (!roots.has(row.hash)) {
          this.sql.exec("DELETE FROM ccdc_manifest_chunks WHERE manifest_hash = ?", row.hash);
          this.sql.exec("DELETE FROM ccdc_manifests WHERE hash = ?", row.hash);
        }
      }
      this.sql.exec(
        `DELETE FROM ccdc_objects
          WHERE NOT EXISTS (
            SELECT 1 FROM ccdc_gc_live_objects AS live
             WHERE live.hash = ccdc_objects.hash
          )`,
      );
      this.sql.exec("DELETE FROM ccdc_gc_live_objects");
      this.sql.exec("DELETE FROM ccdc_branches WHERE state != 'active'");
    });

    const after = this.snapshot(retainLatestCommits);
    const recordsAfter = one<{ count: number }>(
      this.sql,
      `SELECT
         (SELECT COUNT(*) FROM ccdc_objects) +
         (SELECT COUNT(*) FROM ccdc_manifests) +
         (SELECT COUNT(*) FROM ccdc_versions) AS count`,
    ).count;
    return {
      elapsedMs: nowMs() - started,
      payloadBytesReclaimed: Math.max(0, before.storedPayloadBytes - after.storedPayloadBytes),
      recordsDeleted: recordsBefore - recordsAfter,
    };
  }
}
