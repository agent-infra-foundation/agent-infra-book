# Multi-agent branch benchmark

50 logically concurrent agent requests through one local workerd Durable Object; each file is 256 KiB.

## Disjoint-file branches

**Evidence layer: Durable Object request.**

| Metric | Naive | C3 | Result |
| --- | ---: | ---: | --- |
| Private COW-page payload | 0 KiB | 200 KiB | C3 page overlay; fixed chunks use no COW pages |
| Complete branch-exclusive content | 12803.9 KiB | 200 KiB | **98.4% less** |
| SQLite growth with branches active | 12880 KiB | 232 KiB | **98.2% less** |
| Edit requests | 253.0 ms | 138.0 ms | 50 branches |
| Publish requests | 139.0 ms | 259.0 ms | 50 publications |
| Correct final files | 50/50 | 50/50 | All disjoint edits survive |

## Same-file contention

**Evidence layer: Durable Object request.**

| Metric | Naive | C3 | Result |
| --- | ---: | ---: | --- |
| Publications reported merged | 50 | 1 | C3 accepts one winner |
| Explicit conflicts | 0 | 49 | C3 rejects stale branches |
| Silent lost updates | 49 | 0 | **C3: zero** |
| Private COW-page payload | 0 KiB | 200 KiB | C3 page overlay; fixed chunks use no COW pages |
| Complete branch-exclusive content | 12547.8 KiB | 200 KiB | **98.4% less** |
| SQLite growth with branches active | 12588 KiB | 232 KiB | **98.2% less** |

> This profile isolates the branch engine through separate Durable Object requests. The complementary E2E profile validates two branch identities through two independent Computer/FUSE mounts.
