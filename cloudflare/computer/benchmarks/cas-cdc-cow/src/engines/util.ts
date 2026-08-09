type Sql = DurableObjectStorage["sql"];

export function one<T extends Record<string, SqlStorageValue>>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T {
  const row = sql.exec<T>(query, ...bindings).toArray()[0];
  if (row === undefined) throw new Error(`query returned no row: ${query}`);
  return row;
}

export function maybeOne<T extends Record<string, SqlStorageValue>>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T | undefined {
  return sql.exec<T>(query, ...bindings).toArray()[0];
}

export function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function applyEdit(
  source: Uint8Array,
  offset: number,
  deleteLength: number,
  insert: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.byteLength) {
    throw new RangeError(`invalid edit offset ${offset}`);
  }
  if (
    !Number.isSafeInteger(deleteLength) ||
    deleteLength < 0 ||
    offset + deleteLength > source.byteLength
  ) {
    throw new RangeError(`invalid delete length ${deleteLength}`);
  }

  const result = new Uint8Array(source.byteLength - deleteLength + insert.byteLength);
  result.set(source.subarray(0, offset), 0);
  result.set(insert, offset);
  result.set(
    source.subarray(offset + deleteLength),
    offset + insert.byteLength,
  );
  return result;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function nowMs(): number {
  return performance.now();
}
