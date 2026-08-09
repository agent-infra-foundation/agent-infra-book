# Paired Computer full-pipeline benchmark

**Benchmark layer:** full Computer E2E through upstream Workspace.runtime.exec().

**Protocol:** 10 paired trials, randomized variant order, seed recorded in the result. Values are median [Q1, Q3] using linear-interpolated quartiles.

## Speed

**Evidence layer: full Computer E2E.**

| Operation | Computer baseline | C3 |
| --- | ---: | ---: |
| Initial 32 MiB creation | 1618.5 ms [1609.3, 1630.8] | 2219.0 ms [2169.0, 2276.0] |
| 16 durable tiny edits | 5122.0 ms [5100.5, 5159.0] | 1608.5 ms [1569.5, 1615.5] |
| 10-byte front insertion | 1638.0 ms [1628.3, 1682.8] | 430.0 ms [424.3, 443.8] |
| Full read and sync bracket | 207.0 ms [202.3, 208.5] | 155.5 ms [154.0, 157.8] |

## Storage

**Evidence layer: full Computer E2E.**

| Metric | Computer baseline | C3 |
| --- | ---: | ---: |
| Tiny-edit blob growth | 8.00 MiB [8.00, 8.00] | 3.20 MiB [3.20, 3.20] |
| Front-insert blob growth | 32.00 MiB [32.00, 32.00] | 0.19 MiB [0.19, 0.19] |
| Final SQLite database | 72.32 MiB [72.32, 72.32] | 35.89 MiB [35.89, 35.89] |
