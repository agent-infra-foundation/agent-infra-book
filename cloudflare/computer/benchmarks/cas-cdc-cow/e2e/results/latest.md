# Computer full-pipeline result (volume)

**Path:** `Workspace DO SQLite -> push -> computerd -> FUSE -> command -> pull -> Workspace DO SQLite -> verify`

**Workload:** 32.00 MiB file, 16 durable tiny-edit checkpoints, then a 10-byte front insertion.

## Speed

**Evidence layer: full Computer E2E.**

| Operation | Computer baseline | C3 | Result |
| --- | ---: | ---: | ---: |
| Create | 1632.0 ms | 2169.0 ms | 0.75× |
| 16 checkpoint edits | 5405.0 ms | 1611.0 ms | **3.36×** |
| Front insertion | 1696.0 ms | 428.0 ms | **3.96×** |
| Full read + sync bracket | 207.0 ms | 151.0 ms | 1.37× |

## Storage growth before GC

**Evidence layer: full Computer E2E.**

| Workload | Computer baseline | C3 | Reduction |
| --- | ---: | ---: | ---: |
| Tiny-edit blob growth | 8.00 MiB | 3.20 MiB | **60.0%** |
| Front-insert blob growth | 32.00 MiB | 0.19 MiB | **99.4%** |
| Final SQLite database | 72.32 MiB | 35.89 MiB | **50.4%** |

The comparison uses the same pinned Computer commit, Worker, RPC protocol, FUSE daemon, commands, and verification. The candidate patch is installed on both the authoritative Workspace and ephemeral computerd VFS.
