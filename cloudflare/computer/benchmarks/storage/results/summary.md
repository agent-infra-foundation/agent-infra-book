# Durable Object storage benchmark summary

- Generated: 2026-08-06T11:33:04.163Z
- Profile: full
- Computer commit: `76d9e75c5688713b656bce85540d9e0071cece8b`
- Package SHA-256: `f2d1c56b7e685be887be3e63a9869948bbd5c7380ccdbb6e79e5801080fde0d2`
- Runtime: workerd-durable-object-sqlstorage

| Engine | Operation | Bytes | Ops/sample | Median ms/op | p95 ms/op | p99 ms/op | MiB/s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-sqlite | write-new | 0 | 256 | 0.0078 | 0.0078 | 0.0078 | - |
| computer-workspace | write-new | 0 | 256 | 0.0859 | 0.0977 | 0.1094 | - |
| raw-sqlite | read-full | 0 | 256 | 0.0039 | 0.0078 | 0.0273 | - |
| computer-workspace | read-full | 0 | 256 | 0.0156 | 0.0273 | 0.0352 | - |
| raw-sqlite | rewrite-identical | 0 | 256 | 0.0078 | 0.0078 | 0.0078 | - |
| computer-workspace | rewrite-identical | 0 | 256 | 0.0352 | 0.0820 | 0.0898 | - |
| raw-sqlite | write-new | 4096 | 256 | 0.0469 | 0.0508 | 0.0859 | 83.33 |
| computer-workspace | write-new | 4096 | 256 | 0.2148 | 0.2734 | 0.2734 | 18.18 |
| raw-sqlite | read-full | 4096 | 256 | 0.0078 | 0.0117 | 0.0781 | 499.97 |
| computer-workspace | read-full | 4096 | 256 | 0.0313 | 0.0625 | 0.0898 | 125.00 |
| raw-sqlite | rewrite-identical | 4096 | 256 | 0.0117 | 0.0156 | 0.0195 | 333.33 |
| computer-workspace | rewrite-identical | 4096 | 256 | 0.1016 | 0.1719 | 0.1758 | 38.46 |
| raw-sqlite | write-new | 65536 | 64 | 0.2188 | 0.2969 | 0.3438 | 285.71 |
| computer-workspace | write-new | 65536 | 64 | 0.5625 | 0.6875 | 0.7344 | 111.11 |
| raw-sqlite | read-full | 65536 | 64 | 0.0625 | 0.1563 | 0.1563 | 1000.00 |
| computer-workspace | read-full | 65536 | 64 | 0.0781 | 0.1875 | 0.2031 | 800.00 |
| raw-sqlite | rewrite-identical | 65536 | 64 | 0.0938 | 0.0938 | 0.0938 | 666.67 |
| computer-workspace | rewrite-identical | 65536 | 64 | 0.2500 | 0.2813 | 0.2969 | 250.00 |
| raw-sqlite | write-new | 524287 | 9 | 1.5556 | 1.7778 | 2.2222 | 321.43 |
| computer-workspace | write-new | 524287 | 9 | 3.0000 | 4.0000 | 4.0000 | 166.67 |
| raw-sqlite | read-full | 524287 | 9 | 0.2222 | 0.6667 | 0.6667 | 2250.00 |
| computer-workspace | read-full | 524287 | 9 | 0.2222 | 0.5556 | 0.6667 | 2250.00 |
| raw-sqlite | rewrite-identical | 524287 | 9 | 0.5556 | 0.6667 | 0.6667 | 900.00 |
| computer-workspace | rewrite-identical | 524287 | 9 | 1.4444 | 2.1111 | 2.1111 | 346.15 |
| raw-sqlite | write-new | 524288 | 8 | 1.5000 | 1.8750 | 1.8750 | 333.33 |
| computer-workspace | write-new | 524288 | 8 | 3.0000 | 4.3750 | 4.3750 | 166.67 |
| raw-sqlite | read-full | 524288 | 8 | 0.2500 | 0.7500 | 0.7500 | 2000.00 |
| computer-workspace | read-full | 524288 | 8 | 0.2500 | 0.7500 | 0.7500 | 2000.00 |
| raw-sqlite | rewrite-identical | 524288 | 8 | 0.5000 | 0.6250 | 0.6250 | 1000.00 |
| computer-workspace | rewrite-identical | 524288 | 8 | 1.3750 | 1.3750 | 1.3750 | 363.64 |
| raw-sqlite | write-new | 524289 | 8 | 1.3750 | 1.6250 | 2.7500 | 363.64 |
| computer-workspace | write-new | 524289 | 8 | 3.0000 | 4.0000 | 4.1250 | 166.67 |
| raw-sqlite | read-full | 524289 | 8 | 0.2500 | 0.6250 | 0.7500 | 2000.00 |
| computer-workspace | read-full | 524289 | 8 | 0.2500 | 0.5000 | 0.6250 | 2000.00 |
| raw-sqlite | rewrite-identical | 524289 | 8 | 0.6250 | 0.6250 | 0.6250 | 800.00 |
| computer-workspace | rewrite-identical | 524289 | 8 | 1.3750 | 1.5000 | 1.5000 | 363.64 |
| raw-sqlite | write-new | 1048576 | 4 | 2.7500 | 3.0000 | 3.2500 | 363.64 |
| computer-workspace | write-new | 1048576 | 4 | 6.0000 | 8.2500 | 8.7500 | 166.67 |
| raw-sqlite | read-full | 1048576 | 4 | 0.2500 | 0.7500 | 0.7500 | 4000.00 |
| computer-workspace | read-full | 1048576 | 4 | 0.5000 | 0.7500 | 0.7500 | 2000.00 |
| raw-sqlite | rewrite-identical | 1048576 | 4 | 1.2500 | 1.2500 | 1.2500 | 800.00 |
| computer-workspace | rewrite-identical | 1048576 | 4 | 2.5000 | 2.7500 | 3.0000 | 400.00 |
| raw-sqlite | write-new | 10485760 | 1 | 20.0000 | 22.0000 | 22.0000 | 500.00 |
| computer-workspace | write-new | 10485760 | 1 | 47.0000 | 50.0000 | 52.0000 | 212.77 |
| raw-sqlite | read-full | 10485760 | 1 | 9.0000 | 12.0000 | 12.0000 | 1111.11 |
| computer-workspace | read-full | 10485760 | 1 | 10.0000 | 11.0000 | 13.0000 | 1000.00 |
| raw-sqlite | rewrite-identical | 10485760 | 1 | 30.0000 | 43.0000 | 49.0000 | 333.33 |
| computer-workspace | rewrite-identical | 10485760 | 1 | 25.0000 | 27.0000 | 28.0000 | 400.00 |

## Five-write edit transitions

Database growth is measured from the initial write to the fifth edit.

| Engine | Variant | Logical MiB | Final DB MiB | DB growth MiB | Orphaned MiB | Unique blobs | Manifests | Fifth edit ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-sqlite | same-chunk | 10.00 | 10.03 | 0.00 | - | - | - | 29.0000 |
| computer-workspace | same-chunk | 10.00 | 12.63 | 2.52 | 2.50 | 25 | 6 | 27.0000 |
| raw-sqlite | different-chunks | 10.00 | 10.03 | 0.00 | - | - | - | 28.0000 |
| computer-workspace | different-chunks | 10.00 | 12.63 | 2.52 | 2.50 | 25 | 6 | 26.0000 |
| raw-sqlite | head-insertion | 10.00 | 10.03 | 0.00 | - | - | - | 30.0000 |
| computer-workspace | head-insertion | 10.00 | 60.21 | 50.09 | 50.00 | 125 | 6 | 45.0000 |
| raw-sqlite | identical | 10.00 | 10.03 | 0.00 | - | - | - | 28.0000 |
| computer-workspace | identical | 10.00 | 10.11 | 0.00 | 0.00 | 20 | 1 | 25.0000 |

## Ten-file deduplication datasets

| Engine | Dataset | Logical MiB | DB MiB | Unique blob MiB | DB after delete MiB | Orphaned after delete MiB | Median write ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-sqlite | identical | 100.00 | 100.14 | - | 0.02 | - | 20.0000 |
| computer-workspace | identical | 100.00 | 10.14 | 10.00 | 10.11 | 10.00 | 25.0000 |
| raw-sqlite | half-shared | 100.00 | 100.14 | - | 0.02 | - | 23.0000 |
| computer-workspace | half-shared | 100.00 | 55.23 | 55.00 | 55.21 | 55.00 | 36.0000 |
| raw-sqlite | unique | 100.00 | 100.14 | - | 0.02 | - | 23.0000 |
| computer-workspace | unique | 100.00 | 100.28 | 100.00 | 100.26 | 100.00 | 46.0000 |

## Directory workloads

| Engine | Entries | Create total ms | List ms | Stat ms | Delete total ms | DB MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| raw-sqlite | 10 | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.02 |
| computer-workspace | 10 | 1.0000 | 0.0000 | 1.0000 | 0.0000 | 0.10 |
| raw-sqlite | 1000 | 11.0000 | 1.0000 | 0.0000 | 8.0000 | 0.09 |
| computer-workspace | 1000 | 69.0000 | 1.0000 | 0.0000 | 115.0000 | 0.27 |
| raw-sqlite | 10000 | 88.0000 | 4.0000 | 1.0000 | 80.0000 | 0.71 |
| computer-workspace | 10000 | 1044.0000 | 10.0000 | 2.0000 | 1145.0000 | 1.79 |

These are local workerd measurements, not production-edge latency or billing data. Full samples and correctness records are preserved in `summary.json`.
