# Book Outline

## Prologue — The Agent That Left Its VM

Open with the migration described by CamelAI: move the agent brain out of an
always-on VM, move persistent files into data services, replace broad shell
authority with explicit JavaScript capabilities, and retain short-lived Linux
only for jobs that genuinely need it.

Central question:

> If the machine is temporary, where does the agent live?

The prologue introduces the book's answer without yet explaining the mechanism:
the agent's identity and durable state live in a Durable Object; files and
execution are layered around that state.

## Part I — Introducing Durable Objects

### 1. The Object That Owns State

- Start with two clients updating one project through stateless request
  handlers and ask where ownership and serialization should live.
- Define a Durable Object as one globally addressable logical owner that brings
  compute, coordination, and private attached storage together.
- Explain namespaces, deterministic names, unique IDs, stubs, RPC, lazy
  creation, initial placement, and data-location constraints.
- Compare one object per user, room, document, project, or agent with the
  global-singleton anti-pattern.
- Explain that object identity is the partitioning and scaling boundary.

Running system: route `team/project-42` to one Workspace Durable Object and
serialize accepted project updates there.

### 2. Identity Persists; Memory Does Not

- Explain single-threaded execution without claiming that asynchronous methods
  are automatically race-free.
- Trace interleaving around external I/O, storage operations, RPC, optimistic
  checks, and the hot-object ceiling.
- Follow lazy activation, constructor re-entry, idle time, hibernation,
  eviction, restart, and reconstruction.
- Treat class fields as caches; make attached storage the source of truth.
- Cover hibernatable WebSockets, attachments, alarms, retries, and idempotency.
- Introduce input and output gates as runtime support for storage correctness.

Running system: evict and reconstruct the project object without losing its
identity or accepted state.

### 3. Durable Storage: From Legacy KV to SQLite

- Establish the contract: storage is private to one object, transactional,
  strongly consistent, and serializable. Distinguish Durable Object storage
  from the separate Workers KV product.
- Thoroughly cover legacy asynchronous `get`, `put`, `delete`, and `list`,
  including 128-key bulk operations, omitted missing keys, UTF-8 ordering,
  prefix/range scans, the 128 KiB value limit, and unbounded-list memory risk.
- Explain `allowConcurrency`, `allowUnconfirmed`, `noCache`, `sync()`, write
  buffering, automatic coalescing with no intervening `await`, and backpressure
  when writes are awaited.
- Trace explicit asynchronous `transaction()`, operations on the transaction
  handle, rollback, alarms, and the legacy `deleteAll()` partial-failure caveat.
  Date compatibility-sensitive behavior such as alarm deletion.
- Compare the backends: SQLite adds synchronous SQL, synchronous KV through
  `ctx.storage.kv`, `transactionSync()`, and PITR while retaining asynchronous
  KV compatibility in the hidden `__cf_kv` table.
- Present legacy KV as maintenance and migration knowledge. Use SQLite for all
  new book code and date statements about namespace-creation restrictions.
- Explain “zero latency” as removal of a separate database network round trip,
  not zero elapsed or end-to-end latency.
- Distinguish whole-database PITR from file history, application checkpoints,
  and version control.

Running system: persist project metadata and trace one update through a storage
transaction, output gating, durability confirmation, and recovery policy.

### 4. From Durable Object to `/workspace`

- Introduce Cloudflare Computer as preview, open-source application code built
  on Durable Objects—not as the implementation of Durable Objects storage.
- Follow `withWorkspace`, `Workspace`, and `ctx.storage.sql` to the
  authoritative VFS database.
- Map `vfs_nodes`, `vfs_dirents`, `vfs_blobs`, `vfs_blob_bytes`, `vfs_chunks`,
  `vfs_manifests`, revisions, tombstones, and synchronization metadata.
- Establish the verified model:

  ```text
  Cloudflare Computer VFS
      = Durable Object SQLite
      + fixed chunks of at most 512 KiB
      + SHA-256 content addressing
      + deduplication within one Workspace database
  ```

- Explain that fixed chunks are not content-defined chunking, identical chunks
  share payload rows only within one Workspace, manifests describe current file
  content rather than retained versions, and revisions are synchronization
  counters rather than rollback IDs.
- Introduce whole-file, streaming, and range-aware write paths without yet
  exhausting their algorithms, garbage behavior, or performance.
- Pin Computer claims to a reviewed commit because repository documentation can
  describe future work that has not shipped.
- Establish two stores: the authoritative DO-side SQLite VFS and a separate,
  ephemeral SQLite VFS inside `computerd`.
- Trace the normal container cycle: push before command execution, run against
  `/workspace`, drain output, then pull accepted changes back.
- Introduce revisions, watermarks, manifests, and missing-chunk negotiation as
  an incremental synchronization protocol rather than a continuously coherent
  network filesystem.
- Explain precisely that FUSE projects the container-side VFS into
  `/workspace`; it does not mount the production Durable Object database.
- Separate real Linux FUSE through `/dev/fuse` from the userspace materializing
  shim commonly selected during local Wrangler development.
- Distinguish synchronized `/workspace` from container-local `/tmp`, `/usr`,
  `/app`, and other paths.
- Contrast the container path with isolate JavaScript and `just-bash`, which
  reach the authoritative Workspace directly through capabilities or RPC and
  do not use FUSE or the mirror.

Running system: write a file through `workspace.fs`, read it through direct
isolate execution, modify it from Linux through `/workspace`, pull it back, and
reconstruct the mirror after a container restart. Account for the file's inode,
manifest, chunk references, and hash-keyed payloads along the way.

### 5. Measuring the Durable Workspace

- Prove implementation authenticity with a 48-line integration that imports
  the official Computer packages, constructs `Workspace` over Durable Object
  storage, connects to local `computerd`, and calls `runtime.exec()`.
- Compare the native WSL filesystem with the complete local Computer path:
  Durable Object SQLite, push, computerd VFS, real FUSE, Bash, and pull.
- Make storage the primary result: exact reuse, fixed-chunk edit amplification,
  batching, boundary-shifting edits, unreachable blobs, and delayed garbage
  reclamation.
- Present a compact speed comparison for traversal, reads, small edits,
  batching, append, and prepend.
- Attribute metadata-heavy latency to FUSE/VFS crossings and large changed-file
  latency to synchronization rather than treating every slowdown as one cost.
- State the local-only boundary and the SQL-variable workaround without turning
  either into a production Cloudflare claim.

Running system: measure `project-42` as 6,385 files and 274.781 MiB, duplicate
its content, edit it across synchronization boundaries, delete it, and account
for both elapsed time and retained payload bytes.

## Part II — Engineering the Durable Computer

### 6. Constructing `Workspace` from Source

- Pin and map the Computer monorepo and package boundaries.
- Follow `withWorkspace`, schema initialization, `WorkspaceFilesystem`, runtime
  registration, and Workers RPC end to end.
- Separate DO-side authority, isolate capabilities, container services, and
  local development substitutes.

Running system: instantiate one Workspace from a Durable Object storage handle
and verify persistence across object reconstruction.

### 7. Filesystem Operations and Atomic Writes

- Trace path resolution, inodes, directory entries, metadata, and revision
  allocation through `mkdir`, `stat`, read, write, rename, and unlink.
- Compare full, streaming, positional, and range-aware writes.
- Show which SQL mutations commit atomically and which work can leave staged
  content behind after failure.
- Separate filesystem semantics from SQLite page layout and platform internals.

Running system: build and mutate a project tree while inspecting VFS rows and
transaction boundaries.

### 8. Synchronization, Conflicts, and Recovery

- Follow push, fetch cursors, watermarks, missing-object transfer, command
  execution, pull, and accepted revisions.
- Explain batching, interrupted transfers, resumability, tombstones, and
  container re-baselining.
- Reproduce concurrent-backend conflicts and document the current path-level
  conflict behavior.
- Compare real FUSE coherence with the weaker local materialization shim.

Running system: interrupt a sync, restart the container, and reconcile two
writers without treating the mirror as authoritative.

### 9. Edits, Garbage Collection, and Checkpoints

- Measure full writes and efficient positional writes separately; note that the
  current AI `edit` tool performs a full-file rewrite.
- Edit one byte repeatedly and distinguish live references, reusable payloads,
  orphaned blobs, logical bytes, allocated SQLite bytes, and billed storage.
- Explain the internal one-hour GC safety window and the current absence of a
  public or visibly automatic GC caller.
- Show that current manifests and revisions do not form a retained version
  graph.
- Compare PITR, Git, snapshots, CAS plus CDC, and version-root tables; label any
  checkpoint extension as a proposal.

Running system: account for five small edits, collect eligible garbage, and
design an explicit checkpoint layer without attributing it to Computer.

### 10. Performance and Failure Testing

- Make the headline comparison native WSL filesystem versus the complete local
  Computer path: process, real FUSE mount, `computerd`, synchronization, and
  local workerd Durable Object SQLite. Use the implementation shipped by
  Computer rather than rebuilding the pipeline. Run each matrix operation
  once, then verify the authoritative result.
- Benchmark raw DO SQL, direct Computer file APIs, synchronization, FUSE-only,
  and command execution as diagnostic layers. Never substitute the local
  materialization shim for a result labeled FUSE.
- Compare metadata-heavy workloads, range operations, large sequential I/O,
  and a `node_modules`-style tree.
- Inject failed streams, partial synchronization, object eviction, container
  loss, and oversized capability responses.
- Report hot/cold state, commit, package versions, execution policy, raw elapsed
  time, logical size, SQLite allocation, and whether network layers are
  included.
- Close with a shipped/preview/planned matrix based on source rather than
  forward-looking prose alone.

Running system: produce a reproducible workspace performance and failure
profile.

## Part III — Giving State Hands

### 11. One Workspace, Three Computers

- Separate authoritative state from the execution environment.
- Introduce native capabilities, isolate JavaScript, `just-bash`, and
  container/FUSE as an execution ladder.
- Define compatibility, authority, startup cost, memory, process, network, and
  filesystem criteria.

Running system: add a runtime policy to the Workspace object.

### 12. Code Mode: Programs Instead of Tool Calls

- Explain generated typed APIs and JavaScript composition over capabilities.
- Show loops, branches, filtering, aggregation, and reduced model round trips.
- Keep credentials and unrestricted network authority outside the sandbox.
- Distinguish the Code Mode product pattern from Computer's specific JavaScript
  backend.

Running system: inspect project state and return only an aggregated result.

### 13. Isolate JavaScript over Durable Files

- Execute a fresh ECMAScript module in a Dynamic Worker.
- Use structured input and results, durable relative imports, configured bare
  modules, Workspace-backed `node:fs/promises`, and trusted modules.
- Explain why this is not a general Node installation or dynamic package
  manager.

Running system: generate a report and save it into the durable workspace.

### 14. `just-bash`: A Shell Without Linux

- Explain Bash parsing and JavaScript implementations of familiar commands.
- Trace file operations over Workers RPC directly to the authoritative
  Workspace.
- Demonstrate useful pipelines for search and text transformation.
- Fail `npm`, native binaries, and a long-running server deliberately to reveal
  the boundary.

Running system: run the same file-analysis task with `just-bash` and JavaScript.

### 15. Containers When You Need an Operating System

- Explain native binaries, Node, package installation, compilation, processes,
  networking, and port publication.
- Mount or synchronize the durable workspace without making the container the
  source of truth.
- Discuss short-lived builds, dependency caches, generated outputs, and cleanup.

Running system: run `npm install` and a build in Linux, then persist only the
desired results.

### 16. The Durable Agent Computer

- Integrate object identity, SQLite state, durable files, recovery, runtime
  selection, credentials, network policy, and observability.
- Apply the least-powerful sufficient runtime rule.
- Compare the finished architecture with the always-on VM from the prologue.
- State the remaining limits: preview dependencies, application-level
  versioning, garbage collection, cross-object workflows, and external side
  effects.

Final model:

```text
durable identity and state
          +
capability-scoped disposable execution
          =
an agent computer without an always-on machine
```
