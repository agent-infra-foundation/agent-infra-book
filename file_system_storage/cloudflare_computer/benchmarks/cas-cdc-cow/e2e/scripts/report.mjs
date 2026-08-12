import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(scriptRoot, "..");
const rawRoot = resolve(e2eRoot, "results/raw");
const profile = process.argv[2] === "volume" ? "volume" : "smoke";

async function latest(variant) {
  const names = (await readdir(rawRoot)).filter(
    (name) => name.startsWith(`${variant}-${profile}-`) && name.endsWith(".json"),
  );
  if (names.length === 0) throw new Error(`no ${variant}/${profile} result in ${rawRoot}`);
  const rows = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await stat(resolve(rawRoot, name))).mtimeMs })),
  );
  rows.sort((a, b) => b.mtime - a.mtime);
  return JSON.parse(await readFile(resolve(rawRoot, rows[0].name), "utf8"));
}

const baseline = await latest("baseline");
const c3 = await latest("c3");
const b = baseline.measurement;
const c = c3.measurement;

function ratio(before, after) {
  return after === 0 ? null : before / after;
}

function reduction(before, after) {
  return before === 0 ? 0 : (1 - after / before) * 100;
}

function delta(snapshot, previous) {
  return {
    databaseBytes: snapshot.databaseBytes - previous.databaseBytes,
    uniqueBlobBytes: snapshot.uniqueBlobBytes - previous.uniqueBlobBytes,
    orphanedBlobBytes: snapshot.orphanedBlobBytes - previous.orphanedBlobBytes,
    manifestBytes: snapshot.manifestBytes - previous.manifestBytes,
  };
}

const bEdits = delta(b.storage.afterEdits, b.storage.afterCreate);
const cEdits = delta(c.storage.afterEdits, c.storage.afterCreate);
const bPrepend = delta(b.storage.afterFrontInsert, b.storage.afterEdits);
const cPrepend = delta(c.storage.afterFrontInsert, c.storage.afterEdits);

const summary = {
  generatedAt: new Date().toISOString(),
  profile,
  sourceCommit: baseline.sourceCommit,
  pipeline: b.pipeline,
  workload: { fileBytes: b.fileBytes, checkpoints: b.checkpoints, prependBytes: 10 },
  speed: {
    create: { baselineMs: b.timing.createMs, c3Ms: c.timing.createMs },
    checkpointEdits: {
      baselineMs: b.timing.checkpointEditsMs,
      c3Ms: c.timing.checkpointEditsMs,
      speedup: ratio(b.timing.checkpointEditsMs, c.timing.checkpointEditsMs),
    },
    frontInsert: {
      baselineMs: b.timing.frontInsertMs,
      c3Ms: c.timing.frontInsertMs,
      speedup: ratio(b.timing.frontInsertMs, c.timing.frontInsertMs),
    },
    read: {
      baselineMs: b.timing.readMs,
      c3Ms: c.timing.readMs,
      speedup: ratio(b.timing.readMs, c.timing.readMs),
    },
  },
  storage: {
    checkpointEdits: {
      baseline: bEdits,
      c3: cEdits,
      blobReductionPercent: reduction(bEdits.uniqueBlobBytes, cEdits.uniqueBlobBytes),
    },
    frontInsert: {
      baseline: bPrepend,
      c3: cPrepend,
      blobReductionPercent: reduction(bPrepend.uniqueBlobBytes, cPrepend.uniqueBlobBytes),
    },
    final: {
      baseline: b.storage.afterFrontInsert,
      c3: c.storage.afterFrontInsert,
      databaseReductionPercent: reduction(
        b.storage.afterFrontInsert.databaseBytes,
        c.storage.afterFrontInsert.databaseBytes,
      ),
    },
  },
  raw: { baseline, c3 },
};

const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(2);
const ms = (value) => value.toFixed(1);
const speedup = (value) => (value === null ? "n/a" : `${value.toFixed(2)}×`);
const pct = (value) => `${value.toFixed(1)}%`;
const markdown = `# Computer full-pipeline result (${profile})

**Path:** \`${summary.pipeline}\`

**Workload:** ${mib(summary.workload.fileBytes)} MiB file, ${summary.workload.checkpoints} durable tiny-edit checkpoints, then a 10-byte front insertion.

## Speed

**Evidence layer: full Computer E2E.**

| Operation | Computer baseline | C3 | Result |
| --- | ---: | ---: | ---: |
| Create | ${ms(summary.speed.create.baselineMs)} ms | ${ms(summary.speed.create.c3Ms)} ms | ${speedup(ratio(summary.speed.create.baselineMs, summary.speed.create.c3Ms))} |
| ${summary.workload.checkpoints} checkpoint edits | ${ms(summary.speed.checkpointEdits.baselineMs)} ms | ${ms(summary.speed.checkpointEdits.c3Ms)} ms | **${speedup(summary.speed.checkpointEdits.speedup)}** |
| Front insertion | ${ms(summary.speed.frontInsert.baselineMs)} ms | ${ms(summary.speed.frontInsert.c3Ms)} ms | **${speedup(summary.speed.frontInsert.speedup)}** |
| Full read + sync bracket | ${ms(summary.speed.read.baselineMs)} ms | ${ms(summary.speed.read.c3Ms)} ms | ${speedup(summary.speed.read.speedup)} |

## Storage growth before GC

**Evidence layer: full Computer E2E.**

| Workload | Computer baseline | C3 | Reduction |
| --- | ---: | ---: | ---: |
| Tiny-edit blob growth | ${mib(summary.storage.checkpointEdits.baseline.uniqueBlobBytes)} MiB | ${mib(summary.storage.checkpointEdits.c3.uniqueBlobBytes)} MiB | **${pct(summary.storage.checkpointEdits.blobReductionPercent)}** |
| Front-insert blob growth | ${mib(summary.storage.frontInsert.baseline.uniqueBlobBytes)} MiB | ${mib(summary.storage.frontInsert.c3.uniqueBlobBytes)} MiB | **${pct(summary.storage.frontInsert.blobReductionPercent)}** |
| Final SQLite database | ${mib(summary.storage.final.baseline.databaseBytes)} MiB | ${mib(summary.storage.final.c3.databaseBytes)} MiB | **${pct(summary.storage.final.databaseReductionPercent)}** |

The comparison uses the same pinned Computer commit, Worker, RPC protocol, FUSE daemon, commands, and verification. The candidate patch is installed on both the authoritative Workspace and ephemeral computerd VFS.
`;

await writeFile(resolve(e2eRoot, "results/latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(resolve(e2eRoot, "results/latest.md"), markdown);
console.log(markdown);
