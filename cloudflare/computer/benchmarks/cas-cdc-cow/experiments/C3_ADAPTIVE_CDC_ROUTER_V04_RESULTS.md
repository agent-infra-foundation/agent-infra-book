# C3 adaptive CDC router v0.4 results

Date: 2026-08-09 · Author: Wang Runyuan
Raw SHA-256: `e592facd8d34cf14e4828611ea1e8bf7cd1c494b2683367d7a09182bfac479fc`

## Outcome

The formal run completed 1,000 timed route executions plus five warm-up correctness executions. All 1,005 executions produced the expected final bytes, and retained growth matched across all five routes in all 40 scenarios.

The v0.4 planner successfully bounded the mechanism but did not improve latency. On 16/64-range scenarios, it reduced CDC windows from 960 to 24 (2.5%), and scan bytes from 227.91 MiB to 147.63 MiB (64.8%). Yet total time increased from 692 ms to 745 ms (107.7% of raw multi-window).

This falsifies the frozen assumption that fewer windows and fewer scanned bytes are sufficient latency predictors. The full-scan branch reconstructs one contiguous file buffer and performs whole-file chunk preparation; those copy/allocation/working-set costs are not represented by scan bytes alone.

## Aggregate route totals

Every synthetic scenario has equal weight.

| Route | Total ms | Apply ms | Publish ms | CDC scan MiB | Windows | Peak branch MiB | Fastest scenarios |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| single-window-cow | 1120 | 205 | 908 | 226.06 | 40 | 5.97 | 11 |
| raw-multi-window-cow | 831 | 199 | 629 | 268.2 | 1012 | 5.97 | 3 |
| coalesced-multi-window-cow | 835 | 210 | 627 | 187.24 | 103 | 5.97 | 8 |
| adaptive-cow | 882 | 205 | 674 | 186.21 | 58 | 5.97 | 2 |
| materialized | 835 | 824 | 5 | 400 | 40 | 83.77 | 16 |

Adaptive total was 882 ms versus 831 ms for raw multi-window (106.1%). Pre-merging alone was essentially neutral overall: 835 ms versus 831 ms (100.5%).

## Layout and range-count split

| Layout | Ranges | N | Single ms | Raw multi ms | Coalesced ms | Adaptive ms | Materialized ms | Raw windows | Adaptive windows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| midpoint | 1 | 4 | 18 | 18 | 18 | 19 | 71 | 4 | 4 |
| clustered | 4 | 6 | 57 | 61 | 63 | 61 | 106 | 24 | 6 |
| spread | 4 | 6 | 231 | 60 | 55 | 57 | 108 | 24 | 24 |
| clustered | 16 | 6 | 83 | 87 | 76 | 77 | 122 | 96 | 6 |
| spread | 16 | 6 | 291 | 164 | 170 | 286 | 135 | 96 | 6 |
| clustered | 64 | 6 | 98 | 142 | 95 | 100 | 124 | 384 | 6 |
| spread | 64 | 6 | 342 | 299 | 358 | 282 | 169 | 384 | 6 |

## Frozen hypotheses

| Hypothesis | Result | Frozen criterion |
| --- | --- | --- |
| H1_structuralRouting | PASS | adaptive selections = 22 single / 6 multi / 12 full; zero fallback |
| H2_windowBound | PASS | adaptive windows <= 10% of raw multi for rangeCount >= 16 |
| H3_scanReduction | PASS | adaptive scan bytes <= 70% of raw multi for rangeCount >= 16 |
| H4_latencyReduction | FAIL | adaptive total <= 80% of raw multi for rangeCount >= 16 |
| H5_boundedRegret | FAIL | adaptive <= 125% of fastest forced route in at least 70% of scenarios |
| H6_sparseStorage | PASS | COW peaks equal; adaptive peak <= 15% materialized; retained growth equal |
| H7_scanBudget | PASS | adaptive scan <= one file in every scenario; zero budget fallback |
| H8_correctness | PASS | all 1,005 executions correct and all 40 scenarios retained-growth consistent |

H1, H2, H3, H6, H7, and H8 passed. H4 failed: the many-range latency ratio was 1.077, against the frozen 0.80 cutoff. H5 also failed: 25/40 scenarios were within 125% of the fastest forced route, below the required 28.

## Engineering decision

Do not promote the v0.4 policy. Keep batched page application and the safe multi-window primitive as experimental building blocks. The next router must model at least two costs separately: CDC work and contiguous full-file reconstruction. A natural next preregistered test is a file-size-scaled window limit (instead of the fixed value 8) plus primitive-cost calibration on held-out layouts.

## Limits

- equal-weighted sums of per-scenario medians are synthetic summaries, not workload-weighted production estimates
- five repetitions balance route order but do not establish production latency distributions or statistical significance
- engine timing excludes Computer RPC, computerd, FUSE, diff construction, native disk, network transfer, concurrent agents, and warm CAS
- full-scan fallback reconstructs a contiguous file buffer in memory; scan bytes and window count alone do not measure allocation, copying, or working-set cost
- the frozen policy was not changed after the formal run; failed latency hypotheses are retained
