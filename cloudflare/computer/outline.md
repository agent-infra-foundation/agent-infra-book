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

## Part II — Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by 80%

Part II is a medium-form tutorial built around one Vite website, two execution
modes, and one authoritative Workspace. The 80% figure is a worked cost model,
not a platform guarantee.

### Chapter 5 — The 10% Container Strategy

- Separate routine agent operations from work that requires native Linux.
- Price one always-active `standard-1` Cloudflare Container as the baseline.
- Define container duty cycle as the variable the architecture can reduce.
- Keep the Workspace Durable Object SQLite VFS authoritative.
- Route direct files, `just-bash`, and JavaScript through isolates.
- Materialize a disposable container VFS only for native commands.
- Say explicitly that this is one authoritative copy plus a temporary second
  physical representation—not a zero-copy shared mount.

### Chapter 6 — Build One Website in Two Modes

- Register `WorkerShellBackend` and `CloudflareContainerBackend` on one
  `Workspace`.
- Author Vite source through `workspace.fs`.
- Inspect it through `worker-shell`.
- Run `npm install` and `npm run build` through the container.
- Verify the pulled `dist/` tree from `worker-shell` and serve it from the
  durable Workspace.

Running system: the checked-in
`examples/dual-mode-website-builder` project reports backend placement,
duration, exit code, push count, pull count, and synchronization state.

### Chapter 7 — Follow One Command Across the Durability Boundary

- Trace push, FUSE execution, changed-path fetch, missing-chunk transfer, and
  transactional apply to Durable Object SQLite.
- Distinguish command success from completed post-command synchronization.
- Explain why `node_modules` remains a disposable container-local cache while
  source, lockfiles, and `dist/` become durable.

### Chapter 8 — Calculate the 80% Reduction

- State every pricing and workload assumption before showing the result.
- Compare $36.83 for an always-active `standard-1` container with $7.53 for a
  10% duty cycle under included Worker and Durable Object allowances.
- Include 5%, 10%, 25%, 50%, and 100% sensitivity rows.
- Keep temporary chunk amplification separate from billed live workspace data.
- Recommend it for metadata-heavy agent work with occasional native builds.
- Show where continuous servers, native-everywhere workloads, large repeated
  syncs, or multiple concurrent writers erode the advantage.
- End with a capability rule: pay for Linux when the operation needs Linux.

## Part III — C3: Optimizing Cloudflare Computer for Storage, Speed, and Multi-Agent Workloads

### Chapter 9 — CAS: Store Once, Share Everywhere

- Preserve Computer's SHA-256 content-addressed foundation.
- Represent file versions with immutable compact manifests.
- Create agent branches as metadata references to shared content.

### Chapter 10 — COW: Write Only What Changed

- Store small private overwrites as 4 KiB branch pages.
- Coalesce repeated writes to the same page.
- Explain structural patches and full-materialization fallbacks.

### Chapter 11 — CDC: Keep Small Changes Small

- Replace fixed positions with content-defined boundaries.
- Use 32/128/512 KiB FastCDC minimum, average, and maximum sizes.
- Rechunk local dirty windows and reconnect to old manifest boundaries.

### Chapter 12 — Branch and Publish: Many Agents, One Durable Main

- Give each agent a private branch based on a main commit.
- Merge disjoint-file changes through one transactional authority.
- Reject stale same-file publications explicitly.
- Carry branch identity through the implemented Computer push/shell/pull
  adapter and verify two independent FUSE mounts.

### Chapter 13 — Benchmark: Storage, Speed, and Multi-Agent Execution

- Compare exact storage amplification and edit speed.
- Verify C3 through the complete Computer, computerd, FUSE, and pull path.
- Send 50 independent agent requests through one local Durable Object.
- Publish regressions, unsupported claims, and production-hardening gaps.
