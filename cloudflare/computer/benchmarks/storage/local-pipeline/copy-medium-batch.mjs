import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve(process.argv[2] ?? "");
const target = resolve(process.argv[3] ?? "");
const requestedClass = process.argv[4] ?? "";
const start = Number(process.argv[5]);
const count = Number(process.argv[6]);

const sourceMatch = source.match(
  /^(\/tmp\/cloudflare-computer-benchmark-[a-f0-9]{12}\/(?:workspace|native))\/medium$/,
);
if (sourceMatch === null || target !== `${sourceMatch[1]}/medium-copy`) {
  throw new Error(`unsafe copy roots: ${source} -> ${target}`);
}
if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1) {
  throw new Error(`invalid copy range: start=${start} count=${count}`);
}

const classes = {
  small: ["small", "small", 5_000],
  medium: ["medium", "medium", 1_000],
  artifacts: ["artifacts", "artifact", 256],
  large: ["large", "large", 128],
};

function copyRelative(relativePath) {
  const from = resolve(source, relativePath);
  const to = resolve(target, relativePath);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

if (requestedClass === "boundary") {
  if (start !== 0 || count !== 1) throw new Error("boundary copy must be start=0 count=1");
  copyRelative("boundary/shift.bin");
} else {
  const config = classes[requestedClass];
  if (config === undefined) throw new Error(`unknown corpus class: ${requestedClass}`);
  const [directory, prefix, total] = config;
  const end = Math.min(total, start + count);
  if (start >= end) throw new Error(`empty copy range: start=${start} count=${count}`);
  for (let index = start; index < end; index += 1) {
    const name = `${prefix}-${index.toString().padStart(6, "0")}.bin`;
    copyRelative(`${directory}/${name}`);
  }
}

process.stdout.write(`${JSON.stringify({ requestedClass, start, count })}\n`);
