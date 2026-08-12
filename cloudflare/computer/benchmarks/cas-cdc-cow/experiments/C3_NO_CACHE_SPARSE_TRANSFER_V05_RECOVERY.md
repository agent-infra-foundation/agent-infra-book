# C3 no-cache sparse transfer v0.5 — recovery rerun design

Date frozen: 2026-08-10
Author: Wang Runyuan
Base revision: `e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3`
Status: frozen before the two formal recovery reruns

## Recovery provenance

The original unpushed v0.5/v0.6R local branch was removed by workspace
maintenance before its requested ZIP was created. Its previously reported
summary numbers and raw SHA-256 values remain historical references, but the
lost raw bytes are not recreated or represented as originals.

The implementation and workload below were reconstructed from the merged v0.4
base. Two pilot executions were completed only to validate the recovered
runner. They are explicitly excluded from formal decisions. This document,
the mechanism, matrix, metrics, and acceptance thresholds were then frozen
before two fresh formal recovery reruns.

## Question

Can an equal-length COW branch be exported as an ordered stream of immutable
CAS object ranges plus literal dirty-page ranges, without reconstructing a
complete logical file and without assuming a persistent receiver cache?

This is a read-only engine-layer mechanism experiment. It is not a production
route and does not change any default.

## Recovered mechanism

`exportExperimentalSparseRecipe()` walks the base manifest and the branch's
4 KiB dirty pages. It emits a contiguous, ordered recipe:

- clean intervals are immutable CAS object-range references;
- dirty intervals are literal slices from branch COW pages;
- extents may split a CAS chunk around a dirty page;
- the extents must describe every output byte exactly once and in order.

`consumeExperimentalSparseRecipe()` simulates a cold, no-cache receiver by
reading every referenced extent sequentially. It never allocates the complete
logical file. Cold wire payload is therefore still one complete file; the
experiment isolates materialization, hashing input, and working set rather
than claiming network-byte savings.

## Frozen matrix

- file sizes: 1 MiB and 16 MiB;
- dirty pages: 1, 4, and 16 pages of 4 KiB each;
- layouts: clustered and file-spanning;
- scenarios: 12;
- routes: `full-materialization` and `manifest-overlay-stream`;
- six repetitions per route/scenario;
- balanced alternating route order;
- 144 formal executions per run, two independent formal runs;
- one correctness warm-up per route before each run.

Every route measurement uses a fresh Durable Object. Seeding, branch creation,
and COW edits occur before timing. Exact-byte verification and the second
storage fingerprint occur after timing.

## Metrics

- local engine time for the read/export operation;
- cold wire payload bytes;
- bytes requiring new content identity work (`hashedBytes`);
- maximum algorithm-owned payload held at one time;
- complete logical-file materialization count;
- recipe metadata, literal, referenced, and extent counts;
- CAS object-range read count;
- exact-byte correctness;
- persistent storage fingerprint equality before and after the read.

The algorithmic working-set metric excludes persistent SQLite storage and any
consumer-owned output buffer. The streaming route has no complete output
buffer. Timing excludes RPC, network, FUSE, native disk, and downstream writes.

## Frozen acceptance checks

- H1 — correctness: all 288 formal executions reconstruct the exact expected
  bytes.
- H2 — read-only behavior: all 288 formal executions preserve the storage
  fingerprint.
- H3 — no complete materialization: every sparse-route record reports zero
  complete logical-file materializations.
- H4 — bounded identity work: sparse-route `hashedBytes` are at most 10% of
  file size in every scenario.
- H5 — bounded large-file working set: for every 16 MiB scenario, sparse-route
  peak algorithmic payload is at most 5% of file size.
- H6 — honest cold payload: sparse-route cold wire payload equals file size in
  every scenario; no cache saving is claimed.
- H7 — structural reuse: sparse recipes reference at least 90% of file bytes in
  every scenario.
- H8 — replicated local-time direction: in each formal run, the sum of
  per-scenario sparse-route median local time is at most 1.25 times the
  full-materialization sum. This is a coarse mechanism guard, not a production
  latency claim.

## Interpretation boundaries

- Passing H1–H8 establishes only that this local, read-only prototype can
  describe and stream the frozen equal-length workloads with bounded
  materialization and working set.
- A cold receiver still receives one file of payload. Network savings require
  cache presence, receiver-side CAS availability, or range-limited demand;
  those are not credited here.
- Timing medians are exploratory and do not establish a production latency
  distribution or statistical significance.
- Structural edits, conflicts, encryption, compression, remote CAS, RPC,
  backpressure, concurrency, and crash recovery are outside scope.
- This experiment makes no three-dimensional or neural architecture claim.

## Formal outputs

- `results/c3-sparse-transfer-recovery-formal-run-1.json`
- `results/c3-sparse-transfer-recovery-formal-run-2.json`
- `results/c3-sparse-transfer-recovery-analysis.json`
- `experiments/C3_NO_CACHE_SPARSE_TRANSFER_V05_RECOVERY_RESULTS.md`
