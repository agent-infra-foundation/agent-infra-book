# Adaptive route v0.1 evidence bundle

This bundle preserves two historical engine-layer synthetic benchmark runs for
the CAS + CDC + COW route-selection question. It is evidence-only: it does not
change a default route, add a policy helper, claim production readiness, or
claim full Computer/FUSE results.

## Scope

The benchmark uses direct storage-engine calls inside local workerd Durable
Object SQLite. It times edit and publish work for synthetic equal-length range
writes, excluding fixture generation, feature/diff costs, full Computer RPC,
computerd, FUSE, native disk, container startup, and network effects.

The matrix is 45 scenarios: 3 file sizes x 3 changed-byte sizes x five
conditional range/layout cases (1-range midpoint, 64-range clustered/spread,
256-range clustered/spread). The 4 MiB file size provides 15 calibration
scenarios; the 1 MiB and 16 MiB file sizes provide 30 held-out scenarios.
There are 450 formal measurements (45 scenarios x 2 routes x 5 repeats) plus
two warm-up correctness executions, for 452 total correctness executions.

The fitted rule is selected from 64 candidates over changed bytes
`[0, 4096, 65536, 262144]`, ranges `[0, 1, 64, 256]`, and dirty span ratio
`[0, 0.125, 0.5, 1]`. The tie-break orders lower cost, then lower changed
bytes, lower ranges, and lower dirty span ratio.

## Preserved runs

| Run | Raw file | SHA-256 | Bytes | Held-out current/adaptive/oracle ms | Speedup | Repeat-fit stability |
| --- | --- | --- | ---: | --- | ---: | --- |
| Supplied | `results/adaptive-route-supplied-7829e079.json` | `7829e079a6b9c5012ddc2759e40bd7101ab9ba9a561101197003b8d1458ff233` | 124185 | 1025 / 539 / 524 | 1.902x | 5/5 select `65536/1/0.125` |
| Clean-room | `results/adaptive-route-clean-room-077bef18.json` | `077bef181631c6ce16d25684297100b26a4416eaa1e8844afcd94866830dff65` | 124229 | 1078 / 711 / 698 | 1.516x | 3/5 select `65536/1/0.125`; alternates are `4096/1/0.125` and `4096/64/0.125` |

Both aggregate runs fit the same calibration gate:
`maxChangedBytes=65536`, `maxRanges=1`, `maxDirtySpanRatio=0.125`. All four
recorded hypothesis pass/fail statuses agree across the two runs.

The direction reproduced, but magnitude and threshold stability did not. The
supplied run reports a 1.902x held-out speedup, while the clean-room run reports
1.516x. The supplied repeat-level refits select the aggregate gate in 5/5
repeats; the clean-room repeat-level refits select it in 3/5 repeats.

## Storage trade-off

The held-out adaptive selector reduces summed latency but increases summed peak
branch-exclusive payload. In both runs, recomputed held-out current/adaptive
peak branch-exclusive payload is 44,689,135 / 105,724,767 bytes, or about
2.366x. Summed held-out SQLite payload is lower for adaptive
(117,513,079 / 106,888,055 bytes for current/adaptive), while retained and
database growth are unchanged by selector aggregation.

## Provenance

Recorded in raw JSON: schema version, benchmark layer, experiment name, author
field, repository revision, configuration, calibrated rule, aggregate summaries,
hypotheses, scenario definitions, route medians, and route samples.

Source-inferred from the historical benchmark: 45/15/30 scenario accounting,
two warm-up executions, the current route rule, candidate gate set, tie-break,
sample column meanings, route order alternation, and unique Durable Object per
measurement via the harness.

Unknown in v1 raw files: supplied host/runtime/timestamp, per-sample route
order/provenance, warm-up records, machine load, statistical uncertainty, and
full Computer/FUSE behavior.

A separately retained clean-room `ENVIRONMENT.json` receipt, not included in
this bundle, has SHA-256
`4020ea930698b8a675ce74fe1bf6fac4eab4a41f284850fe3c62b3af201c0d9f`
and records Apple M1 Ultra, macOS 14.4.1 build 23E224, Darwin 23.4.0 arm64,
and Node v26.5.0 for the clean-room run. These fields are not present in the
raw v1 result schema. The supplied run environment remains unknown.

Run `node scripts/verify-adaptive-route.mjs` from this package to recompute the
two preserved raw files.
