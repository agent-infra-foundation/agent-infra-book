export type PayloadPattern = "random" | "zero" | "repeated-block";

export function generatePayload(
  size: number,
  seed: number,
  pattern: PayloadPattern = "random",
): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`invalid payload size: ${size}`);
  }

  const bytes = new Uint8Array(size);
  if (pattern === "zero") return bytes;

  let state = seed >>> 0;
  const generated = pattern === "repeated-block" ? Math.min(size, 4096) : size;
  for (let i = 0; i < generated; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }

  if (pattern === "repeated-block") {
    for (let i = generated; i < size; i++) {
      bytes[i] = bytes[i % generated];
    }
  }

  return bytes;
}

export function overwriteBytes(
  input: Uint8Array,
  offset: number,
  length: number,
  value: number,
): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > input.byteLength) {
    throw new RangeError(`overwrite ${offset}+${length} exceeds ${input.byteLength}`);
  }
  const output = input.slice();
  output.fill(value & 0xff, offset, offset + length);
  return output;
}

export function insertHeadByte(input: Uint8Array, value: number): Uint8Array {
  const output = new Uint8Array(input.byteLength + 1);
  output[0] = value & 0xff;
  output.set(input, 1);
  return output;
}

export function combineHalves(shared: Uint8Array, unique: Uint8Array): Uint8Array {
  const output = new Uint8Array(shared.byteLength + unique.byteLength);
  output.set(shared, 0);
  output.set(unique, shared.byteLength);
  return output;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
