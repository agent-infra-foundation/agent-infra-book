# C3 no-cache sparse transfer v0.5 — recovery results

Date: 2026-08-10
Author: Wang Runyuan
Base revision: `e745e1da8a6ee3e97fa794ce36a5d504d74bdeb3`

## Outcome

Both frozen formal recovery runs passed H1–H8. Across 288 formal executions,
all 288 reconstructed the expected bytes and all 288 preserved the persistent
storage fingerprint. The sparse route reported zero complete logical-file
materializations.

In formal run 2, the sum of per-scenario median local time was
103 ms for the sparse stream and
172 ms for full materialization
(59.88%). The largest identity-work
ratio was 6.25%; the largest 16 MiB
algorithmic working-set ratio was 3.13%;
and every recipe referenced at least 93.75%
of logical bytes.

Cold wire payload remained exactly one file. This route removes complete-file
materialization and bounds working memory; it does not save cold network bytes.

## Frozen decisions

| Check | Decision | Frozen threshold |
| --- | --- | --- |
| H1_correctness | PASS | 288/288 formal executions exact |
| H2_readOnly | PASS | 288/288 storage fingerprints unchanged |
| H3_noCompleteMaterialization | PASS | zero complete logical-file materializations on sparse route |
| H4_boundedIdentityWork | PASS | hashed bytes <= 10% of file in every scenario/run |
| H5_largeFileWorkingSet | PASS | 16 MiB sparse peak <= 5% of file in every scenario/run |
| H6_honestColdPayload | PASS | cold wire payload equals file size; no cache credit |
| H7_structuralReuse | PASS | at least 90% referenced bytes in every scenario/run |
| H8_replicatedLocalDirection | PASS | sparse median-sum local time <= 1.25x full in each run |

## Raw evidence

- `results/c3-sparse-transfer-recovery-formal-run-1.json`: `fbe703ca0f212a521cd112d7d1c7bab88422936b8520eb423248928a5581bfe9`
- `results/c3-sparse-transfer-recovery-formal-run-2.json`: `1eb49e9fa1c48f3f01b0917b68fefdf21e4c5876f7e2b9aa5f79d2dbd35efd46`

## Interpretation limits

- cold wire payload remains one complete file because no receiver cache is assumed
- local timing excludes RPC, network, FUSE, native disk, concurrency, and production workload weighting
- the prototype handles only patch-free equal-length COW branches
- no production, three-dimensional, or neural-network claim

The original unpushed raw files were lost during workspace maintenance. These
are fresh, prospectively frozen recovery reruns and are not represented as the
lost original bytes.
