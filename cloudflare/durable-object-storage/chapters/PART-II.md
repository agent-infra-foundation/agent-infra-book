# Part II — Engineering the Durable Computer

> Status: manuscript shell. Pin Cloudflare Computer to a reviewed commit before
> drafting implementation claims.

Part II reads Cloudflare Computer's implementation in depth. Part I has already
established the architecture; this part follows its construction, mutation,
synchronization, storage behavior, and failure boundaries.

## Chapter 6 — Constructing `Workspace` from Source

Pin and map the repository. Follow `withWorkspace`, schema initialization,
`WorkspaceFilesystem`, runtime registration, and Workers RPC from a Durable
Object storage handle to the public Workspace API.

## Chapter 7 — Filesystem Operations and Atomic Writes

Trace path resolution, inodes, directory entries, reads, full and streaming
writes, range-aware edits, rename, and unlink. Identify transaction boundaries
and operations that can leave staged content after failure.

## Chapter 8 — Synchronization, Conflicts, and Recovery

Follow revisions, fetch cursors, watermarks, missing-object transfer, push,
exec, pull, interrupted transfers, re-baselining, and concurrent-backend
conflicts. Compare production FUSE behavior with the local shim.

## Chapter 9 — Edits, Garbage Collection, and Checkpoints

Measure full and positional writes separately. Account for live references,
deduplicated payloads, orphaned blobs, and the internal GC safety window.
Distinguish current manifests and revisions from retained history, then compare
PITR, Git, snapshots, CAS plus CDC, and an explicitly proposed checkpoint layer.

## Chapter 10 — Performance and Failure Testing

Separate raw SQL, VFS, RPC, synchronization, FUSE or shim, and command costs.
Test metadata-heavy and sequential workloads, failed streams, interrupted sync,
eviction, and container loss. Close with an evidence-backed matrix of shipped,
preview, planned, and proposed behavior.

The first companion experiment isolates raw Durable Object SQLite and the
public Computer `Workspace.fs` layer, deliberately excluding containers and
network paths. Its [source-pinned harness](../benchmarks/storage/) and [full
local result](../benchmarks/storage/results/summary.md) establish the storage,
deduplication, edit-amplification, and direct-API baseline that this chapter
will later extend with synchronization and failure injection.
