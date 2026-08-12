# Cloudflare Computer full-pipeline benchmark

This subproject compares two storage representations behind the same Cloudflare Computer execution path:

```text
Workspace Durable Object SQLite
  -> push
  -> computerd
  -> FUSE-mounted Linux workspace
  -> command
  -> pull
  -> Workspace Durable Object SQLite
  -> authoritative verification
```

The variants differ only below the `@cloudflare/dofs` boundary:

- `baseline`: Cloudflare Computer's fixed 512 KiB SHA-256 chunks and JSON manifests.
- `c3`: content-defined chunks, compact manifests, and a sparse copy-on-write buffer that re-chunks only local edit windows.

This E2E project has two profiles:

- The storage profile compares baseline and C3 with one authoritative
  Workspace and one execution mount.
- The branch profile runs both a fixed-chunk branch adapter and the C3 adapter.
  Each creates two private branches, projects them into two independent
  computerd/FUSE mirrors, runs shell commands concurrently, pulls each delta
  into the matching branch, and publishes through its own policy.

Both the Durable Object bundle and `computerd` are built from the same pinned Computer commit. The C3 patch is applied before both packages are built, so the two ends use the same storage representation.

## Layout

```text
e2e/
  patches/                 reproducible C3 patch against the pinned commit
  template/                one Worker and one workload shared by both variants
  variants/
    baseline/              upstream package installation
    c3/                    patched package installation
  scripts/                 build, launch, benchmark, and report orchestration
  results/
    raw/                   per-run measurements
    latest.{json,md}       compact comparison for publication
    paired-*.{json,md}     randomized paired medians and IQRs
```

The baseline/C3 single-workspace comparison never imports the educational engine; it
exercises published Computer APIs. The branch profile deliberately imports the
fixed-chunk and C3 branch engines and connects both to Computer's existing RPC wire through
[`template/branch-computer.ts`](./template/branch-computer.ts). Both profiles
use real local FUSE. See `vendor/c3/PROVENANCE.json` after preparation for the
candidate commit and package hashes. Preparation also verifies the baseline
vendor provenance, source commit, and every baseline package SHA-256.

## Run

Docker Desktop and WSL must be available because `computerd` mounts real FUSE
inside Linux while local workerd hosts the Durable Object SQLite database.

```powershell
npm.cmd run prepare
npm.cmd run smoke
npm.cmd run benchmark
npm.cmd run branches
npm.cmd run paired:volume
npm.cmd run paired:branches
```

`prepare` starts from `git archive` of the pinned upstream commit, applies the
saved patch, runs all 436 DOFS tests, builds Computer and computerd, and installs
the two isolated variants. `benchmark` runs baseline and C3 sequentially and
writes [`results/latest.md`](./results/latest.md).

`branches` starts two separate computerd processes and verifies five
two-agent cases through shell and FUSE: disjoint edits, same-file writes,
same-path creates, delete-versus-edit, and rename-versus-edit. It writes
[`results/branches-latest.md`](./results/branches-latest.md) and the slide-ready
[`results/branches-presentation.md`](./results/branches-presentation.md).

The paired commands run 10 baseline/C3 pairs in seeded randomized order and
report median [Q1, Q3]. Set `-Iterations` on `scripts/run-paired.ps1` to any
value from 10 through 30.

## Current paired 32 MiB result

**Evidence layer: full Computer E2E. Median [Q1, Q3] over 10 paired runs.**

| Operation | Baseline | C3 | Result |
| --- | ---: | ---: | ---: |
| Initial creation | 1,618.5 ms [1,609.3, 1,630.8] | 2,219.0 ms [2,169.0, 2,276.0] | C3 is 37% slower |
| 16 durable tiny edits | 5,122.0 ms [5,100.5, 5,159.0] | 1,608.5 ms [1,569.5, 1,615.5] | **3.18x faster** |
| 10-byte front insertion | 1,638.0 ms [1,628.3, 1,682.8] | 430.0 ms [424.3, 443.8] | **3.81x faster** |
| Front-insert blob growth | 32.00 MiB | 0.19 MiB | **99.4% less** |
| Final SQLite database | 72.32 MiB | 35.89 MiB | **50.4% smaller** |

These are local end-to-end measurements intended as architectural evidence, not
claims about Cloudflare production latency. Storage deltas are exact SQL state
for the run and are recorded before the one-hour orphan-GC safety window.

## Current paired two-agent branch result

**Evidence layer: full Computer E2E.**

| Branch storage before publish | Fixed-chunk | C3 | Result |
| --- | ---: | ---: | ---: |
| Private COW-page payload | 0 KiB | 8 KiB | C3 page overlay |
| Complete branch-exclusive content | 1.00 MiB | 8.2 KiB | **99.2% less** |
| SQLite growth with branches active | 1.01 MiB | 0.01 MiB | **99.2% less** |

**Evidence layer: full Computer E2E.**

| Scenario | Publish A / B | Verified behavior |
| --- | --- | --- |
| Disjoint sparse edit + create/delete/rename | merged / merged | Both branches survive |
| Same-file write | merged / conflict | Stale writer rejected |
| Same-path create | merged / conflict | Collision rejected |
| Delete versus edit | merged / conflict | Edit cannot resurrect deleted base |
| Rename versus edit | merged / conflict | Stale old-path edit rejected |

Each run observed one authoritative Durable Object SQLite database, two private
branches, two independent computerd processes, and two real FUSE mounts. C3
produced zero silent lost updates; the last-writer-wins fixed-chunk adapter lost
four updates across the conflict cases. This is architectural evidence for the
prototype boundary, not a production concurrency-capacity claim.
