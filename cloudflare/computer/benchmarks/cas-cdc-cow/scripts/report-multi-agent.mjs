import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.argv[2] ?? "./results/multi-agent-latest.json");
const report = JSON.parse(await readFile(source, "utf8"));
const naive = report.results.naive;
const c3 = report.results["cas-cdc-cow"];
const kib = (bytes) => `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`;
const ms = (value) => `${value.toFixed(1)} ms`;
const reduction = (before, after) => `${((1 - after / before) * 100).toFixed(1)}% less`;

const lines = [
  "# Multi-agent branch benchmark",
  "",
  `${report.configuration.agents} logically concurrent agent requests through one local workerd Durable Object; each file is ${(report.configuration.fileBytes / 1024).toFixed(0)} KiB.`,
  "",
  "## Disjoint-file branches",
  "",
  "**Evidence layer: Durable Object request.**",
  "",
  "| Metric | Naive | C3 | Result |",
  "| --- | ---: | ---: | --- |",
  `| Private COW-page payload | ${kib(naive.disjoint.privateCowPagePayloadBytes)} | ${kib(c3.disjoint.privateCowPagePayloadBytes)} | C3 page overlay; fixed chunks use no COW pages |`,
  `| Complete branch-exclusive content | ${kib(naive.disjoint.branchExclusiveContentBytes)} | ${kib(c3.disjoint.branchExclusiveContentBytes)} | **${reduction(naive.disjoint.branchExclusiveContentBytes, c3.disjoint.branchExclusiveContentBytes)}** |`,
  `| SQLite growth with branches active | ${kib(naive.disjoint.branchDatabaseGrowthBytes)} | ${kib(c3.disjoint.branchDatabaseGrowthBytes)} | **${reduction(naive.disjoint.branchDatabaseGrowthBytes, c3.disjoint.branchDatabaseGrowthBytes)}** |`,
  `| Edit requests | ${ms(naive.disjoint.editMs)} | ${ms(c3.disjoint.editMs)} | 50 branches |`,
  `| Publish requests | ${ms(naive.disjoint.publishMs)} | ${ms(c3.disjoint.publishMs)} | 50 publications |`,
  `| Correct final files | ${naive.disjoint.correctFiles}/50 | ${c3.disjoint.correctFiles}/50 | All disjoint edits survive |`,
  "",
  "## Same-file contention",
  "",
  "**Evidence layer: Durable Object request.**",
  "",
  "| Metric | Naive | C3 | Result |",
  "| --- | ---: | ---: | --- |",
  `| Publications reported merged | ${naive.sameFile.merged} | ${c3.sameFile.merged} | C3 accepts one winner |`,
  `| Explicit conflicts | ${naive.sameFile.conflicts} | ${c3.sameFile.conflicts} | C3 rejects stale branches |`,
  `| Silent lost updates | ${naive.sameFile.silentLostUpdates} | ${c3.sameFile.silentLostUpdates} | **C3: zero** |`,
  `| Private COW-page payload | ${kib(naive.sameFile.privateCowPagePayloadBytes)} | ${kib(c3.sameFile.privateCowPagePayloadBytes)} | C3 page overlay; fixed chunks use no COW pages |`,
  `| Complete branch-exclusive content | ${kib(naive.sameFile.branchExclusiveContentBytes)} | ${kib(c3.sameFile.branchExclusiveContentBytes)} | **${reduction(naive.sameFile.branchExclusiveContentBytes, c3.sameFile.branchExclusiveContentBytes)}** |`,
  `| SQLite growth with branches active | ${kib(naive.sameFile.branchDatabaseGrowthBytes)} | ${kib(c3.sameFile.branchDatabaseGrowthBytes)} | **${reduction(naive.sameFile.branchDatabaseGrowthBytes, c3.sameFile.branchDatabaseGrowthBytes)}** |`,
  "",
  "> This profile isolates the branch engine through separate Durable Object requests. The complementary E2E profile validates two branch identities through two independent Computer/FUSE mounts.",
  "",
];

const destination = resolve(source.replace(/\.json$/u, ".md"));
await writeFile(destination, lines.join("\n"), "utf8");
console.log(destination);
