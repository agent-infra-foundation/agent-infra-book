import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  root,
  "experiments/c3-no-cache-sparse-transfer-recovery/MANIFEST.json",
);
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function canonicalTextBytes(bytes) {
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const manifest = readJson(manifestPath);
check(manifest.author === "Wang Runyuan", "unexpected author");
check(
  manifest.repositoryBaseRevision === "e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3",
  "unexpected base revision",
);
check(manifest.formalExecutions.sparseTransfer === 288, "sparse formal count must be 288");
check(manifest.formalExecutions.rangeRecipe === 270, "range formal count must be 270");
check(manifest.formalExecutions.total === 558, "combined formal count must be 558");

const seen = new Set();
for (const item of manifest.inventory) {
  check(!isAbsolute(item.path), `inventory path must be relative: ${item.path}`);
  const path = resolve(root, item.path);
  check(path.startsWith(`${root}${sep}`), `inventory path escapes root: ${item.path}`);
  check(!seen.has(item.path), `duplicate inventory path: ${item.path}`);
  seen.add(item.path);
  try {
    const bytes = canonicalTextBytes(readFileSync(path));
    check(bytes.byteLength === item.bytes, `byte count mismatch: ${item.path}`);
    check(sha256(bytes) === item.sha256, `SHA-256 mismatch: ${item.path}`);
  } catch (error) {
    failures.push(`cannot read ${item.path}: ${error.message}`);
  }
}

const sparseAnalysis = readJson(resolve(root, "results/c3-sparse-transfer-recovery-analysis.json"));
const rangeAnalysis = readJson(resolve(root, "results/c3-range-recipe-recovery-analysis.json"));
check(sparseAnalysis.allPassed === true, "sparse analysis must pass H1-H8");
check(rangeAnalysis.allPassed === true, "range analysis must pass H1-H11");
for (const [name, passed] of Object.entries(manifest.hypotheses.sparseTransfer)) {
  check(passed === true, `sparse manifest decision failed: ${name}`);
  check(sparseAnalysis.hypotheses[name]?.passed === true, `sparse analysis decision failed: ${name}`);
}
for (const [name, passed] of Object.entries(manifest.hypotheses.rangeRecipe)) {
  check(passed === true, `range manifest decision failed: ${name}`);
  check(rangeAnalysis.hypotheses[name]?.passed === true, `range analysis decision failed: ${name}`);
}

for (const [path, expected] of Object.entries(manifest.rawSha256)) {
  const bytes = canonicalTextBytes(readFileSync(resolve(root, path)));
  check(sha256(bytes) === expected, `raw SHA-256 mismatch: ${path}`);
}

const rawRuns = [
  ...sparseAnalysis.sourceRuns,
  ...rangeAnalysis.sourceRuns,
];
for (const run of rawRuns) {
  const raw = readJson(resolve(root, run.path));
  check(raw.author === "Wang Runyuan", `${run.path}: unexpected author`);
  check(
    raw.repositoryBaseRevision === manifest.repositoryBaseRevision,
    `${run.path}: base revision mismatch`,
  );
  check(
    raw.correctness.formalPassed === raw.configuration.formalExecutions,
    `${run.path}: formal correctness mismatch`,
  );
  check(
    raw.correctness.storageUnchanged === raw.configuration.formalExecutions,
    `${run.path}: storage fingerprint mismatch`,
  );
}

const summary = {
  ok: failures.length === 0,
  inventoryFiles: manifest.inventory.length,
  formalExecutions: manifest.formalExecutions,
  sparseHypotheses: manifest.hypotheses.sparseTransfer,
  rangeHypotheses: manifest.hypotheses.rangeRecipe,
  failures,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
