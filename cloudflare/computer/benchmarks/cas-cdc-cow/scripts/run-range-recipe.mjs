import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRelative = process.argv[2] ?? "results/c3-range-recipe-recovery-run-1.json";
const resultPath = resolve(root, outputRelative);
if (!resultPath.startsWith(`${root}${sep}`)) throw new Error("output must stay inside benchmark root");
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const child = spawn(
  process.execPath,
  [vitest, "run", "--config", "vitest.config.ts", "src/bench/range-recipe.bench.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? "/tmp/c3-range-recipe-recovery",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdoutBuffer = "";
let reportText;
let stderr = "";

function acceptLine(line) {
  const marker = "RANGE_RECIPE_JSON:";
  const markerIndex = line.indexOf(marker);
  if (markerIndex >= 0) reportText = line.slice(markerIndex + marker.length).trim();
  else if (line.includes("RANGE_RECIPE_PROGRESS:")) process.stdout.write(`${line.trim()}\n`);
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    acceptLine(stdoutBuffer.slice(0, newline));
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

child.on("close", (code) => {
  if (stdoutBuffer.length > 0) acceptLine(stdoutBuffer);
  if (code !== 0) {
    process.stderr.write(stderr);
    process.exit(code ?? 1);
  }
  if (reportText === undefined) throw new Error("benchmark completed without RANGE_RECIPE_JSON");
  const report = JSON.parse(reportText);
  report.capture = {
    id: outputRelative.match(/run-(\d+)/)?.[1] ?? "unspecified",
    capturedAt: new Date().toISOString(),
    output: outputRelative,
  };
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`RANGE_RECIPE_RESULT:${JSON.stringify({
    resultPath,
    formalExecutions: report.configuration.formalExecutions,
    correctness: report.correctness,
  })}\n`);
});
