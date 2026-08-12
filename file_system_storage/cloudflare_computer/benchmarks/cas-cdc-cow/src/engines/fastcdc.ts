export interface FastCdcOptions {
  minSize: number;
  averageSize: number;
  maxSize: number;
}

export interface ChunkBoundary {
  offset: number;
  length: number;
}

export const DEFAULT_FASTCDC: FastCdcOptions = {
  minSize: 32 * 1024,
  averageSize: 128 * 1024,
  maxSize: 512 * 1024,
};

// Deterministic Gear table. FastCDC uses a content-dependent rolling Gear
// fingerprint; generating the table keeps this educational implementation
// compact while retaining stable boundaries across runs.
const GEAR = new Uint32Array(256);
let gearSeed = 0x9e3779b9;
for (let index = 0; index < GEAR.length; index++) {
  gearSeed ^= gearSeed << 13;
  gearSeed ^= gearSeed >>> 17;
  gearSeed ^= gearSeed << 5;
  GEAR[index] = gearSeed >>> 0;
}

function assertOptions(options: FastCdcOptions): void {
  const { minSize, averageSize, maxSize } = options;
  if (!(minSize > 0 && minSize <= averageSize && averageSize <= maxSize)) {
    throw new RangeError("FastCDC sizes must satisfy 0 < min <= average <= max");
  }
  if ((averageSize & (averageSize - 1)) !== 0) {
    throw new RangeError("this compact FastCDC implementation requires a power-of-two average");
  }
}

function findBoundary(
  bytes: Uint8Array,
  start: number,
  options: FastCdcOptions,
): number {
  const minimum = Math.min(start + options.minSize, bytes.byteLength);
  const normal = Math.min(start + options.averageSize, bytes.byteLength);
  const maximum = Math.min(start + options.maxSize, bytes.byteLength);
  if (minimum >= bytes.byteLength) return bytes.byteLength;

  const bits = Math.log2(options.averageSize);
  const earlyMask = (2 ** Math.min(30, bits + 1) - 1) >>> 0;
  const lateMask = (2 ** Math.max(1, bits - 1) - 1) >>> 0;
  let hash = 0;

  for (let cursor = minimum; cursor < maximum; cursor++) {
    hash = ((hash << 1) + GEAR[bytes[cursor]]) >>> 0;
    const mask = cursor < normal ? earlyMask : lateMask;
    if ((hash & mask) === 0) return cursor + 1;
  }
  return maximum;
}

export function fastCdc(
  bytes: Uint8Array,
  options: FastCdcOptions = DEFAULT_FASTCDC,
): ChunkBoundary[] {
  assertOptions(options);
  const chunks: ChunkBoundary[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = findBoundary(bytes, offset, options);
    if (end <= offset) throw new Error("FastCDC did not advance");
    chunks.push({ offset, length: end - offset });
    offset = end;
  }
  return chunks;
}
