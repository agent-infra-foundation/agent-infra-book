# Fixed-chunk vs C3 branch-aware Computer result

**Benchmark layer:** full Computer E2E through a custom branch RPC adapter.

**Path:** `Durable Object-owned branch store -> push -> dedicated computerd/FUSE -> shell -> pull -> branch -> publish`

## Measured setup

**Evidence layer: full Computer E2E.**

| Item | Value |
| --- | --- |
| Durable authority | 1 local workerd Durable Object SQLite per variant |
| Concurrent agents | 2 private branches |
| Native execution | 2 computerd processes + 2 real FUSE mounts per variant |
| Sparse workload | 2 separate 1 MiB files; 1 byte overwritten per agent |
| Namespace workload | edit, create, delete, rename, and four conflict classes |
| Comparison | Measured fixed 512 KiB branch adapter vs measured C3 branch adapter |
| Excluded | Process startup, initial seed, and post-run verification |

## Complete branch-exclusive storage before publish

**Evidence layer: full Computer E2E.**

| Metric | Fixed-chunk | C3 | Result |
| --- | ---: | ---: | ---: |
| Private COW-page payload | 0 KiB | **8 KiB** | C3 page overlay |
| Total branch-exclusive content payload | 1.00 MiB | 8.2 KiB | **99.2% less** |
| SQLite database growth with branches active | 1.01 MiB | 0.01 MiB | **99.2% less** |
| Cold push objects, both agents | 4.00 MiB | 4.00 MiB | Full execution mirrors |
| Pull objects, both agents | 2.00 MiB | 2.00 MiB | Full changed files reconstructed |

## One-pair wall time

**Evidence layer: full Computer E2E.**

| Phase | Fixed-chunk | C3 |
| --- | ---: | ---: |
| Push two branch views | 192.0 ms | 189.0 ms |
| Run both FUSE shell commands | 30.0 ms | 35.0 ms |
| Pull both execution deltas | 89.0 ms | 89.0 ms |
| Publish both branches | 0.0 ms | 5.0 ms |
| **Push -> shell -> pull -> publish** | **314.0 ms** | **320.0 ms** |

These wall times are single observations. Use the paired report for median/IQR claims.

## Correctness boundary

**Evidence layer: full Computer E2E.**

| Scenario | Fixed-chunk A / B | C3 A / B | Reading |
| --- | --- | --- | --- |
| Disjoint edit + namespace changes | merged / merged | merged / merged | Both preserve disjoint work |
| Same-file write | merged / merged | merged / conflict | C3 rejects stale writer |
| Same-path create | merged / merged | merged / conflict | C3 rejects collision |
| Delete versus edit | merged / merged | merged / conflict | C3 prevents resurrection |
| Rename versus edit | merged / merged | merged / conflict | C3 rejects stale old-path edit |
| Silent lost updates | **4** | **0** | File-level optimistic publication |

This is local architectural evidence, not a Cloudflare production throughput claim.
