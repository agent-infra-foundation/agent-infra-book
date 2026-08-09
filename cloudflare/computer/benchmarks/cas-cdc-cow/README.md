# CAS + CDC + COW benchmark

This small project tests whether five storage changes improve a fixed-chunk,
SQLite-backed workspace:

1. **COW branches:** keep each agent's tiny overwrites private as page-keyed
   4 KiB rows; repeated edits to one page replace that row.
2. **Content-defined chunking:** use FastCDC so front insertions do not shift
   every later chunk boundary.
3. **Local publication:** re-chunk the dirty window until it reconnects to an
   unchanged CDC boundary, then splice the old manifest prefix and suffix.
4. **Compact manifests:** encode each chunk as 32 hash bytes plus a 4-byte size,
   fetch CAS objects in batches, and lazily migrate legacy row manifests.
5. **Conflict-aware publish and exact GC:** merge disjoint files, reject stale
   same-file writers, and trace live manifests before deleting CAS objects.

Both engines execute inside a real local `workerd` Durable Object with SQLite,
through `@cloudflare/vitest-pool-workers` and `runInDurableObject()`.

## Compared designs

| Property | Naive baseline | CAS + CDC + COW |
| --- | --- | --- |
| Content storage | SHA-256 CAS | SHA-256 CAS |
| Chunk boundaries | Fixed 512 KiB | FastCDC: 32/128/512 KiB min/avg/max |
| Private tiny overwrite | New fixed chunk | Page-keyed 4 KiB UPSERT |
| Repeated same-page edits | One fixed chunk per version | One retained branch page |
| Insert/delete | Rebuild fixed chunks | Ordered structural patch |
| Small-edit publication | Replace affected fixed chunks | Local CDC and manifest splice |
| Manifest | One SQLite row per chunk | One compact binary BLOB |
| Branch publication | Last writer wins | File-level optimistic conflict check |
| GC | Manifest reachability | Manifest + active-branch reachability |

“Naive” does **not** mean one BLOB per file. Durable Object SQLite rejected a
16 MiB BLOB with `SQLITE_TOOBIG`, so the credible baseline uses 512 KiB fixed
chunks. Equal-length range writes update only overlapping fixed chunks, matching
the important behavior of Computer's VFS; inserts still shift later boundaries.
It intentionally retains full-manifest and last-writer-wins publication.

## Benchmark matrix

| Area | Cases | Primary evidence |
| --- | --- | --- |
| Storage | 10 B overwrite, five overwrites, 10 B prepend, full rewrite | SQL BLOB payload and retained payload |
| Speed | Edit plus publish for the same four cases | End-to-end milliseconds inside one DO |
| Edit scale | 1 and 1,000 evenly spaced edits | Private edit and publication measured separately |
| Branches | Create, private edit, disjoint writers, same-file writers | Private COW pages, complete branch-exclusive content, SQLite growth, merged files, lost updates |
| Multi-agent requests | 50 disjoint branches and 50 same-file branches | DO request scheduling, branch bytes, merges, conflicts |
| GC | Five checkpoints over an 8 MiB file | Stored, reachable, orphaned, reclaimed bytes |

The timed path excludes fixture generation, initial seeding, and result
verification. It includes branch edit work and publication. This project does
not include FUSE, `computerd`, container startup, network RPC, or native disk;
it isolates the proposed storage algorithm inside Durable Object SQLite.

## Run on PowerShell

```powershell
cd cloudflare/computer/benchmarks/cas-cdc-cow
powershell.exe -ExecutionPolicy Bypass -File .\scripts\run.ps1
```

The command type-checks the project, runs correctness tests, executes the
benchmark, and writes:

- [`results/latest.json`](./results/latest.json) - complete machine-readable data
- [`results/latest.md`](./results/latest.md) - four narrow presentation tables

Run the larger aggregate profile separately:

```powershell
npm.cmd run run:volume
```

It applies 32 durable checkpoints to one 64 MiB workspace and writes
`results/volume-latest.json` plus `results/volume-latest.md`.

Run the separated 1/1,000-edit profile with:

```powershell
npm.cmd run run:scale
```

It writes `results/edit-scale-latest.json` and
`results/edit-scale-latest.md`.

Run the 50-agent branch profile with:

```powershell
npm.cmd run run:agents
```

Unlike the storage micro-benchmarks, this profile sends every edit and publish
as a separate request to one local workerd Durable Object. It writes
`results/multi-agent-latest.json` and `results/multi-agent-latest.md`.

The measured branch boundary is:

```text
50 independent agent requests
  -> one Workspace-owner Durable Object
  -> one private COW branch per agent
  -> optimistic file-level publication
  -> merge disjoint files / reject stale same-file writers
```

This is the implemented multi-agent storage model. The full Computer E2E
subproject now adds a branch adapter above Computer's existing RPC wire. It
projects two private branches into two independent computerd/FUSE mirrors,
runs both shells, pulls each delta into the correct branch, and conflict-checks
publication into one authoritative SQLite database.

Every generated result table is labeled as one of three boundaries:

- **engine:** direct storage-engine calls inside local workerd SQLite;
- **Durable Object request:** separate requests to one local Durable Object;
- **full Computer E2E:** push, computerd, FUSE, shell, pull, SQLite, and verify.

## Result reading rule

The first storage number is BLOB payload submitted by edit and publish. The
second is payload still retained before GC. SQLite metadata and page allocation
are preserved in the JSON report but omitted from the narrow tables.

The implementation deliberately separates two paths:

- Equal-length edits of at most 64 KiB read only the affected CAS ranges and
  UPSERT complete 4 KiB branch pages.
- Structural edits remain ordered patches. Replacements above 512 KiB are
  materialized directly into CDC/CAS to avoid retaining another full copy.
- Publishing one page or one small structural patch performs local CDC. It
  expands the dirty window until a new boundary matches an unchanged old
  boundary, then reuses all later CAS hashes.
- Multiple structural patches use the canonical full-file fallback.

The negative controls matter:

- Widely distributed dirty pages can cover the whole file, so local CDC safely
  degrades to a full scan instead of promising constant-time publication.
- A full rewrite should not save content bytes; the direct-to-CAS path avoids a
  second full-size COW copy but cannot deduplicate unrelated replacement data.

## Full Cloudflare Computer pipeline

The storage-core benchmark above isolates algorithms. The [`e2e`](./e2e)
subproject performs the decisive comparison through the actual Computer path:

```text
Workspace DO SQLite -> push -> computerd -> FUSE -> command
                    -> pull -> Workspace DO SQLite -> verify
```

For the single-workspace profile, it builds two package sets from the same
pinned upstream commit. The baseline is unmodified Computer; C3 applies
[`dofs-c3.patch`](./e2e/patches/dofs-c3.patch) before building both the
Workspace-side package and the computerd-side package. The two-mount profile
instead compares two measured adapters behind the same Computer RPC and FUSE
path: fixed 512 KiB chunks versus C3 branches.

```powershell
cd cloudflare/computer/benchmarks/cas-cdc-cow/e2e
npm.cmd run prepare
npm.cmd run smoke
npm.cmd run benchmark
npm.cmd run branches
npm.cmd run paired:volume
npm.cmd run paired:branches
```

The paired 32 MiB result is in
[`e2e/results/paired-volume-latest.md`](./e2e/results/paired-volume-latest.md).
The paired two-agent branch result is in
[`e2e/results/paired-branches-latest.md`](./e2e/results/paired-branches-latest.md).
The narrow presentation version is in
[`e2e/results/branches-presentation.md`](./e2e/results/branches-presentation.md).
