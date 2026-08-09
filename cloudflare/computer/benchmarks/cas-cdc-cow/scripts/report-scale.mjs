import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.argv[2] ?? "./results/edit-scale-latest.json");
const report = JSON.parse(await readFile(source, "utf8"));
const target = source.replace(/\.json$/i, ".md");

const bytes = (value) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
};
const duration = (value) => value < 1000
  ? `${value.toFixed(value < 10 ? 2 : 0)} ms`
  : `${(value / 1000).toFixed(2)} s`;
const speed = (before, after) => `${(before / Math.max(after, 0.01)).toFixed(1)}x`;
const less = (before, after) => `${Math.max(0, (1 - after / before) * 100).toFixed(1)}%`;

const lines = [
  "# Edit-scale result",
  "",
  `One ${bytes(report.configuration.fileBytes)} file; 1-byte overwrites. Timings separate private edits from publication.`,
  "",
  "## Speed",
  "",
  "**Evidence layer: engine.**",
  "",
  "| Edits | Naive edit | C3 edit | Publish N/C3 | Total speedup |",
  "| ---: | ---: | ---: | ---: | ---: |",
  ...report.rows.map((row) =>
    `| ${row.edits.toLocaleString()} | ${duration(row.naive.editMs)} | ${duration(row["cas-cdc-cow"].editMs)} | ${duration(row.naive.publishMs)} / ${duration(row["cas-cdc-cow"].publishMs)} | ${speed(row.naive.totalMs, row["cas-cdc-cow"].totalMs)} |`
  ),
  "",
  "## Space",
  "",
  "**Evidence layer: engine.**",
  "",
  "| Edits | SQL written N/C3 | Private COW pages N/C3 | Complete branch-exclusive N/C3 | Less written |",
  "| ---: | ---: | ---: | ---: | ---: |",
  ...report.rows.map((row) =>
    `| ${row.edits.toLocaleString()} | ${bytes(row.naive.sqlitePayloadBytes)} / ${bytes(row["cas-cdc-cow"].sqlitePayloadBytes)} | ${bytes(row.naive.privateCowPagePayloadBytes)} / ${bytes(row["cas-cdc-cow"].privateCowPagePayloadBytes)} | ${bytes(row.naive.branchExclusiveContentBytes)} / ${bytes(row["cas-cdc-cow"].branchExclusiveContentBytes)} | ${less(row.naive.sqlitePayloadBytes, row["cas-cdc-cow"].sqlitePayloadBytes)} |`
  ),
  "",
  "> Fixture creation, initial seed, canonical-manifest verification, and final reads are outside the timed path.",
  "",
];

await writeFile(target, lines.join("\n"), "utf8");
console.log(target);
