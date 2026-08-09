# Paired two-mount branch benchmark

**Benchmark layer:** full Computer E2E through the custom branch RPC adapter.

**Protocol:** 10 paired trials, randomized variant order, seed recorded in the result. Values are median [Q1, Q3] using linear-interpolated quartiles.

## Speed

**Evidence layer: full Computer E2E.**

| Phase | Fixed-chunk | C3 |
| --- | ---: | ---: |
| Push two branch views | 192.5 ms [192.0, 196.8] | 187.5 ms [184.0, 188.8] |
| Run two FUSE shell commands | 30.0 ms [29.3, 31.0] | 35.0 ms [34.0, 36.0] |
| Pull two execution deltas | 95.0 ms [89.8, 97.8] | 81.5 ms [79.3, 87.8] |
| Publish two branches | 1.0 ms [0.0, 1.0] | 6.0 ms [6.0, 6.0] |
| Complete branch round | 323.0 ms [317.3, 327.5] | 316.5 ms [310.3, 319.8] |

## Complete branch-exclusive storage

**Evidence layer: full Computer E2E.**

| Metric | Fixed-chunk | C3 |
| --- | ---: | ---: |
| Private COW-page payload | 0.0 KiB [0.0, 0.0] | 8.0 KiB [8.0, 8.0] |
| Complete branch-exclusive content | 1.00 MiB [1.00, 1.00] | 0.01 MiB [0.01, 0.01] |
| SQLite database growth | 1.01 MiB [1.01, 1.01] | 0.01 MiB [0.01, 0.01] |
