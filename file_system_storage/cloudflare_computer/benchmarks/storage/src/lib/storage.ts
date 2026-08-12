import type { Workspace } from "@cloudflare/computer";
import type { StorageSnapshot } from "./types";

type Sql = DurableObjectStorage["sql"];
const RAW_CHUNK_SIZE = 512 * 1024;

function one<T extends Record<string, SqlStorageValue>>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T {
  const row = sql.exec<T>(query, ...bindings).toArray()[0];
  if (row === undefined) throw new Error(`query returned no row: ${query}`);
  return row;
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function initializeRawSchema(sql: Sql): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS bench_files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS bench_file_chunks (
      path  TEXT NOT NULL,
      idx   INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (path, idx)
    )
  `);
}

export function rawWrite(
  storage: DurableObjectStorage,
  path: string,
  bytes: Uint8Array,
): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec(
      `INSERT INTO bench_files(path, size)
       VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size`,
      path,
      bytes.byteLength,
    );
    sql.exec("DELETE FROM bench_file_chunks WHERE path = ?", path);
    for (let offset = 0, index = 0; offset < bytes.byteLength; offset += RAW_CHUNK_SIZE, index++) {
      sql.exec(
        "INSERT INTO bench_file_chunks(path, idx, bytes) VALUES (?, ?, ?)",
        path,
        index,
        bytes.subarray(offset, Math.min(offset + RAW_CHUNK_SIZE, bytes.byteLength)),
      );
    }
  });
}

export function rawRead(sql: Sql, path: string): Uint8Array {
  const metadata = one<{ size: number }>(
    sql,
    "SELECT size FROM bench_files WHERE path = ?",
    path,
  );
  const result = new Uint8Array(metadata.size);
  let offset = 0;
  for (const row of sql
    .exec<{ bytes: ArrayBuffer }>(
      "SELECT bytes FROM bench_file_chunks WHERE path = ? ORDER BY idx",
      path,
    )) {
    const chunk = asBytes(row.bytes);
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== metadata.size) {
    throw new Error(`raw file ${path} expected ${metadata.size} bytes but read ${offset}`);
  }
  return result;
}

export function rawDelete(storage: DurableObjectStorage, path: string): void {
  storage.transactionSync(() => {
    storage.sql.exec("DELETE FROM bench_file_chunks WHERE path = ?", path);
    storage.sql.exec("DELETE FROM bench_files WHERE path = ?", path);
  });
}

export function rawList(sql: Sql, prefix: string): string[] {
  return sql
    .exec<{ path: string }>(
      "SELECT path FROM bench_files WHERE path LIKE ? ORDER BY path",
      `${prefix}%`,
    )
    .toArray()
    .map((row) => row.path);
}

export function rawStat(sql: Sql, path: string): number {
  return one<{ size: number }>(
    sql,
    "SELECT size FROM bench_files WHERE path = ?",
    path,
  ).size;
}

export function snapshotRaw(sql: Sql): StorageSnapshot {
  const totals = one<{ files: number; bytes: number }>(
    sql,
    `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
       FROM bench_files`,
  );
  return {
    databaseBytes: sql.databaseSize,
    logicalBytes: totals.bytes,
    fileCount: totals.files,
  };
}

export function snapshotComputer(sql: Sql): StorageSnapshot {
  const files = one<{ files: number; bytes: number }>(
    sql,
    `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes
       FROM vfs_nodes
      WHERE type = 'file'`,
  );
  const nodes = one<{ count: number }>(sql, "SELECT COUNT(*) AS count FROM vfs_nodes");
  const chunks = one<{ count: number }>(sql, "SELECT COUNT(*) AS count FROM vfs_chunks");
  const blobs = one<{ count: number; bytes: number }>(
    sql,
    `SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
       FROM vfs_blobs`,
  );
  const reachable = one<{ bytes: number }>(
    sql,
    `SELECT COALESCE(SUM(blob.size), 0) AS bytes
       FROM vfs_blobs AS blob
      WHERE EXISTS (
        SELECT 1 FROM vfs_chunks AS chunk WHERE chunk.hash = blob.hash
      )`,
  );
  const manifests = one<{ count: number; bytes: number }>(
    sql,
    `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(encoded)), 0) AS bytes
       FROM vfs_manifests`,
  );

  return {
    databaseBytes: sql.databaseSize,
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

export async function computerRead(workspace: Workspace, path: string): Promise<Uint8Array> {
  const stream = await workspace.fs.readFile(path);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
