# Part I New — From Durable Object to Durable Computer

> Concise article edition. The [long-form manuscript](PART-I.md) and
> [chapter sources](part-i/) remain the reference edition.

## TL;DR

- A Durable Object gives one logical entity a stable address, one coordinator,
  and private transactional storage.
- JavaScript memory can disappear; identity and committed storage survive.
- Cloudflare Computer builds an application-level filesystem in the Durable
  Object's SQLite using fixed chunks of at most 512 KiB, SHA-256 content
  identities, manifests, and deduplication within one Workspace database.
- Native Linux commands operate on a second, disposable VFS exposed through
  FUSE. Computer pushes state into that VFS before a command and pulls accepted
  changes back afterward. FUSE does not mount Durable Object SQLite directly.
- Exact reuse and batched changes are storage strengths. Fixed-boundary edits,
  delayed garbage reclamation, FUSE metadata crossings, and synchronization are
  the main costs.

The whole model fits in one picture:

```text
project name
    │
    ▼
Durable Object identity and single state owner
    │
    ├── disposable memory
    └── private transactional SQLite
             │
             ▼
      Computer authoritative VFS
             │
             ├── direct Workspace/isolate/just-bash access
             │
             └── push → computerd VFS → FUSE → Bash → pull
```

This part separates three kinds of evidence:

| Label | What it establishes |
| --- | --- |
| **Platform contract** | Durable Objects identity, execution, and storage behavior documented by Cloudflare. |
| **Open-source implementation** | Computer behavior verified at commit [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b). |
| **Measured behavior** | Results from the local WSL2, workerd, computerd, and real-FUSE benchmark. |

---

## Chapter 1 — Durable Objects: State Has an Address

> **TL;DR:** A Durable Object combines a stable logical identity, a single
> coordination point, and storage owned by that identity.

### One request, one owner

Suppose an agent owns the project `team/project-42`. A Worker can convert that
name into a Durable Object ID and obtain a stub that routes requests to the
object.

```ts
// Explanatory pseudocode: routing one project to one Durable Object.

function routeProject(projectName, request) {
  const id = env.PROJECTS.idFromName(projectName);
  const project = env.PROJECTS.get(id);
  return project.fetch(request);
}

routeProject("team/project-42", request);
```

The ID names the object and the stub routes to it; neither promises a permanent
JavaScript process:

```text
stable identity ≠ permanent process
```

Cloudflare can later reconstruct the same identity, so memory is a cache and
committed storage is the recoverable source of truth.

```text
request
   │
   ▼
active incarnation ── commit ──► attached storage
   │                                  │
   └── memory may disappear           │ survives reconstruction
                                      ▼
                              future incarnation
```

### Storage belongs to the object

Each Durable Object has private attached storage. In a SQLite-backed namespace,
the object can use SQL and the synchronous storage APIs locally from its own
execution context.

```ts
// Explanatory pseudocode: identity, coordination, and storage in one class.

class ProjectWorkspace extends DurableObject {
  async addTask(task) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO tasks (id, title) VALUES (?, ?)",
        task.id,
        task.title,
      );
    });

    return { accepted: true, taskId: task.id };
  }
}
```

The method may return while durability confirmation is pending, but the Output
Gate does not deliver its response until pending storage writes are confirmed.
The transaction covers SQLite, not unrelated email, Git, or external API side
effects; those need idempotency and retry handling.

### What “durable” means

Durability applies to accepted storage operations, not every kind of state the
program can touch.

| State | Survives a new incarnation? |
| --- | --- |
| Committed attached SQLite data | Yes, by the Durable Objects storage contract. |
| Ordinary JavaScript fields | No; reconstruct them. |
| Unsynchronized container files | No guarantee from the Workspace. |
| External API side effects | Governed by the external system, not the database transaction. |

Cloudflare's “zero-latency” describes same-thread, warm-cache access—not
literally zero query, durability, or end-to-end request time. The legacy
KV-backed storage backend remains maintenance knowledge; SQLite-backed objects
support SQL, synchronous KV, and compatibility asynchronous KV methods.

### Why attach storage to the state owner?

> **Central advantage:** the transactional database is attached to the globally
> addressable owner of the state. It is more than hosted SQLite.

| Advantage | Mechanism | Trade-off |
| --- | --- | --- |
| Locality | Object code and embedded SQLite share an execution location. | This removes a database network boundary, not all elapsed time. |
| Coordination | Requests for one identity meet at one owner. | One hot owner has finite throughput. |
| Consistency | Storage is private, transactional, and strongly consistent. | Cross-object joins are not the natural access pattern. |
| Elastic lifecycle | Memory can be reclaimed and reconstructed from committed state. | In-memory fields must be treated as disposable. |
| Horizontal scale | Independent identities can be placed and activated separately. | The application must choose a good entity partition. |

> **Concurrency boundary:** one owner provides a place to define ordering; it
> does not make an entire async handler atomic. Non-storage `await` operations
> can let other requests interleave, so protect invariants with transactions,
> idempotent protocols, or narrowly scoped concurrency controls.

> **Analysis:** partition by the entity whose decisions must be serialized.

> **Evidence — platform contract:** [Durable Objects concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/),
> [namespace API](https://developers.cloudflare.com/durable-objects/api/namespace/),
> [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
> [storage guidance](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/),
> and [legacy KV API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/).
> Implementation context: [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/).

---

## Chapter 2 — Computer: From SQLite VFS to FUSE

> **TL;DR:** when Computer is hosted in a Durable Object with `ctx.storage`, it
> stores the authoritative VFS there, synchronizes a disposable computerd VFS,
> and exposes that execution copy through FUSE.

### The application boundary

In the Durable Object deployment discussed here, Computer's authoritative
virtual filesystem lives in the object's SQLite. That does not mean Durable
Objects internally store every customer's data as Computer files or 512 KiB
chunks. Those are application-layer choices in the open-source Computer project.

```text
Cloudflare Computer VFS
    = Durable Object SQLite
    + fixed 512 KiB windows, with a shorter final chunk
    + SHA-256 content addressing
    + deduplication within one Workspace database
```

#### Worked trace: a 1 MiB file plus 10 bytes

Consider a whole-file `writeFile()` of `/workspace/model.bin` with a length of
1 MiB plus 10 bytes. Computer represents its content with three chunk
references: two full chunks and one 10-byte tail. The references need not have
distinct hashes when two windows contain identical bytes.

```text
/workspace/model.bin
    │
    ├── vfs_dirents: parent + "model.bin" → inode 42
    │
    ├── vfs_nodes: inode 42, type=file, size=1 MiB + 10 B
    │
    ├── vfs_chunks for inode 42
    │      index 0 → H1, 512 KiB
    │      index 1 → H2, 512 KiB
    │      index 2 → H3, 10 B
    │
    └── vfs_manifests: content identity for [H1, H2, H3]

H1/H2/H3 → vfs_blobs metadata → vfs_blob_bytes payload
```

| Table | Minimum fact needed in Part I |
| --- | --- |
| `vfs_nodes` | Stores inode metadata, cached size, revision, and an optional manifest hash. |
| `vfs_dirents` | Maps a name under a parent directory to an inode. |
| `vfs_chunks` | Authoritatively records the current ordered chunk hashes and sizes for a file. |
| `vfs_blobs` | Records metadata for a hash-addressed payload. |
| `vfs_blob_bytes` | Stores the payload bytes associated with the hash. |
| `vfs_manifests` | Optionally gives an ordered chunk list a reusable content identity. |

An identical copy needs new namespace and inode metadata but can reuse H1, H2,
and H3; a hardlink instead shares an inode. Revisions and watermarks support
synchronization. The invariant is inode → ordered chunk references →
hash-addressed payloads; a manifest is optional.

### One materialized whole-file write in pseudocode

The following is explanatory pseudocode based on Computer's pinned write path.
It is intentionally smaller than the implementation.

```ts
function writeFile(path, bytes) {
  const pieces = splitIntoFixedWindows(bytes, 512 * KiB);

  transaction(() => {
    const chunkRefs = pieces.map(piece => {
      const hash = sha256(piece);
      insertBlobIfMissing(hash, piece); // database-local exact-content reuse
      return { hash, size: piece.length };
    });

    const manifestHash = getOrCreateManifest(chunkRefs);
    const rev = incrementGlobalRevision();
    replaceFileChunks(path, chunkRefs);
    updateNode(path, { manifestHash, rev, size: bytes.length });
  });
}
```

The streaming write path differs: it can stage payload blobs before its final
metadata transaction. Direct range writes may also leave `manifest_hash` null;
`vfs_chunks` remains authoritative in both cases.

Copies keep separate inode metadata while reusing matching payloads; hardlinks
share an inode. Chapter 4 measures overwrite, append, and prepend behavior.

### What the formula does not claim

- The final chunk can be smaller than 512 KiB; the chunk size is a maximum, not
  a minimum allocation.
- Hash reuse is scoped to one Workspace database in the verified design, not a
  global CAS shared by unrelated Durable Objects.
- Local writes calculate SHA-256, but sync-side
  [`stageBlob()`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/blobs.ts)
  trusts the supplied hash instead of recomputing it; this is not end-to-end CAS
  integrity checking.
- Fixed chunking is not content-defined chunking. A front insertion shifts the
  following boundaries.
- Unreferenced blobs are candidates for garbage collection, not automatically
  retained snapshots.

### Why Computer uses this model—and where FUSE fits

| Workspace requirement | Durable Object feature | Computer result |
| --- | --- | --- |
| Stable project identity | Globally addressable object identity | Recommended mapping: one durable owner per Workspace |
| Authoritative current files | Private transactional SQLite | One authoritative VFS |
| Ordered mutations | One coordination point | Workspace operations converge on one owner |
| Direct execution | Code runs with attached storage | `Workspace.fs`, isolate, and Worker backends reach the VFS directly |
| Native Linux compatibility | Reconstructible durable authority | computerd and FUSE can remain disposable copies |
| Many isolated projects | Independent objects | Workspaces can activate and scale independently |

> **Analysis:** Computer uses Durable Object storage because a workspace is an
> ownership boundary, not because Durable Object SQLite behaves like a native
> disk. Durable Objects do not remove synchronization; they give it a stable
> authority.

Native software expects `open`, `read`, `rename`, and `unlink`, not Workspace
RPC. Computer provides broad POSIX-style compatibility through a second VFS:

```text
Durable Object SQLite VFS                   authoritative + durable
          │
          │ push/pull synchronization
          ▼
computerd in-memory SQLite VFS              disposable mirror
          │
          │ FUSE projection
          ▼
/workspace seen by Bash and native tools    POSIX-style view
```

| Layer | Owns durable state? | Role |
| --- | --- | --- |
| Durable Object SQLite VFS | Yes | Authoritative files, chunks, manifests, and revisions |
| computerd SQLite VFS | No | Reconstructible execution copy |
| FUSE | No | Translates kernel filesystem calls into computerd VFS operations |

> **Critical boundary:** FUSE does not mount Durable Object SQLite. FUSE ends
> at computerd; synchronization crosses the Durable Object boundary.
> With `FUSE_MOUNT=auto`, computerd can fall back to a userspace shim when a
> real kernel FUSE mount is unavailable.

### Follow one syscall through FUSE

FUSE is the compatibility bridge between an unmodified Linux program and
Computer's SQLite-backed VFS. A command does not know that its files originated
in a Durable Object:

```text
cat /workspace/a.txt
  │
  ├─ Linux open/read syscalls
  ▼
kernel VFS → FUSE → fuse-native → computerd FUSE driver
                                      │
                                      ├─ translate /a.txt → /workspace/a.txt
                                      └─ readRangeSync from a pending buffer
                                         or local SQLite chunk rows
```

The driver translates familiar operations and errors between the mount and VFS
namespaces. Compatibility is broad but incomplete POSIX; it is sufficient for
many unmodified shells, Git, compilers, and package managers.

Writes have a more important path:

```text
process write()
    → FUSE driver → dofs inode write buffer
    → last release for the inode commits chunks + local revision
    → pull fetches change-entry batches
    → stage missing chunk objects in the DO
    → apply each filesystem mutation in its own DO SQLite transaction
    → advance the fetch cursor after the applied batch
```

| Event | Visible to shell? | In computerd VFS? | Durable in the Workspace DO? |
| --- | ---: | ---: | ---: |
| `write()` accepted by FUSE | Yes | In a local write buffer | No |
| `fsync()` in the current direct buffered path | Yes | Does not by itself guarantee a chunk-table commit | No |
| Last file-handle `release()` for the inode | Yes | Chunks and local revision committed | No |
| Successful pull and DO apply | Yes | Yes | Yes |

**A container-side `fsync()` does not establish Workspace durability and, in the
current direct buffered path, does not guarantee a chunk-table commit.** Final
release commits locally; pull/apply makes the change authoritative.

### FUSE is also a performance policy

Computer does more than expose callbacks. Its defaults deliberately align the
kernel-facing I/O size with the storage format:

| FUSE choice | Default | Reason |
| --- | ---: | --- |
| `max_read` / `max_write` | 512 KiB maximum | Match `CHUNK_SIZE`; avoid four 128 KiB reads and repeated SQL lookups per chunk |
| `big_writes` | Enabled | Let the kernel submit larger writes |
| `auto_cache` | Enabled | Reuse page-cache data until size or mtime changes |
| Attribute/entry cache | 1 second | Reduce repeated round trips from `ls -l`, `find`, and `git status` |
| Negative cache | 0 seconds | Make newly created paths visible after an earlier miss |

Buffering small writes avoids storing and hashing an intermediate blob on every
syscall, although final release may rehash the complete file once. The trade-off
is another cache and another consistency boundary to reason about. FUSE buys
broad POSIX-style compatibility; it does not make SQLite behave like a native
disk or eliminate push/pull latency. Direct `Workspace.fs` operations avoid the
FUSE layer, but native programs cannot use that RPC interface as their
transparent working directory.

> **Evidence — open-source implementation:** pinned
> [filesystem schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md),
> [`CHUNK_SIZE` and write paths](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts),
> [core VFS schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/core.ts),
> [sync protocol](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md),
> [FUSE options](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/options.ts),
> and [FUSE implementation](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse).

---

## Chapter 3 — From Durable Storage to Shell Execution

> **TL;DR:** with a remote computerd backend, `Workspace.runtime.exec()` attempts
> to push current state, starts `/bin/sh -c` against the FUSE view, and schedules
> a pull after the command event stream is fully drained. `await run.result()`
> performs that drain and waits for the pull outcome.

### The real Computer call path

The benchmark does not imitate Computer's storage. It constructs the official
`Workspace`, gives it Durable Object storage, connects the official Computer RPC
client to local computerd, and calls `Workspace.runtime.exec()`.

```ts
// Essential call path from the verified integration.

const workspace = new Workspace({
  storage: state.storage,
  backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
});

using run = await workspace.runtime.exec(
  "LC_ALL=C ls -lR --time-style=+%s . >/dev/null",
  { backend: "local-computerd", encoding: "utf8" },
);

return Response.json(await run.result());
```

> Complete verified source: [`computer-in-48-lines.ts`](../benchmarks/storage/local-pipeline/computer-in-48-lines.ts).
> The short excerpt above preserves the public construction and execution path.

The local backend adapter replaces production Container startup and reverse
connection with a direct WebSocket to an already-running local computerd. It
does not replace Computer's storage, VFS, chunking, sync, FUSE, or command
execution. This proves implementation authenticity; because the run uses local
workerd, it is not evidence of Cloudflare account authentication or production
deployment behavior.

### Where execution can fail

With a remote-sync backend, `runtime.exec()` is a durability bracket, not one
indivisible filesystem transaction. Push, command execution, and pull have
distinct failure meanings.

| Failure point | What the caller can conclude |
| --- | --- |
| Pre-exec push fails | Computer records `pushed = 0` but still starts the command. It may run against stale computerd state. |
| Command writes through FUSE | The change exists in computerd's local VFS; it is not yet confirmed in the authoritative Workspace. |
| Computerd disappears before sending the change | Unsynchronized local changes may be lost with the disposable VFS. |
| Pull transport or apply fails | The caller lacks confirmation of complete convergence; a batched prefix may already be accepted, so retry and reconciliation must be safe. |
| Pull completes | The result reports an applied count and path-level skipped entries for that pull. |
| Event stream is cancelled before completion | Post-command pull may not be scheduled; command termination alone is not durability confirmation. |

```text
successful local write
    ≠ confirmed durable Workspace state

successful pull and apply
    = confirmed accepted Workspace state
```

This is why output draining and the final result matter. Post-pull is scheduled
after the command event stream is fully drained; cancellation can bypass it. A
process exit code describes the command, while pull describes whether its
filesystem effects crossed the durability boundary. An application should
preserve both pieces of information rather than reducing them to one “command
succeeded” boolean.

### Direct runtimes take a shorter path

Not every tool needs Linux compatibility:

```text
Workspace.fs ───────────────────────────► authoritative VFS
isolate JavaScript filesystem capability ─► authoritative VFS
just-bash Workspace adapter ──────────────► authoritative VFS

native Linux program ─► FUSE VFS ─► sync ─► authoritative VFS
```

The first three paths avoid a second synchronized VFS; this does not imply that
every capability or adapter receives raw SQLite access.

`just-bash` supplies Bash syntax and JavaScript implementations of commands; it
does not become a Linux operating system and cannot execute arbitrary native
binaries. A real Linux environment is the branch for Node, `npm install`,
compilers, development servers, and other native processes. FUSE's role is to
let those unmodified programs work with `/workspace`.

> **Evidence — open-source implementation:** pinned
> [sync protocol](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md),
> [`runtime.exec()` push/pull bracket](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts),
> [`result()` event draining](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/runtime/runtime.ts),
> [computerd `/bin/sh -c` runner](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/exec/runner.ts),
> [`Workspace` sync API](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts),
> and [`computerd` FUSE implementation](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse).
> Runnable evidence: [complete 48-line source](../benchmarks/storage/local-pipeline/computer-in-48-lines.ts).

---

## Chapter 4 — What Does the Durable Workspace Cost?

> **TL;DR:** Computer spends local-disk performance to obtain durable,
> reconstructible state. Storage reuse is strong; mutation shape and garbage
> retention matter more than logical file size alone.

### What was measured

The benchmark compares the native WSL2 filesystem with the complete local
Computer path. It uses 6,385 files totaling 274.781 MiB and the pinned Computer
implementation without upstream source changes.

```text
native baseline:
  Bash → native WSL filesystem

Computer path:
  Durable Object SQLite
      → push
      → computerd SQLite VFS
      → real FUSE
      → Bash
      → pull
      → Durable Object SQLite verification
```

The result is local implementation evidence. It does not include Cloudflare's
production placement, network, Container lifecycle, or billing environment.
The raw run pins and hashes Computer's packages, but did not record the exact
Wrangler/workerd versions selected from the sibling checkout; that limits exact
runtime reproduction without changing the measured values.

### Storage first

Four measures expose different costs: logical bytes are current file content;
unique blobs are distinct stored payloads; orphans are stored but unreachable
payloads; and `sql.databaseSize` includes payload, metadata, indexes, and SQLite
overhead. These local values are not production billing measurements.

| Workspace state | Logical MiB | Computer DB MiB | Unique blob MiB | Orphan MiB |
| --- | ---: | ---: | ---: | ---: |
| Initial unique tree | 274.781 | 282.023 | 274.781 | 0.000 |
| Exact duplicate tree | 549.563 | 283.750 | 274.781 | 0.000 |
| One 10-byte overwrite | 549.563 | 284.250 | 275.281 | 0.000 |
| Five edits in five execution brackets | 549.563 | 286.758 | 277.781 | 2.000 |
| Five more edits in one execution bracket | 549.563 | 287.258 | 278.281 | 2.000 |
| Prepend 10 bytes to a 32 MiB file | 549.563 | 319.309 | 310.281 | 2.000 |
| Delete every file | 0.000 | 318.785 | 310.281 | 310.281 |

Exact duplication added 274.781 MiB of logical content and 1.727 MiB of database
metadata, but zero unique payload bytes.

The principal weakness is edit amplification:

```text
operation                            user bytes written   new unique payload
10-byte in-place overwrite                 10 B            512 KiB
five edits / five execution brackets       50 B            2.5 MiB
five edits / one execution bracket         50 B            512 KiB
10-byte aligned append                     10 B             10 B
10-byte prepend to 32 MiB                   10 B           ~32 MiB
```

| Edit pattern | Fixed-512-KiB result | Assessment |
| --- | --- | --- |
| Exact duplicate | Reuses every matching hash | Excellent |
| Aligned append | Adds only the tail bytes | Excellent |
| Several edits inside one execution bracket | Intermediate states coalesce | Good |
| Small random overwrite | Replaces each touched full chunk | Weak |
| Separate execution bracket per edit | Creates an intermediate durable chunk per bracket | Weak |
| Insert near the front | Shifts every later fixed boundary | Worst case |

### 512 KiB chunks, GC, and checkpoints

> **TL;DR:** fixed 512 KiB windows keep chunk counts low, but a byte-scale edit
> inside a full window can create a new 512 KiB blob. Old blobs then become
> either GC-eligible or, under a hypothetical retained checkpoint, still live;
> both paths can be storage-heavy.

```text
10-byte overwrite inside one full chunk

before: current file ──► H-old ──► 512 KiB
after:  current file ──► H-new ──► 512 KiB
                         H-old
                           ├── referenced by path/checkpoint → keep
                           └── no reference → orphan
                                                │
                                                ▼
                                      gc() checks last_seen
```

| GC statement | Verified at Computer commit `76d9e75`? |
| --- | --- |
| Internal `gc(db, options)` exists | Yes |
| Default cutoff is `last_seen < now - 1 hour` | Yes |
| The hour begins at unlink time | No; it is based on `last_seen` |
| GC automatically runs every 30 or 60 minutes | No scheduler or caller found |
| Public `Workspace.gc()` exists | No |
| Still-referenced blobs are deleted | No |
| Eligible, unreferenced blob rows are deleted when internal GC runs | Yes |

The benchmark measured immediately after deletion and did not invoke the
internal collector. Its 310.281 MiB orphan result proves delayed reclamation,
not permanent leakage or an hourly cleanup promise. The collector removes SQL
rows; this benchmark does not establish whether SQLite file allocation then
shrinks, stays reserved, or becomes reusable internally.

#### Checkpoints change liveness

Computer keeps current roots, not a retained checkpoint graph. CAS alone does
not provide rollback: checkpoints would need durable version roots, retention,
and GC liveness rules. Revisions and cursors order current-state sync; they are
not named versions.

This application-layer question is separate from platform recovery:

| Recovery mechanism | Status | Scope |
| --- | --- | --- |
| Computer CAS checkpoint graph | Not shipped at the pinned commit | File/version roots designed by Computer |
| Durable Object SQLite PITR | Shipped platform feature | Restores the whole embedded database to a point within its retention window |

PITR can roll back the Workspace database as a whole; it does not turn
Computer's manifests into user-addressable file checkpoints.

| Design | Small full-chunk edit | Front insertion | Main cost |
| --- | --- | --- | --- |
| Fixed 512 KiB — shipped | One new 512 KiB chunk in the benchmark | Most later chunks change | High edit amplification, few rows |
| Smaller fixed chunks | Smaller replacement | Boundaries still shift | More hashes, SQL rows, and sync objects |
| Content-defined chunking | Local changed region | Later boundaries resynchronize | Rolling-hash CPU and complexity |
| Delta/patch log | Approximately the edit | Approximately the edit | Read chains and compaction |

#### Skeptical checkpoint verdict

| Claim | Verdict |
| --- | --- |
| Every small edit stores 512 KiB | False: 512 KiB is a maximum; a small file uses a smaller chunk |
| A 10-byte edit inside a full chunk can add 512 KiB | Verified by the benchmark |
| Five edits in separate execution brackets can add 2.5 MiB | Verified for the tested full-chunk pattern |
| One execution bracket reduces intermediate chunks | Verified: five writes in one bracket added one chunk |
| GC runs every hour | Unsupported; only a one-hour `last_seen` cutoff is verified |
| CAS and manifests provide rollback | False without retained checkpoint roots |
| Fixed 512 KiB chunks are always bad | False; they favor exact copies, append-heavy data, and low metadata |
| Fixed 512 KiB is weak for byte-scale checkpointed edits | Supported for large files with full chunks |

> **Storage verdict:** fixed 512 KiB chunks are reasonable for a current durable
> workspace, sequential transfer, exact reuse, and append-heavy content. They
> are a poor checkpoint representation for frequent byte-scale edits to full
> chunks. Without checkpoints, replaced chunks create temporary pressure until
> eligible GC actually runs. In a hypothetical Computer checkpoint graph,
> retained roots would keep old chunks live and GC could not reclaim them. This
> does not describe Durable Object SQLite PITR.

> **Evidence:** pinned [`gc.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/gc.ts),
> [schema and CDC analysis](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md),
> [fixed-chunk implementation](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts),
> [Durable Object SQLite PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api),
> and [measured storage result](../benchmarks/storage/results/medium-summary.md).


### Speed second

| Operation | Native ms | FUSE command ms | Durable exec ms |
| --- | ---: | ---: | ---: |
| Recursive `ls -lR` | 921.322 | 14,360.184 | 14,491 |
| Read all file content | 197.986 | 7,041.529 | 7,069 |
| Overwrite 10 bytes once | 8.511 | 14.702 | 167 |
| Five edits, five execution brackets | 38.619 | 73.157 | 473 |
| Five edits, one execution bracket | 23.390 | 53.617 | 126 |
| Prepend 10 bytes to 32 MiB | 51.126 | 204.673 | 1,596 |

The `ls` run spent 14,360 ms inside the combined FUSE/JavaScript/SQLite VFS path
and 14,491 ms end to end, but does not isolate those components. The prepend
spent 205 ms in-command and 1,596 ms end to end; its pull span dominated without
separately timing transfer, hash probing, and SQLite apply.

The small overwrite shows why “Computer is slow” is too vague. Its command took
14.702 ms through FUSE versus 8.511 ms natively, while the full synchronized
execution took 167 ms. The command and the durability boundary are separate
costs. Grouping five edits reduced complete durable time from 473 ms to 126 ms,
so batching improved speed and space together.

### Strengths, weaknesses, and fit

| Strength | Weakness |
| --- | --- |
| Exact duplicate content reuses hash-addressed payloads. | A tiny overwrite can replace one full 512 KiB chunk. |
| Batched mutations can coalesce intermediate states. | Front insertions can change every fixed chunk boundary. |
| The authoritative Workspace survives disposable execution. | Deletes do not imply immediate physical reclamation. |
| FUSE lets unmodified native tools use `/workspace`. | Metadata-heavy tools cross FUSE, JavaScript, and SQLite repeatedly. |
| Push and pull expose a measurable durability boundary. | Small commands can spend more time synchronizing than executing. |

> **Evidence — measured behavior:** [benchmark method](../benchmarks/storage/BENCHMARK.md),
> [compact medium result](../benchmarks/storage/results/medium-summary.md),
> [raw result](../benchmarks/storage/results/raw/local-medium-d64d142688d0.json),
> and [runnable harness](../benchmarks/storage/).

---

## Chapter 5 — When Should You Use a Durable Object?

> **TL;DR:** use a Durable Object when state belongs to a stable entity and
> concurrent requests need one owner to define and enforce their order.

> What logical entity should own this state?

> **Analysis — recommended mappings:** these are design patterns, not platform
> guarantees or a requirement to create one object per connection.

| Object identity | Scenario | Why the model fits |
| --- | --- | --- |
| `room/123` | Chat, presence, or notifications | One room coordinates clients and messages. |
| `document/456` | Collaborative editing | One owner coordinates edits and can enforce their ordering. |
| `match/789` | Multiplayer game | One match owns authoritative game state. |
| `device/abc` | Device or WebSocket session | One object coordinates connection and durable state. |
| `tenant/acme` | Tenant workflow | State has a natural tenant boundary. |
| `project/42` | Agent or coding workspace | One project can own durable files and application-defined task or command metadata. |
| `job/xyz` | Durable state machine or scheduled job | One job checkpoints transitions; alarm handlers must tolerate retries. |

> **Analysis — selection heuristic:**

```text
Does state belong to a stable entity?
    ├── no → shared database, queue, or object store
    └── yes
         ▼
Do concurrent requests need one decision maker?
    ├── no → a stateless service may be enough
    └── yes
         ▼
Can the workload split into many independent entities?
    ├── no → repartition or use a shared system
    └── yes → Durable Object is a strong candidate
```

| Requirement | Better primary tool |
| --- | --- |
| Global analytics or warehouse queries | Analytical database |
| Arbitrary cross-tenant joins | Shared relational database |
| Large immutable media archive | Object storage |
| Native local-disk performance | Native filesystem or persistent disk |
| One unpartitionable global hot key | Repartitioned or shared system |

```text
“Coordinate everyone editing document 456” → Durable Object
“Query every edit by every customer”        → analytical/shared database
```

> **WebSocket fit:** one object coordinates the room; hibernation can preserve
> supported connections while its JavaScript incarnation sleeps. Reconstruct
> in-memory connection metadata from attachments or durable storage on wake.

> **Evidence — platform guidance:** [Durable Objects use cases](https://developers.cloudflare.com/durable-objects/),
> [rules and concurrency gates](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/),
> [WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
> [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
> and [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

---

## The model to keep

```text
durable identity
    +
private transactional state
    +
application-defined durable files
    +
capability-scoped or native disposable execution
    =
a durable agent computer without one always-on machine
```

Durable Objects establish the owner and storage boundary. Computer turns that
storage into a filesystem and projects it into several execution environments.
The benchmark makes the trade explicit: durability, reconstruction, reuse, and
compatibility are purchased with storage amplification in unfavorable edits
and latency at FUSE and synchronization boundaries.
