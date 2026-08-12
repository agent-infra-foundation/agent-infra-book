# Edit-scale result

One 16.0 MiB file; 1-byte overwrites. Timings separate private edits from publication.

## Speed

**Evidence layer: engine.**

| Edits | Naive edit | C3 edit | Publish N/C3 | Total speedup |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5.00 ms | 2.00 ms | 1.00 ms / 5.00 ms | 0.9x |
| 1,000 | 4.02 s | 274 ms | 1.00 ms / 124 ms | 10.1x |

## Space

**Evidence layer: engine.**

| Edits | SQL written N/C3 | Private COW pages N/C3 | Complete branch-exclusive N/C3 | Less written |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 512.0 KiB / 145.3 KiB | 0 B / 4.0 KiB | 514.5 KiB / 4.0 KiB | 71.6% |
| 1,000 | 497.5 MiB / 19.9 MiB | 0 B / 3.9 MiB | 16.0 MiB / 3.9 MiB | 96.0% |

> Fixture creation, initial seed, canonical-manifest verification, and final reads are outside the timed path.
