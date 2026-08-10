# C3 no-cache range recipe v0.6R — recovery results

Date: 2026-08-10
Author: Wang Runyuan
Base revision: `e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3`

## Outcome

Both frozen formal recovery runs passed H1–H11. Across 270 formal executions,
all 270 returned exact requested bytes and all 270 preserved the persistent
storage fingerprint. The range-recipe route never materialized a complete
logical file internally.

Formal run 2 produced these deterministic payload ratios:

- three sparse access shapes: 0.23% of full transfer;
- quarter-file access: 25.12%;
- full sequential access: 100.12%;
- recipe-planning identity work: 0.39% of file bytes.

The maximum algorithm-owned working set was
374 KiB.
Full sequential range reads issued 162
local CAS object-range queries across the three workloads. Sparse-shape local
median time summed to 4 ms versus
181 ms for full materialization.

## Frozen decisions

| Check | Decision | Frozen threshold |
| --- | --- | --- |
| H1_correctness | PASS | 270/270 formal executions exact |
| H2_readOnly | PASS | 270/270 storage fingerprints unchanged |
| H3_noCompleteMaterialization | PASS | zero complete logical-file materializations on range-recipe route |
| H4_sparsePayload | PASS | three sparse shapes <= 2% aggregate payload in each run |
| H5_quarterPayload | PASS | quarter access <= 26% aggregate payload in each run |
| H6_fullAccessOverhead | PASS | full access <= 101% aggregate payload in each run |
| H7_boundedIdentityWork | PASS | planning hashed bytes <= 1% aggregate file bytes in each run |
| H8_boundedWorkingSet | PASS | range-recipe peak <= 25% of file in every scenario/run |
| H9_rangeSpecificity | PASS | range payload < full-recipe payload in every non-full scenario/run |
| H10_actualCasRangeReads | PASS | at least one CAS object-range query in each run |
| H11_replicatedSparseLocalDirection | PASS | sparse-shape range local median sum < full materialization in each run |

## Raw evidence

- `results/c3-range-recipe-recovery-formal-run-1.json`: `6f3104beae91687911832d9c458a265183b031b138a3d5008a8db85f250520d4`
- `results/c3-range-recipe-recovery-formal-run-2.json`: `c379b07726f0c50749da76b33bbd4c91f590b207df520425941f8715e854b0fa`

## Interpretation limits

- payload ratios are deterministic mechanism accounting, not measured network throughput
- full sequential demand intentionally approaches one complete file of payload
- local timing excludes RPC, network, FUSE, native disk, concurrency, and production workload weighting
- no persistent receiver cache, production, three-dimensional, or neural-network claim

The benefit is specific to partial demand. Full sequential demand correctly
returns to approximately one file of payload. The result supports a larger
Computer-path prototype; it is not itself a production optimization claim.
