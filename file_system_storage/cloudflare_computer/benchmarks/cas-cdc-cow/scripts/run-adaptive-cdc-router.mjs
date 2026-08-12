import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const resultPath = resolve(root, "results/c3-adaptive-cdc-router-raw-v04.json");
const child = spawn(
  process.execPath,
  [vitest, "run", "--config", "vitest.config.ts", "src/bench/adaptive-cdc-router.bench.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? "/tmp/c3-adaptive-router-xdg",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdoutBuffer = "";
let reportText;
let stderr = "";

function acceptLine(line) {
  const marker = "ADAPTIVE_CDC_ROUTER_JSON:";
  const markerIndex = line.indexOf(marker);
  if (markerIndex >= 0) {
    reportText = line.slice(markerIndex + marker.length).trim();
  } else if (line.includes("ADAPTIVE_CDC_ROUTER_PROGRESS:")) {
    process.stdout.write(`${line.trim()}\n`);
  }
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
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("close", (code) => {
  if (stdoutBuffer.length > 0) acceptLine(stdoutBuffer);
  if (code !== 0) {
    process.stderr.write(stderr);
    process.exit(code ?? 1);
  }
  if (reportText === undefined) {
    throw new Error("benchmark completed without ADAPTIVE_CDC_ROUTER_JSON");
  }
  const report = JSON.parse(reportText);
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`ADAPTIVE_CDC_ROUTER_RESULT:${JSON.stringify({
    resultPath,
    scenarios: report.configuration.scenarios,
    formalExecutions: report.configuration.formalExecutions,
    correctnessExecutions: report.configuration.correctnessExecutions,
    retainedGrowthMismatches: report.retainedGrowthMismatches,
  })}\n`);
});
