# Part I New — Architecture and Algorithm Evidence Audit

Audit date: 2026-08-07

Manuscript: [`PART-I-NEW.md`](./PART-I-NEW.md)

Computer implementation pin:
[`76d9e75c5688713b656bce85540d9e0071cece8b`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b)

## Evidence rules

| Label | Meaning |
| --- | --- |
| Platform fact | Supported by current official Cloudflare documentation. |
| Implementation fact | Traced to code at the pinned Computer commit. |
| Measured fact | Recalculated from the canonical raw benchmark result. |
| Analysis | A design conclusion that follows from facts but is not a platform guarantee. |
| Qualified | Correct only with the boundary stated in the manuscript. |

The local Computer checkout is at the pinned commit but has unrelated working-tree
changes. Code claims in this audit use pinned GitHub URLs or `git show <commit>:<path>`,
not mutable working-tree lines.

## Durable Objects

| Material claim | Verdict | Primary evidence |
| --- | --- | --- |
| A Durable Object combines a globally routable identity, one active state owner, and private attached storage. | Platform fact | [Overview](https://developers.cloudflare.com/durable-objects/), [glossary](https://developers.cloudflare.com/durable-objects/reference/glossary/) |
| `idFromName()` derives a stable ID and `get()` returns a routing stub; neither promises a permanent process. | Platform fact | [Namespace API](https://developers.cloudflare.com/durable-objects/api/namespace/), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| In-memory fields can disappear on eviction; persistent storage survives under the storage contract. | Platform fact | [Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| SQLite-backed storage is private, transactional, and strongly consistent. | Platform fact | [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| A method can return before write confirmation, while the Output Gate delays outgoing messages until pending writes complete. | Platform fact; corrected in manuscript | [Concurrency and Output Gates](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work) |
| Single-threaded execution does not make a whole async handler atomic; non-storage waits can permit interleaving. | Platform fact; added caveat | [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| “Zero latency” means same-thread embedded access without a database network hop, not literally zero query, durability, or request time. | Qualified platform claim | [SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/) |
| The legacy item is the KV-backed storage backend, not asynchronous KV methods themselves. | Platform fact; corrected terminology | [SQLite storage matrix](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| Partitioning by the “atom of coordination” is the scale-out model; one global hot object is a bottleneck. | Platform guidance plus analysis | [Rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/) |

## Computer VFS and storage algorithm

| Material claim | Verdict | Primary evidence |
| --- | --- | --- |
| In the documented DO deployment, `Workspace` wraps `ctx.storage`, so the authoritative VFS tables live in the Workspace DO SQLite database. | Implementation fact, deployment-qualified | [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts), [`with-workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/with-workspace.ts) |
| The VFS schema, 512 KiB windows, hashes, manifests, GC, sync, and FUSE are Computer application choices—not Durable Objects storage internals. | Implementation fact | [Filesystem schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md) |
| Chunk boundaries are a fixed 512 KiB offset grid, with a shorter final chunk. This is a maximum, not a minimum allocation. | Implementation fact | [`CHUNK_SIZE` and `chunksOf()`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts) |
| Exact chunk bytes use SHA-256 identities and deduplicate within one Workspace database, not across unrelated DO databases. | Implementation fact | [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts), [`stageBlob()`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/blobs.ts) |
| Sync-side blob staging trusts the supplied hash instead of recomputing it. The design is not end-to-end CAS integrity verification. | Implementation fact; caveat added | [`stageBlob()`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/blobs.ts) |
| `vfs_chunks` is the authoritative current ordered content mapping. `manifest_hash` is optional and can be null after range writes. | Implementation fact; corrected in manuscript | [Core schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/core.ts), [range-write path](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts) |
| A materialized whole-file write and a streaming write have different transaction boundaries. | Implementation fact; pseudocode corrected | [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts) |
| Revisions are global monotonic mutation markers used for current-state synchronization, not retained file versions or rollback roots. | Implementation fact | [`rev.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/rev.ts), [sync protocol](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md) |
| Internal GC removes unreferenced rows whose `last_seen` is older than a default one-hour safety window. No non-test scheduler or public `Workspace.gc()` exists at the pin. | Implementation fact | [`gc.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/gc.ts) |
| The one-hour value is an eligibility delay, not evidence that GC runs hourly. Row deletion also does not prove physical SQLite-file shrinkage. | Qualified implementation analysis | [`gc.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/gc.ts) |
| Computer has no shipped retained CAS checkpoint graph at the pin. Durable Object SQLite PITR is a separate whole-database recovery feature. | Implementation fact plus platform fact | [Computer schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md), [DO PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api) |

## FUSE, execution, and synchronization

| Material claim | Verdict | Primary evidence |
| --- | --- | --- |
| computerd uses a separate in-memory SQLite VFS; FUSE projects that execution copy, not the DO database. | Implementation fact | [`vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts), [sync protocol](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md) |
| The FUSE driver offers broad POSIX-style compatibility, not full POSIX conformance. | Implementation fact | [`driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.ts) |
| A FUSE write is locally visible through a dofs inode buffer. `fsync()` does not establish Workspace durability and does not force the normal buffer into chunk tables. | Implementation fact; corrected in manuscript | [`driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.ts), [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts) |
| The last open handle's `release()` commits the local chunks and revision. Successful pull/apply moves accepted changes into the Workspace DO authority. | Implementation fact | [`writeBuffer.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeBuffer.ts), [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts) |
| Pull is batched and is not one atomic transaction. Individual mutations can commit before a later batch fails. | Implementation fact; explicit failure caveat | [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts) |
| With a remote backend, pre-exec push is attempted. If it fails, Computer records zero pushed entries and still starts the command, potentially against stale state. | Implementation fact; corrected in manuscript | [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts) |
| Generic computerd execution uses `/bin/sh -c`, not necessarily Bash. | Implementation fact; corrected in manuscript | [`runner.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/exec/runner.ts) |
| Post-command pull is scheduled after the event stream is fully drained. `await run.result()` drains it and waits for the sync result; cancellation can bypass pull. | Implementation fact; qualified in manuscript | [`runtime.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/runtime/runtime.ts), [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts) |
| FUSE defaults use 512 KiB maximum reads/writes, `big_writes`, `auto_cache`, one-second metadata caches, and zero negative-cache timeout. | Implementation fact | [`options.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/options.ts) |

## Benchmark evidence

| Material claim | Verdict | Evidence |
| --- | --- | --- |
| The integration imports the official packages, constructs `Workspace` with DO storage, and calls `runtime.exec()`. | Verified implementation authenticity | [`computer-in-48-lines.ts`](../benchmarks/storage/local-pipeline/computer-in-48-lines.ts) |
| The benchmark uses real FUSE, local computerd, push/pull, and local workerd DO SQLite. | Verified | [`run-computerd.sh`](../benchmarks/storage/local-pipeline/run-computerd.sh), [`run-local-medium.ps1`](../benchmarks/storage/scripts/run-local-medium.ps1), [raw result](../benchmarks/storage/results/raw/local-medium-d64d142688d0.json) |
| Every published storage and speed number is derivable from the canonical raw JSON. | Measured fact | [Raw result](../benchmarks/storage/results/raw/local-medium-d64d142688d0.json), [summary generator](../benchmarks/storage/scripts/summarize-medium.mjs) |
| The canonical raw result SHA-256 is `6ca9f3546bffeb7bf166eb4831ebf1db42079901547b549dff78b79fc8ed52f2`. | Verified locally and recorded in generated summary | [`medium-summary.json`](../benchmarks/storage/results/medium-summary.json) |
| The `ls` time isolates kernel FUSE overhead. | Rejected | It measures the combined kernel FUSE, fuse-native, JavaScript driver, SQLite VFS, and shell path. |
| The 32 MiB prepend's pull span dominates its durable execution. | Measured fact, component-qualified | The span does not separately isolate transfer, hash probing, and SQLite apply. |
| Exact Wrangler/workerd versions for the retained run are known. | Unsupported for the retained run | The raw result records use of sibling runtime packages but not their versions. Future runner code uses benchmark-local versions and records them. |

## Corrections incorporated

- Corrected Output Gate and asynchronous interleaving semantics.
- Corrected legacy KV terminology.
- Made manifests optional and `vfs_chunks` authoritative.
- Split materialized and streaming write semantics.
- Removed the false local-durability guarantee from `fsync()`.
- Made per-mutation pull atomicity explicit.
- Corrected failed-push and `/bin/sh -c` behavior.
- Qualified benchmark causality and runtime provenance.
- Distinguished hypothetical Computer checkpoints from Durable Object SQLite PITR.
- Made the canonical raw benchmark artifact trackable and hash-addressed.

