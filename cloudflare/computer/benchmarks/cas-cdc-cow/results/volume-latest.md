# High-volume aggregate result

One 64.0 MiB workspace, 32 checkpoints: 24 tiny overwrites, 7 front insertions, 1 full rewrite.

**Evidence layer: engine.**

| Aggregate metric | Naive | CAS+CDC+COW | Difference |
| --- | ---: | ---: | ---: |
| SQL payload written | 524.0 MiB | 69.2 MiB | 86.8% less |
| Write amplification | 8.19x | 1.08x | 7.57x lower |
| Retained growth before GC | 524.0 MiB | 69.1 MiB | 86.8% less |
| SQLite database growth | 526.0 MiB | 70.1 MiB | 86.7% less |
| Orphan payload before GC | 524.0 MiB | 69.1 MiB | 86.8% less |
| Edit + publish time | 3.39 s | 663 ms | 5.11x faster |
| GC payload reclaimed | 524.0 MiB | 69.1 MiB | Exact unreachable data |
| GC time | 860 ms | 261 ms | 3.30x faster |
| Stored after GC | 64.0 MiB | 64.0 MiB | Current workspace only |

> Aggregate values cover all 32 edit-and-publish operations. Initial seeding and final verification are outside the timed path.
