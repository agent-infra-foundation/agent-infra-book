# C3 no-cache range recipe v0.6R — recovery rerun design

Date frozen: 2026-08-10
Author: Wang Runyuan
Base revision: `e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3`
Status: frozen before the two formal recovery reruns

## Question

After an equal-length COW branch is represented as immutable CAS references
plus literal dirty-page ranges, can a consumer request only selected byte
ranges and avoid reading or transferring the complete logical file, without a
persistent receiver cache?

This experiment measures a read-only engine prototype. It does not alter a
production or default route.

## Frozen routes

1. `full-materialization`: reconstruct the complete branch file, then select
   the requested ranges.
2. `full-recipe-stream`: create the sparse recipe, stream every recipe extent,
   and select requested ranges while streaming. This isolates removal of the
   complete internal file buffer but still moves a whole file.
3. `range-recipe`: create the same recipe and read only extent overlaps with
   consumer-requested ranges. This isolates range pushdown.

Recipe payload accounting includes metadata once per request session. There is
no persistent receiver cache. Consumer-requested output buffers are excluded
from algorithmic working set; an internal complete-file buffer is included.

## Frozen matrix

Three edit workloads:

- 1 MiB, one clustered dirty page;
- 4 MiB, four file-spanning dirty pages;
- 16 MiB, sixteen file-spanning dirty pages.

Five access shapes per workload:

- first 4 KiB;
- an 8 KiB neighborhood containing a dirty page;
- three file-spanning 4 KiB ranges;
- one sequential quarter-file range;
- one sequential full-file range.

This gives 15 scenarios, three routes, three balanced repetitions, and 135
formal executions per run. Two independent formal runs give 270 executions.
Each run has one unreported correctness warm-up per route.

Each measurement uses a fresh Durable Object. Seeding, branch creation, and
COW edits are outside route timing. Requested bytes are compared exactly with
the expected logical branch after timing. A storage fingerprint is compared
before and after every measured read.

## Frozen acceptance checks

- H1 — correctness: all 270 formal executions return the exact requested
  bytes.
- H2 — read-only behavior: all 270 formal executions preserve the storage
  fingerprint.
- H3 — no complete materialization: every `range-recipe` record reports zero
  complete logical-file materializations.
- H4 — sparse payload: over the first three access shapes, aggregate
  `range-recipe` payload is at most 2% of aggregate full-file bytes in each
  run.
- H5 — quarter payload: aggregate quarter-file recipe payload is at most 26%
  of aggregate full-file bytes in each run.
- H6 — full-access overhead: aggregate full-file recipe payload is at most
  101% of aggregate full-file bytes in each run.
- H7 — bounded identity work: aggregate recipe-planning `hashedBytes` are at
  most 1% of aggregate file bytes in each run.
- H8 — bounded working set: every `range-recipe` record has peak algorithmic
  payload at most 25% of file size.
- H9 — range pushdown specificity: every non-full access scenario transfers
  fewer bytes with `range-recipe` than with `full-recipe-stream`.
- H10 — actual CAS range reads: each run records at least one CAS object-range
  query on the `range-recipe` route, while exact-byte correctness still holds.
- H11 — replicated sparse local-time direction: for the first three access
  shapes, the sum of `range-recipe` per-scenario median local time is below the
  `full-materialization` sum in each run. This is exploratory local evidence,
  not a production latency claim.

## Interpretation boundaries

- Payload ratios are deterministic mechanism accounting, not measured network
  throughput.
- Local timing excludes RPC, computerd, FUSE, native disk, network latency,
  backpressure, concurrency, and production workload distributions.
- Full sequential demand should approach one file of payload; that negative
  boundary is expected and required for honest interpretation.
- Structural edits, cache admission, cache eviction, remote authorization,
  object batching, encryption, compression, and crash recovery are outside
  scope.
- The experiment does not claim that the recipe is production-ready or that it
  proves a three-dimensional or neural-network result.

## Formal outputs

- `results/c3-range-recipe-recovery-formal-run-1.json`
- `results/c3-range-recipe-recovery-formal-run-2.json`
- `results/c3-range-recipe-recovery-analysis.json`
- `experiments/C3_RANGE_RECIPE_V06R_RECOVERY_RESULTS.md`
