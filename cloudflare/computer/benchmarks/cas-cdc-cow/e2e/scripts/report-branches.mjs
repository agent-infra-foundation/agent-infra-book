import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(scriptRoot, "..");
const rawRoot = resolve(e2eRoot, "results/raw");

async function latest(variant) {
  const names = (await readdir(rawRoot)).filter(
    (name) => name.startsWith(`${variant}-branches-`) && name.endsWith(".json"),
  );
  if (names.length === 0) throw new Error(`no ${variant} branch result in ${rawRoot}`);
  const rows = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(resolve(rawRoot, name))).mtimeMs })),
  );
  rows.sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(await readFile(resolve(rawRoot, rows[0].name), "utf8"));
}

const baseline = await latest("baseline");
const c3 = await latest("c3");
if (baseline.sourceCommit !== c3.sourceCommit) {
  throw new Error(`commit mismatch: ${baseline.sourceCommit} vs ${c3.sourceCommit}`);
}
const b = baseline.measurement;
const c = c3.measurement;
const bd = b.scenarios.disjoint;
const cd = c.scenarios.disjoint;

const sum = (left, right) => left + right;
const reduction = (before, after) => before === 0 ? 0 : (1 - after / before) * 100;
const pushBytes = (scenario) => sum(scenario.agentA.push.bytes, scenario.agentB.push.bytes);
const pullBytes = (scenario) => sum(
  scenario.agentA.pull.objectBytesFetched,
  scenario.agentB.pull.objectBytesFetched,
);
const outcome = (scenario) =>
  `${scenario.agentA.publish.outcome} / ${scenario.agentB.publish.outcome}`;
const ms = (value) => `${value.toFixed(1)} ms`;
const kib = (value) => `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} KiB`;
const mib = (value) => `${(value / (1024 * 1024)).toFixed(2)} MiB`;
const pct = (value) => `${value.toFixed(1)}%`;

const summary = {
  generatedAt: new Date().toISOString(),
  benchmarkLayer: "full Computer E2E (custom branch RPC adapter)",
  sourceCommit: baseline.sourceCommit,
  baseline,
  c3,
  comparison: {
    privateCowPagePayloadBytes: {
      baseline: bd.privateCowPagePayloadBytes,
      c3: cd.privateCowPagePayloadBytes,
    },
    branchExclusivePayloadBytes: {
      baseline: bd.privateBranchExclusivePayloadBytes,
      c3: cd.privateBranchExclusivePayloadBytes,
      reductionPercent: reduction(
        bd.privateBranchExclusivePayloadBytes,
        cd.privateBranchExclusivePayloadBytes,
      ),
    },
    branchDatabaseGrowthBytes: {
      baseline: bd.privateBranchDatabaseGrowthBytes,
      c3: cd.privateBranchDatabaseGrowthBytes,
      reductionPercent: reduction(
        bd.privateBranchDatabaseGrowthBytes,
        cd.privateBranchDatabaseGrowthBytes,
      ),
    },
  },
};

const markdown = `# Fixed-chunk vs C3 branch-aware Computer result

**Benchmark layer:** full Computer E2E through a custom branch RPC adapter.

**Path:** \`${c.pipeline}\`

## Measured setup

**Evidence layer: full Computer E2E.**

| Item | Value |
| --- | --- |
| Durable authority | 1 local workerd Durable Object SQLite per variant |
| Concurrent agents | 2 private branches |
| Native execution | 2 computerd processes + 2 real FUSE mounts per variant |
| Sparse workload | 2 separate 1 MiB files; 1 byte overwritten per agent |
| Namespace workload | edit, create, delete, rename, and four conflict classes |
| Comparison | Measured fixed 512 KiB branch adapter vs measured C3 branch adapter |
| Excluded | Process startup, initial seed, and post-run verification |

## Complete branch-exclusive storage before publish

**Evidence layer: full Computer E2E.**

| Metric | Fixed-chunk | C3 | Result |
| --- | ---: | ---: | ---: |
| Private COW-page payload | ${kib(bd.privateCowPagePayloadBytes)} | **${kib(cd.privateCowPagePayloadBytes)}** | C3 page overlay |
| Total branch-exclusive content payload | ${mib(bd.privateBranchExclusivePayloadBytes)} | ${kib(cd.privateBranchExclusivePayloadBytes)} | **${pct(summary.comparison.branchExclusivePayloadBytes.reductionPercent)} less** |
| SQLite database growth with branches active | ${mib(bd.privateBranchDatabaseGrowthBytes)} | ${mib(cd.privateBranchDatabaseGrowthBytes)} | **${pct(summary.comparison.branchDatabaseGrowthBytes.reductionPercent)} less** |
| Cold push objects, both agents | ${mib(pushBytes(bd))} | ${mib(pushBytes(cd))} | Full execution mirrors |
| Pull objects, both agents | ${mib(pullBytes(bd))} | ${mib(pullBytes(cd))} | Full changed files reconstructed |

## One-pair wall time

**Evidence layer: full Computer E2E.**

| Phase | Fixed-chunk | C3 |
| --- | ---: | ---: |
| Push two branch views | ${ms(bd.phases.pushWallMs)} | ${ms(cd.phases.pushWallMs)} |
| Run both FUSE shell commands | ${ms(bd.phases.shellWallMs)} | ${ms(cd.phases.shellWallMs)} |
| Pull both execution deltas | ${ms(bd.phases.pullWallMs)} | ${ms(cd.phases.pullWallMs)} |
| Publish both branches | ${ms(bd.phases.publishWallMs)} | ${ms(cd.phases.publishWallMs)} |
| **Push -> shell -> pull -> publish** | **${ms(bd.phases.totalWallMs)}** | **${ms(cd.phases.totalWallMs)}** |

These wall times are single observations. Use the paired report for median/IQR claims.

## Correctness boundary

**Evidence layer: full Computer E2E.**

| Scenario | Fixed-chunk A / B | C3 A / B | Reading |
| --- | --- | --- | --- |
| Disjoint edit + namespace changes | ${outcome(b.scenarios.disjoint)} | ${outcome(c.scenarios.disjoint)} | Both preserve disjoint work |
| Same-file write | ${outcome(b.scenarios.sameFile)} | ${outcome(c.scenarios.sameFile)} | C3 rejects stale writer |
| Same-path create | ${outcome(b.scenarios.createCollision)} | ${outcome(c.scenarios.createCollision)} | C3 rejects collision |
| Delete versus edit | ${outcome(b.scenarios.deleteEdit)} | ${outcome(c.scenarios.deleteEdit)} | C3 prevents resurrection |
| Rename versus edit | ${outcome(b.scenarios.renameEdit)} | ${outcome(c.scenarios.renameEdit)} | C3 rejects stale old-path edit |
| Silent lost updates | **${b.verification.silentLostUpdates}** | **${c.verification.silentLostUpdates}** | File-level optimistic publication |

This is local architectural evidence, not a Cloudflare production throughput claim.
`;

await writeFile(resolve(e2eRoot, "results/branches-latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(resolve(e2eRoot, "results/branches-latest.md"), markdown);
await writeFile(resolve(e2eRoot, "results/branches-presentation.md"), markdown);
console.log(markdown);
