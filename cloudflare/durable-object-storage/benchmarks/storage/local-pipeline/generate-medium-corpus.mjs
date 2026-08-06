import { createCipheriv, createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const target = resolve(process.argv[2] ?? "");
const requestedClass = process.argv[3];
const requestedStart = Number(process.argv[4] ?? 0);
const requestedCount = Number(process.argv[5] ?? 0);
if (
  !/^\/tmp\/cloudflare-computer-benchmark-[a-f0-9]{12}\/(workspace|native)\/medium$/.test(
    target,
  )
) {
  throw new Error(`unsafe corpus target: ${target}`);
}

const MiB = 1024 * 1024;
const zeroBlock = Buffer.alloc(MiB);
const key = createHash("sha256")
  .update("cloudflare-computer-medium-benchmark-v1")
  .digest();

function writeDeterministicFile(relativePath, size) {
  const path = resolve(target, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  const iv = createHash("sha256").update(relativePath).digest().subarray(0, 16);
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  const fd = openSync(path, "wx");
  try {
    let remaining = size;
    while (remaining > 0) {
      const length = Math.min(remaining, zeroBlock.byteLength);
      const bytes = cipher.update(zeroBlock.subarray(0, length));
      let offset = 0;
      while (offset < bytes.byteLength) {
        offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      }
      remaining -= length;
    }
  } finally {
    closeSync(fd);
  }
}

function writeClass(directory, prefix, count, size) {
  writeClassRange(directory, prefix, count, size, 0, count);
}

function writeClassRange(directory, prefix, totalCount, size, start, count) {
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1) {
    throw new Error(`invalid range: start=${start} count=${count}`);
  }
  const end = Math.min(totalCount, start + count);
  if (start >= end) throw new Error(`empty range: start=${start} count=${count}`);
  for (let index = start; index < end; index += 1) {
    const name = `${prefix}-${index.toString().padStart(6, "0")}.bin`;
    writeDeterministicFile(`${directory}/${name}`, size);
  }
}

if (requestedClass === undefined) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  writeClass("small", "small", 5_000, 4 * 1024);
  writeClass("medium", "medium", 1_000, 32 * 1024);
  writeClass("artifacts", "artifact", 256, 256 * 1024);
  writeClass("large", "large", 128, MiB);
  writeDeterministicFile("boundary/shift.bin", 32 * MiB);
} else {
  mkdirSync(target, { recursive: true });
  const classes = {
    small: ["small", "small", 5_000, 4 * 1024],
    medium: ["medium", "medium", 1_000, 32 * 1024],
    artifacts: ["artifacts", "artifact", 256, 256 * 1024],
    large: ["large", "large", 128, MiB],
  };
  if (requestedClass === "boundary") {
    if (requestedStart !== 0 || requestedCount !== 1) {
      throw new Error("boundary batch must be start=0 count=1");
    }
    writeDeterministicFile("boundary/shift.bin", 32 * MiB);
  } else {
    const config = classes[requestedClass];
    if (config === undefined) throw new Error(`unknown corpus class: ${requestedClass}`);
    writeClassRange(...config, requestedStart, requestedCount);
  }
}

process.stdout.write(
  `${JSON.stringify({
    profile: requestedClass === undefined ? "medium-v1" : "medium-v1-batch",
    class: requestedClass,
    start: requestedStart,
    count: requestedCount,
    files: 6_385,
    logicalBytes: 288_129_024,
  })}\n`,
);
