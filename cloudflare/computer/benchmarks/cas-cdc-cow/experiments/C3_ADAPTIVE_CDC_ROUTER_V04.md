# C3 adaptive CDC router v0.4 — frozen engineering experiment

Date: 2026-08-09 · Author: Wang Runyuan
Base revision: `d63eec0a10c327fa52c52e83897cf6e43490df68`
Status: frozen before the formal run

## Question

Can a deterministic page-layout planner keep the useful part of multi-window
CDC while preventing the 16/64-range window explosion observed in v0.3?

This is an engineering experiment about the author's CAS + CDC + COW design.
It does not test a three-dimensional or Kakeya claim and does not change the
production/default route. Publication is a separate review step.

## Frozen planner

The planner sees only the dirty 4 KiB page locations, the old CDC manifest, and
the file size. It does not see benchmark labels or timing results.

1. Convert dirty pages into contiguous runs.
2. Pre-merge runs whose clean gap is at most two FastCDC maximum chunks:
   `2 × 512 KiB = 1 MiB`.
3. Estimate the first scan window for every remaining run.
4. Choose bounded multi-window CDC when there are 2–8 merged runs and the sum
   of estimated first windows is at most one full file.
5. Otherwise choose one dirty envelope when its estimated first scan is at
   most 50% of the file.
6. Otherwise reconstruct the final file in memory and perform one full CDC
   scan at publish time.
7. A multi-window attempt has an actual scan budget of one file. Before a scan
   that would cross the budget, it aborts and falls back to the full scan.

The full-scan fallback does not store a full materialized branch copy. Branch
state remains page-backed COW until publication.

## Five forced routes

| Route | Apply | Publish |
| --- | --- | --- |
| `single-window-cow` | Batched page COW | Existing one dirty envelope |
| `raw-multi-window-cow` | Batched page COW | Unmodified v0.3 per-run multi-window logic |
| `coalesced-multi-window-cow` | Batched page COW | Multi-window after the frozen 1 MiB pre-merge only |
| `adaptive-cow` | Batched page COW | Frozen planner: bounded multi, single envelope, or full scan |
| `materialized` | Existing `writeBranchFile()` | Existing prepared-manifest publication |

The first three COW routes are ablations. They separate the effect of run
pre-merging from the effect of the route and scan-budget policy.

## Frozen matrix

- File sizes: 4 MiB and 16 MiB.
- Changed bytes: 16 KiB, 64 KiB, and 256 KiB.
- Range counts: 1, 4, 16, and 64.
- Include a cell only when each range is at most 64 KiB, so page-backed COW is
  used by every sparse route.
- One range uses the midpoint layout. Multiple ranges use clustered and
  file-spanning layouts.
- 40 scenarios.
- Five routes and five repetitions per route/scenario.
- For every scenario, cyclic route rotation places every route in each of the
  five execution-order positions exactly once.
- 1,000 formal executions plus five warm-up correctness executions.
- Every route measurement uses a fresh Durable Object and cold CAS.

Fixture construction, seeding, snapshots, and the final verification read are
outside route timing. Every execution must publish identical final bytes.

## Recorded metrics

- apply, publish, and total route time;
- SQLite submitted BLOB payload;
- peak branch-exclusive payload;
- retained and database growth;
- CDC scan bytes, window count, and full-manifest count;
- page loads, loaded bytes, and page UPSERTs;
- raw and planned multi-window run counts;
- planner raw/coalesced run counts and estimated scan bytes;
- selected single/multi/full route count;
- scan-budget abort and fallback count.

## Frozen hypotheses

- **H1 — structural routing:** the planner selects multi-window for the six
  4-range spread scenarios, single-window for all 22 midpoint/clustered
  scenarios, and full scan for the twelve 16/64-range spread scenarios, with
  zero budget fallback.
- **H2 — window explosion is bounded:** for scenarios with at least 16 ranges,
  adaptive CDC window count is at most 10% of raw multi-window count.
- **H3 — repeated scan is reduced:** for scenarios with at least 16 ranges,
  adaptive CDC scan bytes are at most 70% of raw multi-window scan bytes.
- **H4 — the mechanism becomes latency reduction:** for scenarios with at
  least 16 ranges, adaptive total time is at most 80% of raw multi-window total
  time.
- **H5 — bounded route regret:** adaptive total time is at most 125% of the
  fastest forced route in at least 70% of the 40 scenarios.
- **H6 — sparse storage is preserved:** adaptive peak branch payload equals
  the other page-COW routes in every scenario, summed adaptive peak branch
  payload is at most 15% of materialized, and retained growth is identical
  across all routes.
- **H7 — scan budget holds end to end:** adaptive CDC scan bytes are no more
  than one full file in every scenario and no budget fallback occurs.
- **H8 — correctness:** all 1,005 executions produce the exact expected bytes.

## Scope limits

This is a local engine-layer synthetic benchmark. Five repetitions improve
order balance but do not establish production latency distributions. The
experiment excludes Computer RPC, computerd, FUSE, native disk, network
transfer, diff construction, concurrent agents, warm CAS, and workload
weighting. Success would justify a later full pull/publish E2E experiment; it
would not by itself justify changing the production route.
