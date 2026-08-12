# Naive vs CAS + CDC + COW - measured results

Files: 16.0 MiB for edit workloads; 8.0 MiB for GC.

## 1. Storage - SQL payload written / payload retained

**Evidence layer: engine.**

| Workload | Naive | CAS+CDC+COW | Less written |
| --- | ---: | ---: | ---: |
| Overwrite 10 B | 512 KiB / 512 KiB | 154 KiB / 150 KiB | 69.8% |
| 5x overwrite 10 B | 2.5 MiB / 2.5 MiB | 170 KiB / 150 KiB | 93.3% |
| Prepend 10 B | 16.0 MiB / 16.0 MiB | 182 KiB / 178 KiB | 98.9% |
| Rewrite full file | 16.0 MiB / 16.0 MiB | 16.0 MiB / 16.0 MiB | 0.0% |

## 2. Edit + publish latency

**Evidence layer: engine.**

| Workload | Naive | CAS+CDC+COW | Change |
| --- | ---: | ---: | ---: |
| Overwrite 10 B | 7.00 ms | 7.00 ms | ~same |
| 5x overwrite 10 B | 29.0 ms | 15.0 ms | 1.93x faster |
| Prepend 10 B | 99.0 ms | 6.00 ms | 16.50x faster |
| Rewrite full file | 137.0 ms | 115.0 ms | 1.19x faster |

## 3. Branch and multi-writer boundary

**Evidence layer: engine.**

| Scenario | Naive | CAS+CDC+COW | Result |
| --- | ---: | ---: | --- |
| Create branch | 0 B | 0 B | Metadata only |
| Private COW-page payload | 0 B | 4.0 KiB | C3 page overlay; fixed chunks use no COW pages |
| Complete branch-exclusive content | 512 KiB | 4.0 KiB | 99.2% less |
| SQLite growth with branch active | 512 KiB | 4.0 KiB | 99.2% less |
| Two writers, disjoint files | 2/2 survive | 2/2 survive | Both merge |
| Two writers, same file | merged; 1 lost | conflict; 0 lost | Conflict is explicit |

## 4. Five checkpoints + GC

**Evidence layer: engine.**

| Metric | Naive | CAS+CDC+COW | Difference |
| --- | ---: | ---: | ---: |
| Stored before GC | 10.5 MiB | 9.0 MiB | 14.1% less |
| Orphan before GC | 2.5 MiB | 1.0 MiB | 59.0% less |
| Payload reclaimed | 2.5 MiB | 1.0 MiB | Exact unreachable data |
| GC time | 17.0 ms | 17.0 ms | ~same |

> SQL payload written counts BLOB bytes submitted by the measured edit and publish operations. Payload retained counts content BLOB growth before GC; SQLite metadata and page-reservation overhead are available in `latest.json`.
