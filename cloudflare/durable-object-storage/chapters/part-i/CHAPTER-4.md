# Chapter 4 — From Durable Object to `/workspace`

An agent has just finished the first pass on a small TypeScript service. Through the Workspace API it created `/workspace/project-42/src/index.ts`, wrote a test, and left a short plan in `/workspace/project-42/NOTES.md`. The next step needs a native compiler, so the orchestrator starts a container and runs:

```text
cd /workspace/project-42 && npm test
```

The files are there. The compiler rewrites a generated file, the test process creates a coverage report, and those outputs are visible through the Workspace API after the command completes. It is tempting to describe this as “the Durable Object filesystem is mounted into the container.” That sentence is convenient, and wrong in exactly the way that matters when a command races with another writer, a container restarts, or a sync cursor advances after a partial transfer.

The Durable Object’s SQLite database is not a network block device. FUSE does not issue SQL against it. The container does not hold an open file descriptor into Cloudflare’s storage layer. Instead, Computer maintains an authoritative virtual filesystem in the Durable Object and, for a container backend, constructs a second virtual filesystem inside `computerd`. Synchronization converges the two current states. FUSE exposes the second one at `/workspace`.

That distinction is the organizing invariant for this chapter:

> **The authoritative Computer filesystem lives in Durable Object SQLite. An execution backend either reaches that filesystem directly or works against a synchronized representation.**

This chapter follows `project-42` from the authoritative rows to a container process and back. The source baseline is Cloudflare Computer commit [`76d9e75c5688713b656bce85540d9e0071cece8b`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b), inspected on 2026-08-06. That pin matters because the repository documentation describes both shipped behavior and intended behavior. Where they differ, the pinned implementation and tests are the evidence for what exists.

## The platform boundary

Durable Objects supply the substrate: a globally addressable object identity, colocated execution, private storage, transactions, and recovery across object restarts. Cloudflare describes each object as having its own strongly consistent storage, accessible only within that object, while its in-memory state may disappear when the object goes idle. Those properties make a Durable Object a natural authority for a workspace, but they do not themselves define files, directories, chunks, manifests, or FUSE mounts. Those are application choices made by Computer. See Cloudflare’s [Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

The boundary is easiest to state as two columns:

| Durable Objects platform provides | Computer application defines |
| --- | --- |
| Object identity and request execution | The `Workspace` abstraction |
| One object’s private SQLite storage | The `vfs_*` relational schema |
| SQL execution and transactional storage | Files, directories, links, chunks, and manifests |
| Durable recovery of committed storage | Revision and synchronization protocols |
| Runtime lifecycle | Runtime adapters, FUSE, and the `/workspace` convention |

Consequently, “the VFS lives in Durable Object SQLite” has a precise and intentionally modest meaning: Computer stores its filesystem rows and byte BLOBs by executing SQL through `ctx.storage.sql`. It does **not** mean that Durable Objects have a hidden proprietary filesystem format, that SQLite pages are mounted into a container, or that Cloudflare’s platform knows what a `vfs_node` represents.

The construction path in the pinned code makes the ownership boundary unusually clear. An application passes the Durable Object storage handle to `new Workspace({ storage: ctx.storage, ... })`. The `Workspace` constructor wraps that handle in Computer’s `Database`, initializes Computer’s schema, and builds a `WorkspaceFilesystem` over the database. `Database` itself exposes the supplied storage’s `.sql` interface. In other words, the chain is:

```text
Durable Object ctx.storage
        │
        ▼
new Workspace({ storage: ctx.storage })
        │
        ├── new Database(storage) ──► storage.sql
        ├── initializeSchema(database)
        └── new WorkspaceFilesystem(database)
```

The three constructor operations are adjacent in [`packages/computer/src/workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L298-L300), while the storage adapter assigns the SQL surface in [`packages/dofs/src/storage.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/storage.ts#L9-L25). There is no intervening filesystem service. A call such as `workspace.fs.writeFile(...)` reaches the provider backed by that database.

This also fixes the scope of “a Workspace.” In the common mapping used throughout this book, one logical project—our `project-42`—is owned by one Workspace inside one Durable Object identity. The Durable Object is the durable coordination boundary. Different Durable Objects have private databases; Computer does not use a shared cross-object blob table. That fact will become important when we discuss deduplication.

## A filesystem expressed as relations

The authoritative filesystem is not stored as one serialized tree. Computer decomposes it into metadata, namespace edges, content-addressed objects, and sync bookkeeping. The core and sync schemas are created by the statements in [`schema/core.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/core.ts#L20-L79) and [`schema/sync.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/sync.ts#L6-L58). The names start with `vfs_` because they belong to Computer’s virtual filesystem, not because Durable Objects reserve that prefix.

Here is the conceptual job of each major table at the pinned commit.

| Table | Conceptual role |
| --- | --- |
| `vfs_meta` | Singleton filesystem metadata: the schema version and the next/current logical revision counter used to order mutations. |
| `vfs_nodes` | One row per inode-like object. It records type, mode, modification time, revision, size, symlink target where applicable, mount metadata, and the current file manifest hash. |
| `vfs_dirents` | Directory edges: a parent inode plus a name points to a child inode. This separates names from nodes and permits inode-oriented operations such as links. |
| `vfs_blobs` | The content-addressed object catalogue. A SHA-256 hash identifies a payload and the row records its size and last-seen time. |
| `vfs_blob_bytes` | The actual bytes for an object hash, stored as a SQLite BLOB. Separating catalogue metadata from bytes lets object presence be probed without reading every payload. |
| `vfs_chunks` | The ordered chunk map for each file inode. Chunk index zero, one, two, and so on point at hashes and sizes in the blob store. |
| `vfs_manifests` | Content-addressed encodings of complete current chunk lists. A manifest says which chunk hashes, in which order and sizes, constitute current file content. |
| `vfs_changes` | Explicit change-log records needed for facts that cannot be reconstructed from live rows alone, especially tombstones for deletions. Live files are otherwise materialized from current namespace state. |
| `_vfs_watermark` | Per synchronization peer/backend progress for what local changes have been acknowledged as pushed. |
| `_vfs_fetch_cursor` | Per synchronization peer/backend `(revision, path)` progress for changes fetched from the other side. |
| `_vfs_mounts` | Shipped mount-index bookkeeping: mount root, kind, whether it has been indexed, and read-only/read-write mode. At this pin it supports the narrow eager mount implementation; it is not the richer lazy mount system described as a target in some design documents. |

Several design consequences fall out of this decomposition.

First, a pathname is not the primary identity of a file. Resolving `/workspace/project-42/src/index.ts` means walking `vfs_dirents` from the root to node rows. Renaming a directory edge need not duplicate its child’s content. Hard links can give more than one path to a node, although synchronization still emits a current-state entry for each path that must exist at the destination. Tests explicitly cover that per-path behavior in [`coalesce.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/coalesce.test.ts).

Second, file metadata and file bytes have different identities. A `vfs_nodes` row identifies the file object in the namespace; a manifest hash identifies its current ordered content description; chunk hashes identify reusable byte payloads. An update can therefore alter one chunk and one manifest without retransmitting every unchanged chunk.

Third, revisions are ordering coordinates, not retained file versions. A mutating operation advances the logical revision and stamps affected state. Synchronization uses a cursor containing a revision and path so that multiple entries at the same revision can be resumed deterministically. But the inode has only one `manifest_hash`: the current one. The schema does not preserve a chain of prior manifests per path, and current-state coalescing deliberately collapses repeated writes. The tests show five rewrites becoming one outgoing current entry, not five historical states, in [`coalesce.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/coalesce.test.ts#L119-L170).

That is why “revision” must not be silently upgraded to “version.” If an agent writes `A`, then `B`, then `C` before a peer fetches, the protocol’s purpose is to make the peer converge on `C`. It is not a time-travel API for retrieving `A` or `B`. Old content objects may remain physically present until garbage collection, but orphaned bytes are an implementation residue, not a supported history model. The manifest tests demonstrate both sides: identical current content reuses one manifest, while overwriting can leave the old manifest orphaned until cleanup ([`manifests.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/manifests.test.ts)).

The two cursor tables solve different directions of the same convergence problem. A push watermark answers, “How far through **my** current changes has this backend accepted?” A fetch cursor answers, “How far through **its** snapshot have I applied?” Both are keyed by backend in the shipped schema because one Workspace may interact with more than one runtime handle over time. The path component is not cosmetic: it provides a stable continuation when several paths share a revision. The protocol can restart from a precise boundary without treating a revision as if it named exactly one file.

### The mount table is real, but the larger mount design is not yet real

The repository’s design documents illustrate a broader mount subsystem: lazy stubs, remote providers, write-back modes, and other policies. At the pinned commit, the code ships a smaller slice. `WorkspaceOptions` accepts mounts, a mount registry is built, mounted trees can be eagerly indexed, and `_vfs_mounts` records the index and mode. An R2-backed provider and write guards exist. The shipped code does not implement every lazy or write-back behavior in the target documents; the implementation itself even rejects non-eager strategies. Compare the target language in [`docs/06_mount_interface.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/06_mount_interface.md) with the checks in [`packages/computer/src/mounts/index.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/mounts/index.ts) and schema in [`schema/sync.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/sync.ts#L52-L58).

For this chapter, `_vfs_mounts` belongs in the table tour because it is shipped. The aspirational remote-mount architecture does not belong in the execution trace because `project-42` does not depend on it.

## From a byte stream to content-addressed objects

Suppose the agent writes a file of 1,048,676 bytes: two full 512 KiB regions plus 100 bytes. Computer divides the resulting byte sequence at fixed offsets:

```text
chunk 0: bytes       0 ..   524,287   (524,288 bytes)
chunk 1: bytes 524,288 .. 1,048,575   (524,288 bytes)
chunk 2: bytes 1,048,576 .. 1,048,675 (100 bytes)
```

Each chunk is at most 512 KiB. Computer computes a SHA-256 digest for the chunk bytes, stores the digest as the object identifier, and inserts the payload only if that hash is not already present. The constant, digest construction, and fixed-window loop are visible in [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L23-L112); hash-keyed insertion uses conflict handling to reuse an existing payload in [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L307-L318). Tests pin the boundary by writing a file just over one chunk and asserting one 512 KiB chunk plus the remainder ([`writeFile.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.test.ts)).

“Content-addressed” means that identity follows bytes. Two all-zero chunks of the same length hash to the same identifier. If two files in `project-42` contain the same chunk, their `vfs_chunks` rows can point to one `vfs_blob_bytes` payload. If an edit leaves chunks zero and two unchanged but replaces chunk one, only the replacement payload is new; the next manifest reuses the other two hashes.

This is deduplication, but its scope needs a boundary. The blob tables are inside one Workspace’s database. Thus the useful claim is **per-Workspace deduplication**, or equivalently deduplication within that Durable Object database. There is no cross-Durable-Object object service in this design. If `project-42` and an unrelated `project-99` are owned by different Durable Objects, identical chunks are stored independently. A document that calls the feature “global dedup” can only safely mean “all paths in this VFS consult the same local content-addressed table,” not “one global payload across Cloudflare.” Cloudflare’s storage isolation—each object’s attached storage is private to that object—reinforces this boundary ([Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)).

Nor does deduplication collapse namespace entries. If `/a.txt` and `/b.txt` contain identical bytes, both paths still need nodes and directory entries, and synchronization needs an entry for each path. What they share is the payload object and, for identical full content, potentially the manifest. This corrects another loose shorthand in the repository: “exactly one entry” is true of a hashed object in a content store, not of the two path entries that make two files visible.

### Manifests describe current content

A manifest is a compact, canonical description of a file’s ordered chunks. Conceptually, the file above has a manifest like:

```text
[(hash-0, 524288), (hash-1, 524288), (hash-2, 100)]
```

The actual encoding is canonical JSON, and the manifest itself is hashed. Whole-file, streaming, and some range-aware paths write that current manifest hash into the file’s node row; buffered file-descriptor paths may leave `manifest_hash` null while the ordered `vfs_chunks` rows remain authoritative. The shipped wire does not send a manifest object or manifest hash: a file `ChangeEntry` carries the ordered chunk hashes and sizes directly. On apply, Computer can compute the corresponding manifest identity for equality checks and can stamp a local manifest. The implementation of canonical encoding and SHA-256 manifest identity is in [`manifests.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/manifests.ts); the actual wire shape is in [`changes.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/changes.ts), with encoding and reuse assertions in [`manifests.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/manifests.test.ts).

The manifest is not a commit object. It has no parent pointer, author, branch, or retention promise. When populated, `vfs_nodes.manifest_hash` points only to the current content description; a manifest-producing write replaces that pointer, while a buffered path may clear it and leave current `vfs_chunks` as the content map. If an old manifest remains, garbage collection may eventually reclaim it once it is unreachable; callers must not use accidental retention as file history. Git can of course be used *inside* a Workspace, but Git history and VFS revision bookkeeping are different layers.

### Fixed chunks, not content-defined chunks

Computer’s shipped algorithm uses fixed boundaries at multiples of 512 KiB. It is not content-defined chunking (CDC). With CDC, a rolling fingerprint chooses boundaries based on local content, so inserting bytes near the beginning often leaves later chunk identities aligned. With fixed chunks, inserting one byte at offset zero shifts every later 512 KiB window. A large suffix that is byte-for-byte the same at a different offset may hash as a different set of chunks.

Fixed chunking is straightforward to implement, reason about, and address for positional I/O. It also gives a hard upper bound on each payload. Its trade-off is poorer deduplication for insertions that shift subsequent boundaries. The docs discuss CDC as a possible future optimization, not current behavior; the pinned write path explicitly “re-windows into fixed `CHUNK_SIZE` pieces” ([`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L127-L204)). Calling this merely “chunked” hides a material performance property, so the fixed-versus-CDC distinction should remain explicit.

Fixed boundaries do not imply that every API write buffers the entire input. The implementation supports complete byte writes, streamed writes that are re-windowed as data arrives, and positional/range updates that rebuild affected fixed chunks while retaining unaffected chunk rows. A positional edit near the middle therefore need not manufacture a full-file payload object or retransmit untouched chunks. The test suite asserts that a one-range modification stages only the changed chunk in the relevant case ([`writeFile.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.test.ts)).

At the tool layer, however, “edit” has a simpler semantic shape: it reads the existing file, applies replacements, and writes the complete resulting content. That is an AI-edit behavior, not a limitation of the underlying VFS. The distinction matters when estimating memory and transfer costs: the storage layer can perform streaming and positional operations, while a higher-level tool may choose a full-result write for correctness and simplicity. The tool path is visible in [`packages/computer/src/tools/fs/edit.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/tools/fs/edit.ts).

## Two stores, one authoritative state

We can now draw the architecture that turns those rows into `/workspace`. The most important feature of the diagram is not FUSE. It is the pair of databases.

```text
               Cloudflare Worker / Durable Object
  ┌──────────────────────────────────────────────────────────────┐
  │  Workspace API                                               │
  │      │                                                       │
  │      ▼                                                       │
  │  WorkspaceFilesystem                                        │
  │      │                                                       │
  │      ▼                                                       │
  │  ctx.storage.sql                                             │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │ AUTHORITATIVE VFS: nodes, dirents, chunks, manifests, │  │
  │  │ bytes, revisions, changes, and per-backend cursors    │  │
  │  └────────────────────────────────────────────────────────┘  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ capnweb sync RPC
                              │ entries + cursors + hashes;
                              │ missing payloads only
                              ▼
                 Container process: computerd
  ┌──────────────────────────────────────────────────────────────┐
  │  node:sqlite DatabaseSync(":memory:")                         │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │ PROCESS-LIFETIME VFS: same Computer schema/provider,  │  │
  │  │ independently stored local current state              │  │
  │  └───────────────────────────┬────────────────────────────┘  │
  │                              │ FUSE callbacks                 │
  │                              ▼                                │
  │                       /workspace                              │
  │                              │ POSIX-style file operations    │
  │                              ▼                                │
  │                    compiler, shell, native tools              │
  └──────────────────────────────────────────────────────────────┘

  Direct runtimes take a different route:

  just-bash Dynamic Worker ── Workers RPC ──► Workspace.fs ──► authority
  isolate JavaScript ── host filesystem capability ──────────► authority
```

**Figure 1.4 — Container execution uses a synchronized, process-lifetime VFS; Worker shell and isolate JavaScript use the authoritative Workspace directly.**

The lower database is easy to miss because it reuses the same filesystem abstractions. At the pinned commit, `computerd` calls `createNodeVirtualFileSystem()`. That function constructs `SQLiteTestStorage`, wraps it in the same `Database` adapter, runs the same schema initializer, and creates the same provider-facing virtual filesystem. Despite the testing-oriented class name, this is the shipped computerd path. `SQLiteTestStorage` creates Node’s `DatabaseSync(":memory:")`, so the container-side database is in memory and lasts only as long as that `computerd` process ([`fuse/vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L83-L119), [`testing.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/testing.ts#L14-L56)).

This is current implementation, not an architectural requirement that the replica must always be volatile. A future computerd could persist its local database and still fit the two-store design. At this source pin, however, claims about restart behavior must follow `:memory:`: when the process dies, its local VFS, local revisions, and local object cache die with it. The next process rebuilds current state from the Durable Object through synchronization.

The phrase “same filesystem” appears frequently in examples and docs. It is useful only if read as **the same logical namespace after synchronization**. The two sides use the same schema and provider semantics, and they converge on the same paths and bytes. They are not the same SQLite connection, the same transaction domain, or continuously coherent shared memory. A mutation can exist on one side before its next sync boundary. There is no cross-store transaction that commits a Durable Object row and a container row atomically.

The sync channel is carried over the repository’s RPC layer, with capnweb providing the transport-facing capability machinery. Entries describe current files, directories, symlinks, or deletions. File entries name chunk hashes and sizes but do not inline all bytes. Object-probe calls determine which hashes already exist at the receiver, and object-transfer calls carry only missing payloads. The sync interface is defined in [`packages/rpc/src/interface.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/interface.ts), while the server’s snapshot-bounded fetch and object-presence methods are implemented in [`packages/rpc/src/server.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/server.ts#L166-L213).

The wire therefore moves four kinds of knowledge:

1. **Current-state entries:** which path should now be a file, directory, symlink, or deletion, with relevant metadata.
2. **Cursors:** how far each side has cleanly processed a snapshot or acknowledged a push.
3. **Ordered chunk references and hashes:** compact identities for the content a file requires. Manifests remain local content descriptions rather than a separate wire payload at this pin.
4. **Missing payloads:** only the content-addressed objects the destination does not already hold.

That is much closer to incremental state replication than to a remote filesystem protocol. A container process does not block each `read(2)` on a Durable Object round trip. It reads the local VFS. Conversely, an API caller does not wait for the container to service a FUSE callback. It reads the authority.

## What FUSE actually exposes

FUSE—Filesystem in Userspace—lets a userspace program implement filesystem operations that the kernel presents to ordinary processes. With real FUSE active, a tool in the container can call `open`, `read`, `write`, `rename`, `stat`, or `readdir` on `/workspace`. The kernel routes those requests to computerd’s FUSE operations. The mount function is given a `NodeVirtualFileSystem`; its callbacks translate the mount-relative path and invoke that local provider. Tests build the operations over a VFS, write through the mounted surface, and then observe the result in that backing VFS; they also verify mount-point path translation ([`fuse/driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.ts#L959-L1022), [`fuse/driver.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.test.ts)).

The route for a read is thus:

```text
process read("/workspace/project-42/NOTES.md")
  → kernel VFS
  → FUSE callback in computerd
  → computerd's local provider
  → computerd's in-memory SQLite VFS
```

There is no `ctx.storage.sql` arrow in that operation. The Durable Object participated earlier, when sync populated the local copy. This is why FUSE can support familiar native tooling without turning every syscall into a wide-area RPC, and also why an unsynchronized API write is not instantly visible to a process that has already begun executing.

### Real FUSE, automatic selection, and the shim

The single `FUSE_MOUNT` setting selects the exposure backend. In `auto`, the default, computerd probes the environment: on Linux it checks whether `/dev/fuse` is accessible; on macOS it checks for macFUSE. When a real backend is available, computerd mounts through it. An explicit `fuse` or `macfuse` setting is stricter and fails when its required platform support is absent. `none` skips filesystem exposure. The selection logic and its failure messages live in [`fuse/backend.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/backend.ts#L1-L82), with real/automatic/fallback cases covered in [`backend.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/backend.test.ts).

If real FUSE is unavailable under `auto`, computerd falls back to a userspace shim. The shim mirrors between the local VFS and an ordinary host directory, watches VFS changes, polls/reconciles disk changes, and offers explicit flush/reconcile hooks around requests. It exists so development and restricted environments can still present files to native processes. The implementation labels itself non-production-grade because two independent writers and polling introduce races that kernel-mediated FUSE does not have ([`shim.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/shim/shim.ts#L1-L18)).

Under the shim, there is effectively one more materialization:

```text
Durable Object authority ⇄ computerd SQLite VFS ⇄ ordinary disk directory
                                                     ▲
                                                     └── native process
```

The logical contract remains “the process works under `/workspace` and sync carries accepted current state,” but the mechanism is weaker. Visibility depends on reconciliation boundaries rather than synchronous FUSE callbacks. The shim deliberately takes a last-writer relaxation when disk and VFS writes overlap. A passing local-shim test therefore does not establish the exact syscall semantics or race behavior of a real FUSE deployment. Treat it as a compatibility path, not a transparent reimplementation of the kernel mount.

### `/workspace` is a convention with a boundary

`computerd` defaults its mount point to `/workspace`, creates that location in its local VFS, and exposes it through the selected backend ([`computerd.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/cli/computerd.ts#L41-L53), [`computerd.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/cli/computerd.ts#L458-L492)). The name is an execution convention, not a statement that the container’s host root has been imported into the Durable Object. In the VFS itself, `/` is the namespace root; `/workspace` is the path chosen for container work. Computer does not automatically turn arbitrary image contents into Workspace files.

This boundary answers a common debugging question: what happens to paths outside `/workspace`? They are container-local. A process may write `/tmp/cache.bin`, `/var/log/tool.log`, or files elsewhere in its image filesystem. Unless an application explicitly copies them under the synchronized mount or returns them as another artifact, they do not become rows in the authoritative VFS. They disappear according to the container’s own lifecycle, not the Durable Object’s. The inverse is also true: only the configured mounted subtree is made visible to the native process through this mechanism.

For `project-42`, a robust command therefore makes its workspace dependency explicit:

```text
cd /workspace/project-42 && npm test
```

It should not assume that the process starts in the project directory, that `/root/project-42` is synchronized, or that an installer’s cache under `/tmp` will be durable.

## The complete file trace

Now follow one file all the way through the system. Assume an API-facing Worker has obtained the Workspace for `project-42`, the authoritative tree already contains `/workspace/project-42`, and a container backend is available. The agent writes `src/index.ts`, runs a formatter in the container, and then reads the formatted result through the Workspace API.

1. **The API write lands in the authoritative Workspace.** The caller invokes `workspace.fs.writeFile("/workspace/project-42/src/index.ts", bytes)`. Path resolution, inode/chunk updates, and byte staging execute against the `Database` that wraps the Durable Object’s `ctx.storage.sql`. No container is needed for this step. The `Workspace.fs` surface is constructed directly over that database, as shown in [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L298-L300).

2. **The mutation acquires a revision and content identities.** Computer windows the result into fixed chunks of at most 512 KiB, hashes them with SHA-256, reuses already-present objects, writes the current ordered chunk rows, builds a content-addressed manifest, and updates the node’s current `manifest_hash`, size, metadata, and logical revision. The live namespace is now authoritative. When sync coalesces changes, this path is eligible to become a current-state file entry carrying metadata and chunk references. Repeated pre-sync rewrites may collapse into that one current entry; they do not require a historical event per write.

3. **Before container execution, the Durable Object pushes changes the backend has not acknowledged.** The shell executor calls the Workspace sync hook before invoking remote `exec`. `Workspace.push()` serializes per-backend mutation work and asks the sync driver to send entries after that backend’s watermark. The pre-exec push is visible in [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L108-L126); the Workspace routes it to `pushOnce` in [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L545-L567).

4. **Sender and receiver negotiate objects by hash.** File entries identify the required chunk hashes and sizes. The push driver calls the receiver’s object-presence probe, computes which hashes are missing, and streams only those bytes before sending the current-state entries. Existing objects are not resent merely because another path references them. The push sequence—coalesce, `hasObjects`, `pushObjects`, then `push`—is implemented in [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L290-L348).

5. **Computerd applies the entry to its local SQLite VFS.** The RPC server on the container side accepts the objects and applies file/directory/delete entries through the same database/provider model, but its `Database` wraps `DatabaseSync(":memory:")`, not the Durable Object’s storage. The local node now points to a local manifest and local chunk objects containing the required bytes. The received push is transactionally applied on that server before it reports its accepted cursor ([`server.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/server.ts)).

6. **The process reads `/workspace` through FUSE.** Once the push completes, computerd starts the requested command. `open("/workspace/project-42/src/index.ts")` and subsequent reads pass through the kernel’s FUSE route into computerd’s local provider. They do not query the Durable Object. The bytes are already present in the process-lifetime local VFS.

7. **The formatter’s write creates a local revision.** The formatter may open the file, perform positional writes, truncate, rename a temporary file over the original, or use another ordinary filesystem sequence. FUSE callbacks translate those operations to the local VFS. When the operation is committed through that provider—potentially at flush/release depending on the syscall pattern—the local database gets new chunk hashes, an updated ordered chunk map, and a new local revision. A buffered descriptor write may temporarily leave the optional node `manifest_hash` null; synchronization can still materialize the file from `vfs_chunks`. At this moment the container sees the result, but the authoritative Workspace may still hold the pre-format content.

8. **After the command’s output stream drains, the Durable Object fetches container changes in bounded batches.** Computer deliberately attaches the post-exec pull to event-stream completion. This prevents the orchestration layer from declaring the filesystem synchronized while stdout/stderr events or process cleanup are still in flight. `withPostPull` runs after the stream reaches its end ([`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L145-L162), [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L187-L247)). The pull driver reads at most 256 entries per batch so working memory is bounded ([`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L47-L64)).

9. **Accepted current state lands durably, then the fetch cursor advances.** The Durable Object side receives a snapshot-bounded stream of entries, probes both stores for required hashes, fetches missing payloads, and applies the entries through transactional VFS mutations. After clean processing it records the container fetch cursor. The exact implementation is careful but not magical: on the pull path, individual filesystem applies use transactions and the driver advances its cursor after the processed batch/snapshot; this is not a distributed transaction spanning both SQLite databases. A retry may repeat bounded work, and content identities plus current-state application make that safe. The object negotiation and cursor write appear in [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L178-L270).

10. **A computerd restart discards and rebuilds the local copy.** Because the lower VFS is `:memory:`, restarting computerd loses its local rows and cached payloads. Reconnection reconciles watermarks so a fresh or shorter local history is not mistaken for an up-to-date peer, resets inconsistent progress when required, and re-baselines from the authority. An initial pull populates the new VFS before it is used, and subsequent sync ticks continue convergence ([`fuse/vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L85-L133), [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L380-L409)). No correctness claim depends on recovering the dead process’s RAM. Only changes that reached the Durable Object before the loss are authoritative.

After step nine, `workspace.fs.readFile(...)` returns the formatted content. Between steps seven and nine, the container and Durable Object intentionally held different current states. That interval is not a bug in the architecture; it is the cost and semantics of using a synchronized execution representation.

## Incremental convergence, not coherent shared storage

The trace gives us a more useful consistency statement than “files sync both ways.” For one connected backend, Computer exchanges a snapshot-bounded stream of current-state entries. Cursors let it resume, hashes let it omit known payloads, and transactional local mutations prevent half-formed file structures inside one database. Pre-exec push and post-drain pull place strong, understandable convergence boundaries around the common command workflow.

What the design does **not** provide is equally important:

- It is not NFS, SMB, or another coherent remote filesystem protocol. A read on one side does not necessarily observe a write that has only committed on the other side.
- It is not one SQLite database opened from two processes. Each store has its own connection, revisions, transaction log, and failure boundary.
- It is not a distributed transaction. There is no atomic commit that covers a row in `ctx.storage.sql`, a row in computerd’s `:memory:` database, and a native process write.
- It is not an append-only event archive. Coalescing sends the latest materialized state per path plus required tombstones, not every intermediate write.
- It is not a multi-writer merge system. It converges current paths; it does not understand TypeScript syntax, preserve both versions, or produce conflict markers.

The server opens a fetch against a `currentCursor` captured for that exchange, and the driver drains only through that boundary. Writes after the snapshot opens belong to a later exchange. This avoids chasing a moving tail forever and gives the cursor a concrete meaning: every selected current-state entry through the captured `(revision, path)` boundary has been offered and cleanly processed. It still is not a point-in-time file-history snapshot because coalescing reads current live state and because prior versions are not retained. The snapshot and coalescing behavior are implemented in [`server.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/server.ts#L166-L202) and [`coalesce.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/coalesce.ts).

The protocol also checks cross-side progress. If a newly connected process reports a history shorter than a stored cursor—exactly what can happen when `computerd` restarts with an empty in-memory database—the driver does not trust the stale watermark and skip the tree. It resets and retries from the baseline. Tests explicitly construct fresh local databases and assert reconciliation and batched cursor advancement in [`sync-driver.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.test.ts). This is a recovery protocol for replicated current state, not recovery of the dead replica itself.

While computerd remains alive, it also drives a periodic sync tick; at the pin the interval is 250 ms ([`fuse/vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L83-L133)). That improves eventual visibility for work that occurs outside a single shell bracket. It should not be used as a correctness timer—“sleep 300 ms and hope” is not a durable boundary. The explicit Workspace `push()` and `pull()` operations, plus the shell executor’s push/exec/drain/pull bracket, are the semantic tools. The polling interval is an implementation detail that can change.

## Direct runtimes do not take the container route

The second half of Figure 1.4 is as important as the first. Computer supports execution backends whose code can be given a host filesystem capability. Those backends do not need a native mount, so creating a second VFS would add latency and consistency work without adding compatibility.

| Runtime | Filesystem path | Second SQLite VFS? | FUSE? | Push/pull? | Main trade-off |
| --- | --- | --- | --- | --- | --- |
| Container / computerd | Native syscall → `/workspace` → FUSE or shim → local provider → sync → authority | Yes, `node:sqlite :memory:` at this pin | Real when available; shim fallback | Yes | Broad native-tool compatibility with synchronization boundaries |
| Worker shell / just-bash | Dynamic Worker → Workers RPC → `WorkspaceFsAdapter` → authoritative `Workspace.fs` | No | No | No; backend declares `sync: "none"` | Direct durable visibility, but a JavaScript shell rather than arbitrary native binaries |
| Isolate JavaScript | Isolate’s host filesystem capability / Node-style fs shim → authoritative `Workspace.fs` | No | No | No | Direct capability access for JavaScript, not the container’s local disk semantics |

### just-bash: a shell over the authority

The Worker-shell backend runs just-bash in a Dynamic Worker. That worker obtains the host Workspace through Workers RPC and wraps the remote `.fs` surface in `WorkspaceFsAdapter`. A shell command such as `cat /workspace/project-42/NOTES.md` is interpreted by just-bash, whose filesystem operations delegate through the adapter to the authoritative Workspace. There is one durable filesystem state in this path, so `WorkerShellBackend` returns synchronization mode `"none"` ([`worker-shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/backends/worker-shell/worker-shell.ts#L190-L207)). The end-to-end example describes the Dynamic Worker constructing `WorkspaceFsAdapter` from `env.HOST.getWorkspace()` and identifies the single authoritative filesystem ([`examples/worker-shell/README.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/examples/worker-shell/README.md#L38-L61)).

“Shell” can mislead here. just-bash provides shell syntax and a JavaScript implementation of commands; it does not make ELF binaries, system packages, or the image’s native toolchain appear. Its advantage for this chapter is architectural: reads and writes are already on the authoritative side. When the shell writes the formatted `src/index.ts`, a subsequent `Workspace.fs.readFile` does not wait for FUSE or a post-exec pull because there is no replica to reconcile.

### Isolate JavaScript: Node-shaped calls over a host capability

The isolate JavaScript backend follows the same direct principle through a different adapter. When the backend connects, it creates `WorkspaceRuntimeCapability` with the host’s filesystem object. That capability implements file operations by calling the supplied filesystem; the backend wires `this.#host.fs` into it in [`worker-javascript.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/backends/worker-javascript/worker-javascript.ts#L323-L337), and the delegating methods live in [`runtime/capability.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/runtime/capability.ts).

JavaScript running in the isolate can see `node:fs`-shaped APIs through runtime shims, but “Node-style” does not mean “the Node host’s disk” or a general Node environment. The shim translates calls to the granted Workspace capability. It is a security and portability boundary: code receives the filesystem operations Computer chose to expose, and those operations reach the authority. There is no `/dev/fuse`, no computerd `:memory:` database, and no container filesystem outside `/workspace` lurking behind those calls.

This gives a practical backend-selection rule. Choose a direct runtime when its language/tool surface can express the task, because it avoids replicated-state boundaries. Choose a container when the task truly needs native binaries, an OS package, a compiler toolchain, or behavior that expects POSIX-style files. The filesystem abstraction is common at the product level, but the data path is runtime-specific.

## Edge conditions that shape the design

Part II will examine synchronization and operational policy in depth. Four issues are worth naming now because they prevent false conclusions from the architecture diagram.

### Conflicts: convergence is not intent preservation

Inside one active Durable Object, direct Workspace mutations are serialized by the object’s execution and storage model, and Workspace queues per-backend sync mutations. Across independent container copies, however, two writers can modify the same path without seeing each other first. Each has its own revision space; there is no universal revision clock to decide whose human intent should win.

The shipped policy is current-state, last-applied convergence. Applying an upstream entry performs structural cleanup when necessary—for example, replacing a directory with a file cannot leave impossible children beneath that path—and then installs the incoming state. A later accepted state can overwrite an earlier one without a conflict artifact or merge prompt. The structural behavior is explicit in [`apply.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/apply.ts#L90-L140), and the design’s conflict account is in [`docs/02_sync_protocol.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md#conflicts).

Applications that care about preserving both edits must impose a higher-level policy: serialize agent turns, allocate independent branches or paths, call `pull()` before beginning a turn, or use Git-aware merge workflows. A VFS cursor tells us what state crossed a boundary; it cannot infer whether two edits were semantically compatible.

### Ignored paths: useful locally can mean absent durably

Container-to-authority fetch can exclude path segments. At the pin, the default ignore list is `['node_modules']`, matched as a whole path segment rather than as a substring ([`ignore.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/ignore.ts#L1-L22)). This prevents a dependency installation performed in the container from filling the authoritative VFS with a large derived tree and consuming sync bandwidth.

Ignored does not mean unavailable to the running container. A compiler can use the local `/workspace/project-42/node_modules` tree. It means the ignored entries do not appear in the synchronized current-state stream and are therefore invisible to authoritative `Workspace.fs`. After computerd restarts, they must be regenerated unless another persistence mechanism exists. Derived caches are good candidates; source files and irreplaceable outputs are not. Customizing the ignore list replaces the default behavior, so callers should explicitly retain `node_modules` if they still intend to ignore it. The pinned protocol document records both the default and the invisibility consequence in [`docs/02_sync_protocol.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md#ignored-entries).

### Garbage collection: content addressing does not collect content

Replacing a file updates its current chunk map and manifest pointer, but old manifests and blobs may become unreachable. Hashing prevents duplicate storage; it does not discover liveness or delete unreachable objects. Computer includes an internal reachability-based `gc()` that preserves currently referenced objects and uses safety timing around recently staged material. It is intentionally not exposed as a public `Workspace.gc()` operation at this pin ([`gc.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/gc.ts), [`docs/03_filesystem_schema.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md#garbage-collection)).

That policy interacts with the absence of history. An orphan may remain readable at the SQL level for a while, but it has no supported path from the filesystem and may be reclaimed. Durability promises attach to reachable authoritative state, not to every digest ever produced.

### Performance: optimize the crossings that actually exist

The architecture gives us the relevant cost centers without pretending to settle their magnitude. A direct runtime pays capability/RPC and SQL/provider costs but no replica sync. A container pays for current-state enumeration, hash negotiation, missing-object transfer, local apply, and FUSE or shim operations. Fixed chunks make small in-place changes cheap when they touch few windows, but insertions that shift boundaries can create many new hashes. The 256-entry pull batch bounds working memory; it does not bound total transfer for a large tree. Ignoring regenerable directories can remove far more work than micro-optimizing a single SQL statement.

Repository performance notes contain measurements and target ideas, but benchmark numbers depend on runtime version, workload, FUSE availability, object placement, and the rapidly changing preview implementation. They should be treated as evidence for a measured configuration, not timeless product guarantees ([`docs/19_performance.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/19_performance.md)). Part II will turn these mechanisms into explicit analyses of batching, backpressure, retries, conflict policy, garbage collection, and workload-shaped optimization.

## Reading repository shorthand precisely

The Computer repository is a fast-moving preview, and its documentation says as much in [`docs/README.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/README.md). Compact phrases are useful in a README; a system design needs their scope expanded.

| Shorthand | Precise reading at commit `76d9e75` |
| --- | --- |
| “The same filesystem is mounted in the container.” | The container exposes a second VFS with the same schema/provider semantics and synchronizes its logical current state with the authoritative Workspace. |
| “FUSE mounts the Durable Object.” | FUSE mounts computerd’s process-local VFS. Sync, not FUSE, communicates with the Durable Object. |
| “Changes are immediately visible both ways.” | Local changes are immediate within one store; cross-store visibility follows periodic or explicit push/pull boundaries, especially pre-exec push and post-drain pull. |
| “Global deduplication.” | Hash payloads are shared by paths inside one Workspace database. There is no cross-Durable-Object global blob pool. |
| “One entry for identical content.” | One content-addressed object or manifest may be reused; distinct visible paths still require distinct namespace/current-state entries. |
| “Revision history.” | Revisions order current-state synchronization. The VFS does not retain a supported sequence of prior file contents. |
| “`/workspace` is persistent.” | The authoritative subtree represented by Workspace state is durable. Container-local paths, ignored entries, and unsynchronized writes are not covered. |
| “Mounts are planned.” | The full design is planned; a limited eager implementation and `_vfs_mounts` table already ship at this pin. |

These translations are not pedantry. Each one predicts a different failure mode. Mistaking a replica for a mount produces stale-read bugs. Mistaking local dedup for global dedup produces capacity errors. Mistaking cursors for history produces unrecoverable “rollback” features. Mistaking the shim for real FUSE hides races that appear only under concurrent writes.

## The point

Our `project-42` file began as SQL-backed authoritative state. Computer represented its current content as fixed, SHA-256-addressed chunks and a manifest inside the Durable Object’s private database. For native execution, Computer copied the necessary current-state entries and missing objects over capnweb RPC into a second, process-lifetime SQLite VFS. FUSE exposed that copy at `/workspace`. The formatter changed the copy; after its output stream drained, sync carried the accepted state back to the authority. If computerd disappeared, the lower copy could be rebuilt because it was never the durable source of truth.

just-bash and isolate JavaScript remove the middle copy. They receive filesystem capabilities that lead to `Workspace.fs`, so they neither mount FUSE nor run push/pull. That is not a separate filesystem model; it is the direct branch of the same invariant: execution either reaches the authority or uses a synchronized representation.

Once this distinction is fixed, the system becomes easier to reason about. Durable Objects provide the durable, transactional home. Computer defines what files mean inside that home. Content addressing reduces repeated payload work within one Workspace. Cursors and current-state entries make a volatile execution copy reconstructible. FUSE provides native compatibility without pretending that remote SQL is a local disk.

Chapter 5 measures the seam this chapter has exposed: the interval in which two valid current states differ. It asks where bytes accumulate, where time is spent, which costs come from fixed chunks, which come from FUSE, and which come from synchronization. Part II can then open the implementation with those costs already visible.

## Sources

Research and verification were performed on 2026-08-06 against Cloudflare Computer commit [`76d9e75c5688713b656bce85540d9e0071cece8b`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b). Cloudflare platform behavior was checked against the current [Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [SQLite-backed storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), and [storage-access guidance](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

The complete repository design set was inspected: [`docs/README.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/README.md); [`01_vfs`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/01_vfs.md), [`02_sync_protocol`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md), [`03_filesystem_schema`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md), [`04_filesystem_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/04_filesystem_interface.md), [`05_runtime_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/05_runtime_interface.md), [`06_mount_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/06_mount_interface.md), [`07_injected_service`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/07_injected_service.md), [`08_capnweb_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/08_capnweb_interface.md), [`09_tool_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/09_tool_interface.md), and [`10_project_layout`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/10_project_layout.md).

The remaining design documents were also inspected: [`11_lifecycle`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/11_lifecycle.md), [`12_worker_backend`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/12_worker_backend.md), [`13_git_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/13_git_interface.md), [`14_assets_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/14_assets_interface.md), [`15_artifacts_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/15_artifacts_interface.md), [`16_code_execution`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/16_code_execution.md), [`17_isolate_javascript`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/17_isolate_javascript.md), [`18_runtime_migration`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/18_runtime_migration.md), and [`19_performance`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/19_performance.md).

Shipped claims were checked against the pinned Workspace constructor and runtime orchestration in [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts) and [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts); storage, schema, write, manifest, coalescing, apply, ignore, and garbage-collection code under [`packages/dofs/src`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src); sync transport and driver code under [`packages/rpc/src`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src); and computerd’s VFS, FUSE, shim, and CLI under [`packages/computerd/src`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src). Corresponding pinned tests in those directories were used to verify chunk boundaries, per-Workspace reuse, manifest behavior, current-state coalescing, cursor/batch recovery, local VFS application, mount translation, FUSE selection, and shim reconciliation.
