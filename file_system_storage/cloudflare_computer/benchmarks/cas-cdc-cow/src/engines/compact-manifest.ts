import { fastCdc } from "./fastcdc";
import { encodeText, sha256Hex } from "./util";

export interface ManifestEntry {
  hash: string;
  size: number;
}

export interface PreparedChunk extends ManifestEntry {
  bytes: Uint8Array;
}

export interface PreparedManifest {
  hash: string;
  size: number;
  encoded: Uint8Array;
  entries: ManifestEntry[];
  /** Only chunks created by this operation need to carry bytes. */
  chunks: PreparedChunk[];
}

const HASH_BYTES = 32;
const ENTRY_BYTES = HASH_BYTES + 4;
const HASH_CONCURRENCY = 16;

function hexNibble(character: number): number {
  if (character >= 48 && character <= 57) return character - 48;
  if (character >= 97 && character <= 102) return character - 87;
  if (character >= 65 && character <= 70) return character - 55;
  throw new Error(`invalid hexadecimal character ${String.fromCharCode(character)}`);
}

function hexToBytes(value: string): Uint8Array {
  if (value.length !== HASH_BYTES * 2) {
    throw new Error(`expected a ${HASH_BYTES}-byte hash, got ${value.length / 2}`);
  }
  const result = new Uint8Array(HASH_BYTES);
  for (let index = 0; index < result.byteLength; index++) {
    result[index] = (
      hexNibble(value.charCodeAt(index * 2)) << 4 |
      hexNibble(value.charCodeAt(index * 2 + 1))
    );
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function encodeManifest(entries: ManifestEntry[]): Uint8Array {
  const encoded = new Uint8Array(entries.length * ENTRY_BYTES);
  const view = new DataView(encoded.buffer);
  entries.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffff_ffff) {
      throw new RangeError(`invalid manifest chunk size ${entry.size}`);
    }
    const offset = index * ENTRY_BYTES;
    encoded.set(hexToBytes(entry.hash), offset);
    view.setUint32(offset + HASH_BYTES, entry.size, true);
  });
  return encoded;
}

export function decodeManifest(encoded: Uint8Array): ManifestEntry[] {
  if (encoded.byteLength % ENTRY_BYTES !== 0) {
    throw new Error(`invalid compact manifest length ${encoded.byteLength}`);
  }
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const entries: ManifestEntry[] = [];
  for (let offset = 0; offset < encoded.byteLength; offset += ENTRY_BYTES) {
    entries.push({
      hash: bytesToHex(encoded.subarray(offset, offset + HASH_BYTES)),
      size: view.getUint32(offset + HASH_BYTES, true),
    });
  }
  return entries;
}

export async function prepareExplicitChunks(chunks: Uint8Array[]): Promise<PreparedChunk[]> {
  const prepared: PreparedChunk[] = [];
  for (let start = 0; start < chunks.length; start += HASH_CONCURRENCY) {
    const batch = chunks.slice(start, start + HASH_CONCURRENCY);
    prepared.push(...await Promise.all(batch.map(async (bytes) => ({
      hash: await sha256Hex(bytes),
      size: bytes.byteLength,
      bytes,
    }))));
  }
  return prepared;
}

export async function prepareManifestFromEntries(
  size: number,
  entries: ManifestEntry[],
  chunks: PreparedChunk[],
): Promise<PreparedManifest> {
  const actualSize = entries.reduce((total, entry) => total + entry.size, 0);
  if (actualSize !== size) {
    throw new Error(`manifest entries describe ${actualSize} of ${size} bytes`);
  }
  const encoded = encodeManifest(entries);
  const prefix = encodeText(`${size}\n`);
  const identity = new Uint8Array(prefix.byteLength + encoded.byteLength);
  identity.set(prefix, 0);
  identity.set(encoded, prefix.byteLength);
  return {
    hash: await sha256Hex(identity),
    size,
    encoded,
    entries,
    chunks,
  };
}

export async function prepareRegionChunks(bytes: Uint8Array): Promise<PreparedChunk[]> {
  const chunks = fastCdc(bytes).map((boundary) => new Uint8Array(bytes.subarray(
    boundary.offset,
    boundary.offset + boundary.length,
  )));
  return prepareExplicitChunks(chunks);
}

export async function prepareFullManifest(bytes: Uint8Array): Promise<PreparedManifest> {
  const chunks = await prepareRegionChunks(bytes);
  return prepareManifestFromEntries(bytes.byteLength, chunks, chunks);
}
