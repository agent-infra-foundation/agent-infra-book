# Writing Specification: Part I — Introducing Durable Objects

> Status: ready for drafting.
>
> Research baseline: official Cloudflare documentation reviewed on
> 2026-08-06 and Cloudflare Computer commit
> [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b).
> Reverify current product behavior before publication.

## 1. Purpose

Part I must give readers a reliable model of Durable Objects before asking them
to reason about agent computers. It begins with ownership and identity, follows
that identity through concurrency and lifecycle, explains the two generations
of attached storage, and closes by showing how Cloudflare Computer turns a
Durable Object's SQLite database into a durable virtual filesystem that Linux
can see at `/workspace`, then measuring the storage and speed costs of that
projection against a native filesystem.

The part makes one argument:

> A Durable Object gives one logical entity a durable address and a single
> coordination point. Cloudflare Computer uses that address and its attached
> SQLite database as the authoritative home of a filesystem while treating
> execution environments as replaceable views over that state.

Part I is successful when a reader can draw the system correctly from memory,
classify each technical claim by evidence type, and explain why all of the
following statements can be true at once:

1. The authoritative Computer VFS lives in the Durable Object's SQLite.
2. Computer's VFS schema, chunks, hashes, manifests, and deduplication are
   application-layer design choices rather than Durable Objects internals.
3. Today's container backend keeps a second, process-lifetime VFS and exposes
   that container-side copy through FUSE.
4. `workspace.fs`, isolate JavaScript, and `just-bash` can access the
   authoritative Workspace without using that FUSE path.
5. Exact deduplication and edit coalescing save space, while fixed chunk
   boundaries, delayed reclamation, FUSE, and synchronization impose measurable
   costs.

## 2. Deliverable

Draft Part I in [PART-I.md](PART-I.md) as five continuous chapters:

| Chapter | Working title | Central question | Running-system increment |
| --- | --- | --- | --- |
| 1 | The Object That Owns State | Where should one logical entity's coordination and state live? | Route `team/project-42` to one object and define its boundary. |
| 2 | Identity Persists; Memory Does Not | What remains true when an object is idle, evicted, restarted, or awaiting external work? | Reconstruct the project object without losing accepted state. |
| 3 | Durable Storage: From Legacy KV to SQLite | What are the storage guarantees, APIs, durability boundaries, and recovery tools? | Persist project state and define its transaction and recovery policy. |
| 4 | From Durable Object to `/workspace` | How does Computer turn authoritative SQLite rows into files visible to direct runtimes and Linux? | Follow one file through the DO VFS, synchronization, FUSE, and container restart. |
| 5 | Measuring the Durable Workspace | What storage and speed trade-offs appear on the complete local Computer path? | Compare native WSL with DO SQLite, sync, computerd, real FUSE, and Bash. |

Planning target: 22,000–30,000 words for the complete part. Treat this as an
editorial budget rather than a quality metric. Chapter 4 may be longer than the
others because it must establish both the VFS data model and the container
projection without taking implementation depth away from Part II.

## 3. Reader and Prerequisites

Assume the reader knows TypeScript, HTTP request handling, and basic SQL. Do not
assume knowledge of:

- distributed coordination;
- Cloudflare Workers routing;
- actor or entity models;
- Durable Object lifecycle and gates;
- SQLite inside Durable Objects;
- FUSE;
- content-addressed storage;
- isolate versus container execution.

Introduce terms at the point where the running system needs them. Prefer one
traceable project object over a collection of disconnected counter examples.

## 4. Running System

Use one durable project workspace throughout Part I:

```text
client request
      │
      ▼
global Worker/router
      │ namespace + object identity
      ▼
ProjectWorkspace Durable Object: team/project-42
      ├── project metadata and coordination
      ├── private attached SQLite
      └── Cloudflare Computer Workspace
             ├── authoritative vfs_* tables
             ├── direct isolate and Worker access
             └── synchronized container projection at /workspace
```

The example should accumulate rather than reset between chapters:

- Chapter 1 assigns identity and routes requests.
- Chapter 2 makes reconstruction and event handling safe.
- Chapter 3 adds the application schema, transaction policy, and recovery
  policy.
- Chapter 4 adds Computer's filesystem schema and execution views.
- Chapter 5 measures storage retention and execution cost across those views.

The code need not become a complete production application, but every excerpt
must fit one consistent class, binding, object identity, and Wrangler
configuration.

## 5. Evidence Rules

### 5.1 Evidence classes

Classify drafting notes and source ledgers using these labels:

| Label | Use for | Required evidence |
| --- | --- | --- |
| Platform contract | Supported identity, storage, consistency, and API behavior | Official Durable Objects documentation |
| Current platform behavior | Limits, lifecycle timing, backend availability, migration status, pricing | Dated official documentation |
| Documented implementation | Published descriptions of SQLite, WAL, Storage Relay Service, replication, and recovery | Official Cloudflare engineering articles |
| Open-source implementation | Computer schema, chunking, sync, FUSE, runtime adapters, and current limitations | Pinned source commit and tests |
| Case study | CamelAI architecture and reported outcomes | Named and dated case-study source |
| Proposal | CDC, retained manifests, checkpoint graphs, or other possible extensions | Explicit design analysis labeled as unshipped |

Never let evidence flow upward without support. In particular:

- Computer source can establish what Computer does, but not how Durable Objects
  physically store SQLite pages.
- A Cloudflare engineering article can describe an implementation, but does not
  automatically turn every detail into an API guarantee.
- Local Wrangler files and timings cannot establish production behavior.
- A target-design document cannot establish shipped behavior when current code
  differs.

### 5.2 Computer source hierarchy

Cloudflare Computer's documentation warns that parts of the specification are
forward-looking. Resolve Computer claims in this order:

1. Code and tests at the pinned commit.
2. Documents that explicitly say they track shipped code.
3. Repository overview prose used as a conceptual summary.
4. Documents or sections marked planned, intended, target, open question, or
   future consideration.

When prose and code differ, describe the code as current behavior and the prose
as planned intent. Record the discrepancy in a drafting note.

### 5.3 Required terminology

Use:

- **Durable Objects** for the product or programming model.
- **a Durable Object** for one logical object instance.
- **attached storage** or **the object's SQLite database** for `ctx.storage`.
- **Computer's authoritative DO-side VFS** for the `vfs_*` data stored through
  `ctx.storage.sql`.
- **container-side VFS mirror** for today's process-lifetime `computerd` store.
- **FUSE projection** or **FUSE mount backed by the container-side VFS** for
  `/workspace` inside Linux.
- **fixed chunks of at most 512 KiB** because the final file chunk may be
  smaller.
- **deduplication within one Workspace database** unless a narrower or broader
  scope is demonstrated explicitly.

Avoid:

- “Durable Objects use 512 KiB chunks.”
- “Durable Objects use SHA-256 CAS.”
- “SQLite is mounted directly into the container.”
- “FUSE mounts the Durable Object database.”
- “The container and Durable Object share one SQLite file.”
- “The sync cursor is a snapshot or version ID.”
- “Computer retains file history.”
- “Deduplication is global” without defining the database and peer scope.
- “Zero latency” without explaining which network boundary was removed.

## 6. Part-Level Narrative

The narrative should progress through five changes in the reader's mental
model:

```text
stateless requests
      ▼
one addressable state owner
      ▼
durable identity with disposable memory
      ▼
private transactional storage
      ▼
authoritative durable files with disposable execution views
      ▼
measured storage and execution trade-offs
```

Each chapter should contain:

1. an opening incident or design decision;
2. one central question and invariant;
3. a compact mental model;
4. an end-to-end operation or failure trace;
5. a source-backed implementation section;
6. limitations and misconceptions;
7. a conclusion that makes the next chapter necessary.

Do not add quizzes, homework, generic learning objectives, or detached labs.
Experiments should appear as evidence within the narrative.

## 7. Chapter 1 Specification — The Object That Owns State

### 7.1 Purpose

Replace the idea that a request handler merely reads and writes shared data
with the idea that one logical entity has an addressable owner for both state
and coordination.

Central invariant:

> The object identity defines the ownership, serialization, and horizontal
> partitioning boundary.

### 7.2 Required content

Open with two clients updating `team/project-42` through different stateless
Worker invocations. Show why a shared database can persist values without, by
itself, choosing the application's coordination boundary.

Explain:

- what a Durable Object is and what problem it solves;
- namespaces and object classes;
- deterministic names versus random unique IDs;
- `getByName`, `idFromName`, `newUniqueId`, and stubs at a conceptual level;
- RPC or `fetch()` routing through a stub;
- lazy activation and why obtaining a stub is not the same as starting work;
- initial placement, location hints, and jurisdictions without promising
  dynamic geographic migration;
- one object per project, document, room, user, game, or agent;
- why one global singleton becomes a hot coordination bottleneck;
- object-to-object communication as explicit distributed communication.

Use the running system to choose one object per project and explain what data
does not belong in that object.

### 7.3 Required trace

Trace one request:

```text
POST /teams/acme/projects/42/tasks
        │
        ▼
derive stable object name: acme/project-42
        │
        ▼
namespace.getByName(...)
        │
        ▼
stub.addTask(...)
        │
        ▼
one ProjectWorkspace owner accepts the mutation
```

The trace must distinguish the user-facing project name, namespace, object ID,
stub, active JavaScript instance, and attached database.

### 7.4 Required visual

Figure 1.1, **The Object That Owns State**:

- multiple clients and Workers on the left;
- namespace and identity routing in the middle;
- one logical project owner on the right;
- private storage beneath that owner;
- many peer objects shown as the horizontal scaling model.

### 7.5 Misconceptions to correct

- A Durable Object is not a permanently running VM.
- A namespace is not one giant object.
- The object name is not the active isolate instance.
- A shared database and a state owner solve related but different problems.
- “Single owner” does not mean the entire application must use one object.

### 7.6 Exit condition

The reader can justify the `team/project-42` boundary and follow a request to
the correct owner. The unresolved question is what happens when that owner's
active JavaScript instance disappears or two events overlap around an `await`.

## 8. Chapter 2 Specification — Identity Persists; Memory Does Not

### 8.1 Purpose

Explain the execution and lifecycle model so readers stop treating class fields
as durable state or “single-threaded” as a guarantee that all asynchronous code
is race-free.

Central invariant:

> Object identity and committed attached state survive; object memory and live
> capabilities are disposable.

### 8.2 Required content

Explain:

- one active object instance per ID at a time as the coordination model;
- synchronous JavaScript execution and cooperative asynchronous interleaving;
- where external `fetch()` and other awaited I/O can permit another event to
  run;
- storage input gates and their relationship to storage operations;
- output gates as protection against exposing unconfirmed writes;
- `blockConcurrencyWhile()` for bounded initialization, including why broad use
  can harm availability;
- constructor re-entry and rebuilding in-memory indexes or caches;
- active, idle, hibernated, evicted, restarted, and reconstructed states;
- hibernatable WebSockets and serialized attachments;
- alarms, at-least-once execution, retries, and idempotent handlers;
- the absence of a dependable shutdown callback for last-minute persistence;
- the hot-object ceiling and the need to partition by identity.

Keep current lifecycle timings out of timeless prose. If timings help the
explanation, place them in a dated note sourced from current official docs.

### 8.3 Required traces

Trace two cases:

1. A read-modify-write method awaits an external service and another request
   arrives before it resumes. Show the unsafe version and the invariant-preserving
   version.
2. The object is evicted after accepting project state. Show a fresh constructor
   rebuilding caches from attached storage on the next request.

### 8.4 Required visual

Figure 1.2, **Durable Object Lifecycle**:

```text
inactive → constructor → active → idle → hibernated/evicted
                ▲                         │
                └──────── next event ─────┘

attached storage persists below every state
```

Use separate visual treatment for memory, attached storage, WebSocket
attachments, and external side effects.

### 8.5 Misconceptions to correct

- Single-threaded does not mean every sequence spanning `await` is atomic.
- A constructor is not guaranteed to run once.
- In-memory fields are not a recovery mechanism.
- Hibernation and eviction are not application shutdown hooks.
- An alarm may run more than once and must not blindly repeat irreversible
  external effects.
- Current Computer container WebSocket handling should not be used as evidence
  that Computer's Durable Object already hibernates; the repository marks that
  work as forward-looking.

### 8.6 Exit condition

The reader can design restart-safe handlers and can say what the runtime
serializes versus what the application must protect. The unresolved question
is exactly what storage guarantees and APIs sit beneath that lifecycle.

## 9. Chapter 3 Specification — Durable Storage: From Legacy KV to SQLite

### 9.1 Purpose

Give a precise account of attached storage today while preserving enough
legacy KV knowledge to maintain older namespaces and understand the API's
evolution.

Central invariant:

> Durable Object storage is private, strongly consistent, and transactional
> within one object; API shape, backend generation, and durability timing are
> distinct concepts.

### 9.2 Start with the storage contract

Establish:

- storage belongs privately to one object;
- other objects interact through methods or messages rather than opening the
  database directly;
- operations are strongly consistent and serializable;
- transactions define atomic state changes;
- Durable Object attached storage is not the separate Workers KV product;
- committed storage survives object reconstruction while in-memory state does
  not.

### 9.3 Legacy KV requirements

Read and explain the complete legacy API semantically rather than copying its
reference text. Cover:

- asynchronous `get`, `put`, `delete`, and `list`;
- single-key and multi-key operations;
- the current maximum of 128 keys in bulk calls;
- missing-key behavior and UTF-8 key ordering;
- `start`, `startAfter`, `end`, `prefix`, `reverse`, and `limit` scans;
- unbounded `list()` memory risk;
- the legacy backend's 128 KiB value limit;
- `allowConcurrency` and the input gate;
- `allowUnconfirmed` and the output gate;
- `noCache` as a performance hint rather than a semantic change;
- automatic write coalescing when writes have no intervening `await`;
- how awaiting writes separately breaks coalescing but supplies backpressure;
- `sync()` as a wait for pending persistence;
- explicit asynchronous `transaction()`;
- using the transaction handle rather than top-level storage inside the
  callback;
- explicit rollback and rollback on failure;
- alarms on legacy storage;
- the legacy `deleteAll()` partial-failure caveat;
- compatibility-date-sensitive alarm deletion behavior;
- current namespace-creation restrictions and migration status, clearly dated.

Make this distinction explicit:

> Calling an asynchronous KV-compatible method does not prove that the object
> uses the legacy KV backend. SQLite-backed objects retain asynchronous KV
> compatibility.

### 9.4 SQLite-backed storage requirements

Explain:

- `ctx.storage.sql` and synchronous SQL cursors;
- schema initialization and migrations;
- indexes and query shape;
- synchronous KV through `ctx.storage.kv`;
- asynchronous KV compatibility through `ctx.storage`;
- the hidden `__cf_kv` table and why its implementation should not be queried
  through SQL;
- `transactionSync()` and rollback on exceptions;
- consuming relevant cursor data before crossing an `await`;
- alarms;
- `databaseSize` and the need to separate logical application bytes, SQLite
  allocation, and billed storage;
- PITR bookmarks, the restoration of the whole object database, and the
  current recovery window;
- PITR unavailability in local development;
- why all new examples in the book use SQLite-backed namespaces.

Put volatile limits, backend-creation policy, retention windows, and pricing in
dated callouts or appendices.

### 9.5 Required comparison

Include a dated table with at least:

| Capability | Legacy KV-backed object | SQLite-backed object |
| --- | --- | --- |
| Asynchronous KV API | Yes | Yes |
| Synchronous KV API | No | Yes |
| SQL | No | Yes |
| Synchronous transactions | No | Yes |
| Alarms | Yes | Yes |
| PITR | No | Yes |

Verify every row against the current documentation immediately before
publication.

### 9.6 Required worked evidence

Include three short traces:

1. Three legacy writes issued without an intervening `await`, showing automatic
   coalescing, followed by the separately awaited version showing backpressure.
2. One SQLite transaction that updates a task and appends an audit record, then
   throws to demonstrate rollback.
3. A response that depends on a write, showing query execution, output gating,
   persistence confirmation, and response release as separate moments.

The “zero-latency SQLite” discussion must say that colocating SQL execution
with the object removes a separate database network round trip. It must not say
that CPU, SQLite work, persistence, routing, or end-to-end response time is
literally zero.

### 9.7 Recovery boundary

Contrast:

```text
PITR                    application history
--------------------    ---------------------------
whole object database   selected logical entity/file
operational recovery    user-visible undo/versioning
time-based restoration  named versions/commits
platform capability     application data model
```

Do not present Computer manifests or synchronization revisions as a substitute
for either side of this comparison.

### 9.8 Misconceptions to correct

- Durable Object storage is not Workers KV.
- An async KV call does not identify the backend.
- Synchronous SQL is not zero elapsed time.
- Awaiting SQL execution and confirming durable external visibility are not
  identical concepts.
- PITR is not file-level undo, Git, or an application checkpoint graph.
- Legacy backend availability and migration status are current product facts,
  not timeless architecture.

### 9.9 Exit condition

The reader can choose SQLite for a new object, maintain a legacy object without
misreading its gates and transactions, and explain durability and PITR without
claiming application-level version history. The unresolved question is how an
application can use that SQLite database to represent a filesystem.

## 10. Chapter 4 Specification — From Durable Object to `/workspace`

### 10.1 Purpose

Use Cloudflare Computer as the concrete architecture that turns Durable Object
identity and SQLite storage into an agent workspace. Establish the complete
topology without consuming the detailed implementation, conflict, garbage
collection, and benchmark analysis reserved for Part II.

Central invariant:

> The authoritative Computer filesystem lives in the Durable Object's SQLite.
> Execution backends either access that authoritative Workspace directly or use
> a synchronized execution-side representation.

### 10.2 Required boundary statement

Place this distinction near the beginning:

```text
Durable Objects platform
└── supplies identity, execution, private SQLite, transactions, and recovery

Cloudflare Computer application
└── defines a filesystem schema, chunk store, synchronization protocol,
    runtime adapters, and FUSE projection using those platform capabilities
```

Explain that “the VFS lives in the Durable Object's SQLite” means Computer
stores its application-defined `vfs_*` rows and file BLOBs through
`ctx.storage.sql`. It does not mean the proprietary Durable Objects storage
implementation uses Computer's file format internally.

### 10.3 Authoritative DO-side VFS

Follow the source path:

```text
Durable Object constructor
      │
      ▼
new Workspace({ storage: ctx.storage })
      │
      ▼
new Database(storage)
      │
      ▼
initializeSchema(...)
      │
      ▼
WorkspaceFilesystem over ctx.storage.sql
```

Explain the role, not every column, of:

- `vfs_meta`;
- `vfs_nodes`;
- `vfs_dirents`;
- `vfs_blobs`;
- `vfs_blob_bytes`;
- `vfs_chunks`;
- `vfs_manifests`;
- `vfs_changes`;
- `_vfs_watermark`;
- `_vfs_fetch_cursor`.

Treat `_vfs_mounts` and mount behavior according to their actual shipped status
at the pinned commit. Do not promote the forward-looking mount specification to
current behavior.

### 10.4 Chunk and manifest model

Establish this exact model:

```text
Cloudflare Computer VFS
    = Durable Object SQLite
    + fixed file chunks of at most 512 KiB
    + SHA-256 content addressing
    + deduplication within one Workspace database
```

Required explanations:

- fixed boundaries use absolute file offsets;
- the last chunk can be smaller than 512 KiB;
- chunk bytes are stored by hash and inode/chunk-index rows reference them;
- identical chunk bytes within one Workspace database reuse one payload row;
- separate Durable Objects have separate private databases, so do not claim
  cross-object deduplication;
- a manifest is an ordered current chunk list whose encoded bytes are also
  hashed;
- one current `manifest_hash` on an inode is not retained file history;
- `rev` is a mutation and synchronization counter, not a recoverable version;
- fixed chunking is not CDC;
- insertion near the beginning can shift every later fixed boundary;
- CDC is documented as a future consideration, not shipped behavior.

Introduce full, streaming, positional, and range-aware writes only enough to
explain why operation shape affects hashing and storage work. State that the
current AI `edit` tool constructs and writes complete resulting file content;
defer algorithmic and benchmark detail to Part II.

### 10.5 Container-side VFS and FUSE

Present the current topology precisely:

```text
AUTHORITATIVE, DURABLE

Workspace Durable Object
└── ctx.storage.sql
    └── Computer vfs_* tables and file BLOBs
             │
             │ change entries, cursors, hashes, missing objects
             │ incremental bidirectional synchronization
             ▼
EXECUTION-SIDE, REPLACEABLE

computerd in the container
└── node:sqlite DatabaseSync(":memory:") today
    └── same VFS schema and provider abstraction
        └── FUSE callbacks
            └── /workspace
                └── Linux processes
```

Required explanations:

- the protocol keeps two filesystem trees in sync;
- the DO-side SQLite VFS is the source of truth across restarts;
- today's `computerd` creates a separate process-lifetime SQLite database;
- a different container persistence choice is architecturally possible later,
  so describe in-memory storage as current implementation behavior;
- FUSE mounts a filesystem implemented by callbacks over the container-side
  VFS; it does not mount the DO database file or storage handle;
- “the same filesystem is mounted” means the same logical tree and path model,
  not one shared SQLite file or synchronous shared-memory coherence;
- ordinary container paths outside `/workspace` remain container-local;
- `/workspace` is a convention and must exist in the VFS like any other
  directory;
- real Linux FUSE requires `/dev/fuse`;
- `FUSE_MOUNT=auto` may select the userspace materialization shim locally;
- the shim has weaker architecture and should not be used as production FUSE
  evidence.

### 10.6 Synchronization trace

Follow one file through this complete sequence:

1. `workspace.fs.writeFile("/workspace/notes.txt", ...)` writes the
   authoritative DO-side VFS.
2. The DO mutation receives a revision and produces a current-state change
   entry with chunk hashes.
3. Before container execution, the DO pushes changes the container has not
   applied.
4. The receiver probes which hash-addressed objects it already has and receives
   only missing payloads.
5. `computerd` applies the change to its container-side SQLite VFS.
6. A Linux process reads the file through `/workspace`; kernel FUSE callbacks
   resolve it against that local VFS.
7. The process edits the file; FUSE records the new container-side state and
   revision.
8. After the command output is drained, the DO fetches the container's change
   entries and missing objects in bounded batches.
9. Each accepted batch lands transactionally in the authoritative DO SQLite and
   advances its durable fetch cursor.
10. Restart the container and show the process-lifetime copy being rebuilt from
    the DO-side source of truth.

State that this is incremental convergence, not a continuously coherent NFS or
a distributed transaction spanning command execution.

### 10.7 Direct runtime paths

Contrast the container path with direct execution:

```text
just-bash Dynamic Worker
        └── Workers RPC → Workspace.fs → authoritative DO SQLite

isolate JavaScript
        └── host capability → Workspace.fs → authoritative DO SQLite

Linux container
        └── FUSE → container VFS ↔ synchronization ↔ authoritative DO SQLite
```

Explain:

- `WorkerShellBackend` declares no sync because there is no second filesystem;
- `just-bash` implements shell behavior in JavaScript and cannot run arbitrary
  native programs;
- isolate JavaScript's `node:fs` modules are capability shims, not an isolate
  disk or general Node environment;
- Linux containers provide native processes, package installation, and a real
  operating system, but their synchronized workspace remains subordinate to
  the DO-side source of truth.

Keep detailed runtime comparison for Part III.

### 10.8 Required visual

Figure 1.4, **From Durable Object to `/workspace`**, must show:

- the Durable Object boundary;
- `ctx.storage.sql` and authoritative `vfs_*` tables;
- the capnweb synchronization boundary;
- the separate container-side SQLite VFS;
- FUSE and `/workspace`;
- direct arrows from isolate JavaScript and `just-bash` to Workspace RPC;
- durability coloring that clearly distinguishes source of truth from mirror.

Never draw FUSE directly beneath `ctx.storage.sql` without the container-side
VFS and synchronization boundary between them.

### 10.9 Required worked evidence

Use a pinned Computer checkout to show:

- `Workspace` constructing `Database` from `options.storage`;
- `computerd` constructing its local VFS storage;
- the current `DatabaseSync(":memory:")` implementation;
- the FUSE mount taking a `NodeVirtualFileSystem`;
- `CHUNK_SIZE = 512 * 1024` and SHA-256 chunk construction;
- hash-keyed payload insertion and reuse;
- push/fetch object negotiation.

The manuscript may quote only short source fragments. Prefer line-linked source
references and a trace in prose over large copied implementation blocks.

### 10.10 Misconceptions to correct

- The VFS does live in Durable Object SQLite.
- Living in DO SQLite does not make the VFS schema a Durable Objects internal
  storage format.
- FUSE does not connect the Linux kernel directly to `ctx.storage.sql`.
- The container currently has its own VFS database.
- The two stores converge through synchronization rather than sharing one file.
- Container restart loses today's process-lifetime mirror, not the committed DO
  VFS.
- Files outside `/workspace` are not made durable by Computer synchronization.
- Chunk hashes and manifests do not provide retained rollback history.
- The repository's word “global” for deduplication must not be interpreted as
  deduplication across private databases belonging to unrelated Durable
  Objects.

### 10.11 Exit condition

The reader can draw the two-store container topology and the one-store direct
runtime topology without contradiction. Part II can now inspect atomic write
paths, synchronization conflicts, orphaned blobs, GC, checkpoints, and
performance without first repairing the reader's architecture model.

## 11. Chapter 5 Specification — Measuring the Durable Workspace

### 11.1 Purpose

Turn Chapter 4's architecture into measured evidence. Keep storage primary and
speed secondary. Show the benefits and liabilities of the same design without
generalizing one local result into a production Cloudflare claim.

### 11.2 Required authenticity proof

Include the 48-physical-line integration from the benchmark harness. It must
show official imports for `Workspace` and `createWorkspaceClient`, construct
`Workspace` over `state.storage`, connect to local `computerd`, and call
`Workspace.runtime.exec()`. Explain that the adapter replaces local Container
bootstrap only; it does not reimplement VFS, chunking, synchronization, FUSE,
or execution. Call this implementation authenticity, not account
authentication.

### 11.3 Required storage result

- Use the 6,385-file, 274.781 MiB medium corpus.
- Report logical bytes, Durable Object SQLite database size, unique blob bytes,
  and unreachable blob bytes.
- Highlight exact duplicate reuse as the principal strength.
- Highlight one-chunk overwrite amplification, fixed-boundary prepend
  amplification, and delayed reclamation as the principal weaknesses.
- Compare five separately synchronized edits with five edits synchronized once.
- State that 512 KiB is a maximum chunk size, not a minimum file allocation.

### 11.4 Required speed result

Keep native, FUSE-command, and complete durable-exec timing boundaries separate.
Use traversal, full-tree read, small overwrite, grouped edits, append, and
prepend to show two different costs: FUSE/VFS crossings dominate metadata-heavy
commands, while synchronization dominates when an edit creates many new
chunks.

### 11.5 Interpretation boundary and exit condition

Pin the Computer commit and state that the result uses local WSL2, workerd,
`computerd`, and real FUSE, not Cloudflare's production Container lifecycle or
network. Preserve the SQL-variable workaround as an implementation caveat.
End with a concise strength/weakness matrix and enough evidence for Part II to
explain why the costs arise.

## 12. Required Source Ledger

### 12.1 Durable Objects primary sources

- [Durable Objects documentation](https://developers.cloudflare.com/durable-objects/)
- [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- [Durable Object namespace API](https://developers.cloudflare.com/durable-objects/api/namespace/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Legacy KV Storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/)
- [SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Easy, Fast, and Correct — Choose Three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)

### 12.2 Computer documentation at the research pin

Use commit-pinned links in manuscript citations:

- [Computer overview](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/README.md)
- [VFS paths and container view](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/01_vfs.md)
- [Synchronization protocol](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md)
- [Filesystem schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md)
- [Filesystem interface](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/04_filesystem_interface.md)
- [Runtime interface](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/05_runtime_interface.md)
- [`computerd` injected service](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/07_injected_service.md)
- [Project layout](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/10_project_layout.md)
- [Lifecycle](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/11_lifecycle.md)
- [`just-bash` Worker backend](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/12_worker_backend.md)
- [Isolate JavaScript runtime](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/17_isolate_javascript.md)
- [Performance](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/19_performance.md)

### 12.3 Computer implementation anchors

- [`Workspace` construction](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L270-L300)
- [Direct `Workspace.fs` access](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L369-L380)
- [Core VFS schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/core.ts#L20-L81)
- [Synchronization schema](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/sync.ts#L6-L58)
- [Chunk size and hashing](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L23-L112)
- [Hash-keyed payload reuse](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L307-L318)
- [Container-side VFS construction](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L85-L120)
- [Current in-memory Node SQLite storage](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/testing.ts#L33-L58)
- [FUSE mount implementation](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.ts#L959-L1039)
- [Container command synchronization bracket](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L108-L280)
- [`just-bash` Workspace adapter](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/backends/worker-shell/adapter.ts#L77-L180)
- [Isolate filesystem capability bridge](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/runtime/capability.ts#L7-L25)

### 12.4 Benchmark evidence

- [Benchmark method](../benchmarks/storage/BENCHMARK.md)
- [48-line Computer integration](../benchmarks/storage/local-pipeline/computer-in-48-lines.ts)
- [Medium result](../benchmarks/storage/results/medium-summary.md)
- [Raw result](../benchmarks/storage/results/raw/local-medium-d64d142688d0.json)

### 12.5 Case-study source

- [Our coding agent runs in a Cloudflare Durable Object, not a VM](https://camelai.com/blog/our-coding-agent-runs-in-a-cloudflare-durable-object-not-a-vm)

Use this source to motivate the prologue and running system. Do not use it to
establish platform guarantees or Computer implementation details.

## 13. Code and Configuration Requirements

- Use TypeScript for Durable Object examples.
- Use one consistent class name and namespace binding throughout Part I.
- Use JSONC for Wrangler configuration unless a source-specific example
  requires TOML.
- Use SQLite-backed Durable Object migrations for all new examples.
- Keep legacy KV examples isolated and labeled as maintenance examples.
- Show complete imports and enough class context for API calls to be credible.
- Do not invent pseudo-APIs for versioning, GC, FUSE, or checkpointing.
- Pin `@cloudflare/computer` examples to the reviewed version or commit.
- State whether each command runs on the authoring host, in Wrangler, in a
  Dynamic Worker, or inside a Linux container.
- Never imply that `npm install` runs through `just-bash` or Code Mode; reserve
  native package installation for a real container.

## 14. Visual Requirements

Part I requires at least five reader-facing diagrams:

| Figure | Required conclusion |
| --- | --- |
| 1.1 — The Object That Owns State | Identity routes many callers to one logical owner, while many identities provide scale. |
| 1.2 — Identity Persists; Memory Does Not | Active memory is disposable; identity and committed attached storage survive reconstruction. |
| 1.3 — Legacy KV to SQLite | API compatibility does not imply the same backend, and modern SQLite adds SQL, synchronous KV, and PITR. |
| 1.4 — From Durable Object to `/workspace` | The authoritative VFS is in DO SQLite; FUSE exposes a synchronized container-side VFS rather than directly mounting the DO database. |
| 1.5 — Measured Computer path | The benchmark traverses DO SQLite, synchronization, computerd VFS, real FUSE, and Bash before verifying authoritative state. |

If a sixth diagram is useful, use it for the write-visibility trace in Chapter
3 or the file-to-chunks-to-manifest data model in Chapter 4. Do not add a figure
that merely repeats a short list.

## 15. Cross-Chapter Duplication Rules

- Chapter 1 may name storage but must not teach storage APIs.
- Chapter 2 may introduce gates but Chapter 3 owns their storage semantics.
- Chapter 3 may introduce application schemas but must not introduce Computer's
  VFS tables.
- Chapter 4 may introduce write-path families, sync cursors, conflicts, GC, and
  performance only enough to establish architecture.
- Chapter 5 owns the first end-to-end storage and speed results and their simple
  interpretation.
- Part II owns detailed filesystem operations, range-write algorithms,
  synchronization failure recovery, conflicts, orphan accounting, GC,
  checkpoint proposals, diagnostic layers, and failure injection.
- Part III owns the detailed runtime decision ladder, Code Mode, isolate
  JavaScript, `just-bash`, containers, and capability policy.

## 16. Publication Verification Pass

Immediately before publication:

1. Recheck all official Durable Objects pages for API, limit, lifecycle,
   backend-availability, compatibility-date, and migration changes.
2. Record the verification date in the part opening.
3. Pin the exact Computer commit used for every implementation claim.
4. Compare the pinned code with repository docs marked shipped.
5. List every forward-looking Computer claim and either remove it or label it
   explicitly.
6. Re-run all examples against the declared compatibility date.
7. Validate all links and code excerpts.
8. Verify that diagrams distinguish the DO-side database from the container
   mirror.
9. Check every use of “global,” “durable,” “atomic,” “snapshot,” “version,” and
   “immediate” for an explicit scope.
10. Have a reviewer redraw Chapter 4's topology without looking at the figure;
    any direct FUSE-to-DO line indicates the explanation still needs work.
11. Re-run Chapter 5 against its pinned dependencies and preserve the raw
    result used by every reported number.

## 17. Definition of Done

Part I is ready for editorial review when:

- [ ] All five chapters form one continuous argument and use one running system.
- [ ] Every chapter opens with a concrete problem rather than a glossary.
- [ ] Namespaces, IDs, stubs, routing, placement, and object boundaries are
      explained without implying a permanent process.
- [ ] Concurrency and lifecycle sections distinguish synchronous execution from
      asynchronous interleaving.
- [ ] Memory, storage, WebSocket state, and external side effects have separate
      durability treatment.
- [ ] The legacy KV API is covered thoroughly but all new code uses SQLite.
- [ ] Backend generation is separated from KV API compatibility.
- [ ] Transactions, gates, confirmations, alarms, and PITR are explained with
      their real scopes.
- [ ] “Zero latency” is qualified accurately.
- [ ] Computer's authoritative VFS is clearly located in DO SQLite.
- [ ] Computer's VFS design is not presented as Durable Objects' proprietary
      storage format.
- [ ] Fixed chunk size, SHA-256 addressing, and deduplication scope match the
      pinned code.
- [ ] Manifests and revisions are not presented as retained history.
- [ ] The current container-side in-memory SQLite VFS is shown as a second store.
- [ ] FUSE terminates at the container-side VFS in every diagram and trace.
- [ ] Direct isolate and `just-bash` paths bypass FUSE and synchronization.
- [ ] Chapter 5 proves the real Computer import and `runtime.exec()` path before
      presenting benchmark results.
- [ ] Storage and speed tables preserve their units, timing boundaries, and
      local-only interpretation.
- [ ] Current, shipped, preview, planned, and proposed behavior are visibly
      separated.
- [ ] Every substantive claim has an appropriate primary or pinned source.
- [ ] Volatile facts carry a verification date.
- [ ] Commands identify their execution environment.
- [ ] Internal links, external links, code, and diagrams pass validation.
