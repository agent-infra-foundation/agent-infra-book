# Native filesystem vs Cloudflare Computer: medium benchmark

- Generated: 2026-08-06T18:10:04.1472009+00:00
- Computer commit: `76d9e75c5688713b656bce85540d9e0071cece8b`
- Raw result SHA-256: `6ca9f3546bffeb7bf166eb4831ebf1db42079901547b549dff78b79fc8ed52f2`
- Corpus: 6,385 files, 274.781 MiB
- Mount backend: real FUSE; cache policy: warm local caches; no page-cache eviction
- Execution policy: one deterministic run per scenario
- Bulk sync: ordinary create/duplicate classes use at most 40 hashes per bracket; the single 32 MiB boundary-file bracket references 64

## Speed

Verification is shown separately and is not included in Computer durable-exec time.

| Operation | Native command ms | Computer FUSE command ms | Computer durable exec ms | FUSE/native | Durable/native |
| --- | ---: | ---: | ---: | ---: | ---: |
| Create 6,385 files / 274.8 MiB | 633.176 | 21049.831 | 62217.000 | 33.24x | 98.26x |
| Recursive ls -lR | 921.322 | 14360.184 | 14491.000 | 15.59x | 15.73x |
| Read all file content | 197.986 | 7041.529 | 7069.000 | 35.57x | 35.70x |
| Duplicate tree | 517.886 | 34092.175 | 53322.000 | 65.83x | 102.96x |
| Overwrite 10 bytes once | 8.511 | 14.702 | 167.000 | 1.73x | 19.62x |
| Overwrite 10 bytes five times / five execution brackets | 38.619 | 73.157 | 473.000 | 1.89x | 12.25x |
| Overwrite 10 bytes five times / one execution bracket | 23.390 | 53.617 | 126.000 | 2.29x | 5.39x |
| Append 10 bytes | 3.618 | 8.014 | 56.000 | 2.21x | 15.48x |
| Prepend 10 bytes to 32 MiB | 51.126 | 204.673 | 1596.000 | 4.00x | 31.22x |
| Delete duplicate tree | 96.909 | 3416.710 | 5862.000 | 35.26x | 60.49x |
| Delete remaining tree | 94.903 | 3455.391 | 7503.000 | 36.41x | 79.06x |

## Space

`Computer DB` is `DurableObjectStorage.sql.databaseSize`. `Workerd persisted` is the total logical size of the isolated local workerd persistence directory.

| State | Files | Logical MiB | Native allocated MiB | Computer DB MiB | Unique blob MiB | Orphan MiB | Workerd persisted MiB | DB/logical | Logical/unique |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial unique tree | 6385 | 274.781 | 274.781 | 282.023 | 274.781 | 0.000 | 285.530 | 1.03x | 1.00x |
| Exact duplicate tree | 12770 | 549.563 | 549.563 | 283.750 | 274.781 | 0.000 | 288.206 | 0.52x | 2.00x |
| One 10-byte overwrite | 12770 | 549.563 | 549.563 | 284.250 | 275.281 | 0.000 | 288.206 | 0.52x | 2.00x |
| After five edits in separate execution brackets | 12770 | 549.563 | 549.563 | 286.758 | 277.781 | 2.000 | 289.268 | 0.52x | 1.98x |
| After five edits in one execution bracket | 12770 | 549.563 | 549.563 | 287.258 | 278.281 | 2.000 | 289.268 | 0.52x | 1.98x |
| After 10-byte append | 12770 | 549.563 | 549.566 | 287.262 | 278.281 | 2.000 | 289.268 | 0.52x | 1.98x |
| After 10-byte prepend | 12770 | 549.563 | 549.570 | 319.309 | 310.281 | 2.000 | 320.815 | 0.58x | 1.77x |
| After deleting duplicate | 6385 | 274.781 | 274.789 | 319.582 | 310.281 | 35.500 | 324.972 | 1.16x | 0.89x |
| After deleting all files | 0 | 0.000 | 0.000 | 318.785 | 310.281 | 310.281 | 325.015 | - | - |

## Fixed-chunk edit amplification

| Operation | User bytes written | New unique blob bytes | New unique blob MiB | Payload amplification |
| --- | ---: | ---: | ---: | ---: |
| One 10-byte overwrite | 10 | 524288 | 0.500 | 52428.8x |
| Five 10-byte overwrites / five execution brackets | 50 | 2621440 | 2.500 | 52428.8x |
| Five 10-byte overwrites / one execution bracket | 50 | 524288 | 0.500 | 10485.8x |
| Append 10 bytes to aligned 1 MiB file | 10 | 10 | 0.000 | 1.0x |
| Prepend 10 bytes to 32 MiB file | 10 | 33554442 | 32.000 | 3355444.2x |

## Interpretation boundary

These are local WSL2/workerd results. They exercise the pinned Computer implementation and a real FUSE mount, but not Cloudflare's production Container lifecycle, placement, network, or billing environment. Small files are stored at their actual length; 512 KiB is a maximum fixed chunk size, not a minimum allocation unit.

