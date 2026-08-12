const cache = new Map<string, Uint8Array>();

/** Stable high-entropy data, cached so fixture generation is outside timings. */
export function fixtureBytes(size: number, seed = 0x51f15e): Uint8Array {
  const key = `${size}:${seed}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  cache.set(key, bytes);
  return bytes;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

