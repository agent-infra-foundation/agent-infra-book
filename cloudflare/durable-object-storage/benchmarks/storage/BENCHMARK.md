# Benchmarking Cloudflare Computer's Durable Object filesystem

Cloudflare Computer presents a filesystem to code running outside the
authoritative Durable Object. In the container-style path, the command sees a
FUSE mount backed by computerd's local VFS; Computer pushes current Durable
Object state before execution and pulls changed state into Durable Object
SQLite after execution. This benchmark measures that complete local path
against the native WSL filesystem.

The main result is a trade-off rather than a single winner. Content addressing
provides excellent exact deduplication: duplicating a 274.781 MiB tree added
another 274.781 MiB of logical files but only 1.727 MiB to the Computer
database. Fixed 512 KiB boundaries are expensive for some edits: changing 10
bytes inside a full chunk added 512 KiB of unique payload, while prepending 10
bytes to a 32 MiB file added 32 MiB because every subsequent boundary shifted.

The speed result depends strongly on the operation. A recursive `ls -lR` took
0.921 seconds on native WSL storage and 14.360 seconds through Computer FUSE.
A ten-byte overwrite itself was much closer—8.5 ms native and 14.7 ms through
FUSE—but the complete durable Computer bracket took 167 ms after push, process
execution, pull, and SQLite apply.

These are measurements of pinned open-source Computer code under local WSL2
and workerd. They are not production Cloudflare placement, network, billing,
or Container lifecycle measurements.

## Running the real Computer integration

The benchmark modifies no upstream package code. Its minimal integration is a
type-checked, 48-physical-line example in
[`local-pipeline/computer-in-48-lines.ts`](./local-pipeline/computer-in-48-lines.ts):

```ts
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorageLike } from "@cloudflare/dofs";
import {
  type BackendHandle,
  Workspace,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";

class LocalComputerdBackend implements WorkspaceBackend {
  readonly id = "local-computerd";
  readonly type = "local-computerd";

  constructor(private readonly url: string) {}

  async connect(): Promise<BackendHandle> {
    const client = createWorkspaceClient({ url: this.url });
    return {
      rpc: client,
      sync: "remote",
      close: () => client.close(),
    };
  }
}

const workspace = new Workspace({
  storage: state.storage as unknown as DurableObjectStorageLike,
  backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
});

using run = await workspace.runtime.exec(
  "LC_ALL=C ls -lR --time-style=+%s . >/dev/null",
  { backend: "local-computerd", encoding: "utf8" },
);
const result = await run.result();
```

`LocalComputerdBackend` does not implement storage, FUSE, shell execution, or
sync. It supplies the official RPC client and declares that this backend has a
remote synchronized store. `Workspace` receives the real Durable Object
storage object and performs the official command bracket.

The local adapter replaces one production concern: Cloudflare's Container
backend bootstraps a container and accepts a reverse connection, whereas the
benchmark directly dials an already-running local computerd. Once connected,
the package code and protocol are unchanged.

```text
Durable Object Workspace and SQLite
             |
             | pre-exec push
             v
      computerd local VFS
             |
             | exposed at /workspace by real FUSE
             v
          Bash command
             |
             | changed paths and chunk hashes
             v
      post-exec fetch/diff/pull
             |
             v
Durable Object SQLite transaction
             |
             v
authoritative count, size, and content verification
```

This direction follows Computer's pinned
[`runtime.exec()` implementation](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts)
and its documented
[`Push → Hydrate → Exec → Fetch → Diff → Apply` protocol](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md#lifecycle).

## What was compared

The publication baseline is a native filesystem, not a hand-written SQLite
facsimile:

```text
native:
  Bash process → native WSL filesystem

Computer:
  Durable Object Workspace → push → Bash process → FUSE →
  computerd VFS → pull/apply → local workerd Durable Object SQLite
```

Both paths execute
[`local-pipeline/medium-workload.sh`](./local-pipeline/medium-workload.sh).
The generator produces deterministic AES-256-CTR pseudorandom content. That
prevents zero-filled or repetitive data from accidentally turning the unique
dataset into a deduplication test. Exact duplicates are introduced only by the
explicit duplicate phase.

### Medium corpus

| Class | Files | Size each | Logical size |
| --- | ---: | ---: | ---: |
| Source/config-like | 5,000 | 4 KiB | 19.531 MiB |
| Medium source/map-like | 1,000 | 32 KiB | 31.250 MiB |
| Artifacts | 256 | 256 KiB | 64.000 MiB |
| Large files | 128 | 1 MiB | 128.000 MiB |
| Boundary-shift file | 1 | 32 MiB | 32.000 MiB |
| **Total** | **6,385** | | **274.781 MiB** |

The complete sequence creates the tree, recursively lists it, reads every
file, makes an exact copy, performs fixed-boundary edits, deletes the copy, and
then deletes the remaining tree. Native allocated bytes use filesystem block
counts. Computer storage uses:

- `DurableObjectStorage.sql.databaseSize`;
- logical bytes and file count from `vfs_nodes`;
- chunk references from `vfs_chunks`;
- unique, reachable, and orphan payload bytes from `vfs_blobs`;
- the logical size of the isolated local workerd persistence directory.

Every phase checks native file count and logical bytes against authoritative
Durable Object state. Selected original, duplicate, overwritten, appended, and
prepended files are also read through `Workspace.fs` and checked by hash or
exact marker bytes after the pull completes.

### Timing boundaries

The report keeps three values separate:

| Value | Boundary |
| --- | --- |
| Native command | Bash filesystem operation, including `sync -f` for mutations |
| Computer FUSE command | The same operation inside the FUSE-mounted workspace |
| Computer durable exec | `runtime.exec()` from pre-push through completed post-exec pull |

Authoritative verification happens after these timers and is reported
separately. A preliminary run accidentally performed a complete namespace
digest before the Computer process exited, which added about five seconds to
small operations. That run was rejected. The final raw artifact does not
contain that traversal in command or durable timing.

## Storage results

Space is the primary result because fixed-size content-addressed chunks create
both the design's largest advantage and its sharpest disadvantage.

| State | Logical MiB | Native allocated MiB | Computer DB MiB | Unique blob MiB | Reachable MiB | Orphan MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial unique tree | 274.781 | 274.781 | 282.023 | 274.781 | 274.781 | 0.000 |
| Exact duplicate tree | 549.563 | 549.563 | 283.750 | 274.781 | 274.781 | 0.000 |
| One 10-byte overwrite | 549.563 | 549.563 | 284.250 | 275.281 | 275.281 | 0.000 |
| Five edits in separate execution brackets | 549.563 | 549.563 | 286.758 | 277.781 | 275.781 | 2.000 |
| Five edits in one execution bracket | 549.563 | 549.563 | 287.258 | 278.281 | 276.281 | 2.000 |
| Ten-byte append | 549.563 | 549.566 | 287.262 | 278.281 | 276.281 | 2.000 |
| Ten-byte prepend | 549.563 | 549.570 | 319.309 | 310.281 | 308.281 | 2.000 |
| Delete duplicate | 274.781 | 274.789 | 319.582 | 310.281 | 274.781 | 35.500 |
| Delete all | 0.000 | 0.000 | 318.785 | 310.281 | 0.000 | 310.281 |

### Exact deduplication is effective

The unique tree consumed 282.023 MiB in the Durable Object database, a 1.026×
database-to-logical ratio. Adding an exact copy doubled visible data to
549.563 MiB while the database grew only from 282.023 to 283.750 MiB. Chunk
references doubled from 6,576 to 13,152, but unique blobs remained 6,576 and
274.781 MiB.

This is the favorable workload for SHA-256 CAS: different paths refer to the
same payload rows. It is per-Workspace reuse in this implementation, not a
claim of a cross-Durable-Object global blob pool.

### A small in-place edit replaces one fixed chunk

The pinned implementation splits files into chunks of at most 512 KiB and
addresses each payload by SHA-256. A ten-byte overwrite inside a full chunk
added exactly 524,288 unique bytes:

| Operation | User bytes written | New unique bytes | Payload amplification |
| --- | ---: | ---: | ---: |
| One in-place overwrite | 10 | 524,288 | 52,428.8× |
| Five overwrites, five execution brackets | 50 | 2,621,440 | 52,428.8× |
| Five overwrites, one execution bracket | 50 | 524,288 | 10,485.8× |

Five separate command brackets made five different chunk payloads durable.
The current chunk was reachable, while four intermediate chunks accounted for
2 MiB of orphans. Five writes inside one command were coalesced to the final
path state before the Durable Object pull, so only one new 512 KiB payload
arrived.

This does **not** mean every small file consumes 512 KiB. A 4 KiB file is a
4 KiB final chunk. The amplification appears when a small change causes a
full existing chunk to receive a new hash.

### Append is favorable; prepend is the worst case

Appending ten bytes to an exactly 1 MiB file created a ten-byte trailing chunk.
The two existing 512 KiB chunks remained unchanged, so unique payload grew by
only ten bytes.

Prepending ten bytes to the 32 MiB file shifted every fixed boundary. The
operation added 33,554,442 unique bytes—32 MiB plus the ten inserted bytes—for
3,355,444.2× payload amplification. This reproduces the limitation described
in Computer's own
[`03_filesystem_schema.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md#content-defined-chunking).

### Delete does not immediately reclaim payloads

Deleting the duplicate made superseded payloads visible as 35.5 MiB of
orphans. Deleting every file reduced reachable payload to zero, but the
database remained 318.785 MiB and all 310.281 MiB of unique payload was
orphaned. The isolated local workerd persistence directory was 325.015 MiB.

Computer has an internal reachability-based collector, but the pinned public
API has no `Workspace.gc()`. This benchmark therefore reports the state a
normal caller can observe after deletion; it does not import an internal
function merely to manufacture a post-GC number.

## Speed results

| Operation | Native ms | Computer FUSE command ms | Computer durable exec ms | FUSE/native | Durable/native |
| --- | ---: | ---: | ---: | ---: | ---: |
| Recursive `ls -lR` | 921.322 | 14,360.184 | 14,491 | 15.59× | 15.73× |
| Read all 274.781 MiB | 197.986 | 7,041.529 | 7,069 | 35.57× | 35.70× |
| One 10-byte overwrite | 8.511 | 14.702 | 167 | 1.73× | 19.62× |
| Five edits, five execution brackets | 38.619 | 73.157 | 473 | 1.89× | 12.25× |
| Five edits, one execution bracket | 23.390 | 53.617 | 126 | 2.29× | 5.39× |
| Append ten bytes | 3.618 | 8.014 | 56 | 2.21× | 15.48× |
| Prepend ten bytes to 32 MiB | 51.126 | 204.673 | 1,596 | 4.00× | 31.22× |
| Delete duplicate tree | 96.909 | 3,416.710 | 5,862 | 35.26× | 60.49× |

`ls` is a metadata benchmark. Its 15.59× ratio is not caused directly by
512 KiB payload chunking; it measures thousands of directory and stat calls
through the combined kernel FUSE, fuse-native, computerd JavaScript, and SQLite
VFS path. This benchmark does not causally isolate those components. The
complete read pays both FUSE request overhead and SQLite/CAS reconstruction.

Small overwrite and append commands were only about two times native while
inside the FUSE mount. Their larger durable ratios come from fixed per-command
push, spawn, event-drain, hash negotiation, pull, and SQLite apply costs. The
five-edit comparison demonstrates why the execution bracket is an important
application-level batching boundary.

The prepend's post-exec pull took approximately 1.3 seconds in the observer
span because it transferred and applied the newly shifted 32 MiB payload. Its
FUSE command alone was 204.7 ms.

### The bulk-sync SQL limit

The first unbatched attempt to create 6,385 files completed its Bash command
but returned:

```text
sync=pending
applied=0
error=too many SQL variables at offset 417: SQLITE_ERROR
```

The same error occurred when copying the tree, even though the Durable Object
already held every payload. The failure is therefore not only a transfer-byte
limit: hash existence probing itself exceeded the local Durable Object SQL
binding limit. At the pin, both the sync driver's `PULL_BATCH_SIZE` and the
storage `PROBE_BATCH` are 256. The local workerd Durable Object path could not
execute that probe size.

The final benchmark keeps ordinary create/duplicate classes at no more than 40
new hashes per command bracket, leaving room for adjacent visibility. The
single 32 MiB boundary file references 64 chunks in its own bracket. Initial
creation and exact duplication each require 166 mutation brackets. Their totals
are reported for completeness:

| Bulk operation | Native command | Computer FUSE command sum | Computer durable total | Computer brackets |
| --- | ---: | ---: | ---: | ---: |
| Create corpus | 0.633 s | 21.050 s | 62.217 s | 166 |
| Duplicate corpus | 0.518 s | 34.092 s | 53.322 s | 166 |

These rows are not single-command throughput comparisons. They show the cost
of a required public-API workaround at this exact pin and local runtime. A
production claim requires retesting the deployed Cloudflare environment and a
newer Computer commit.

## Lessons from the earlier AgentFS experiment

The AgentFS task `019fd49d-37eb-7850-923d-8093b508e21a` was useful for finding
hypotheses, especially that CAS/CDC primarily changes space and that read speed
also needs lazy materialization, caching, and FUSE work. It was not a clean
product comparison: the experimental variant combined CDC/CAS with sparse
COW, direct reads, FUSE cache changes, batching, pack storage, and in-memory
indexes. Cache-control problems also changed the methodology during the task,
and some payload/storage accounting was difficult to reconcile from the
reported tables alone.

This Computer benchmark applies the resulting corrections:

- one immutable upstream commit and package digest;
- zero changes to the product under test;
- native filesystem as the publication baseline;
- identical Bash workloads on native and FUSE paths;
- deterministic unique content plus a separate deliberate duplicate phase;
- command, durable-sync, and verification boundaries kept separate;
- logical, database, unique, reachable, orphan, and persisted bytes reported;
- failed methodology and scale limits described instead of folded into a
  favorable aggregate.

The older raw-SQLite component suite remains useful for diagnosing individual
storage mechanisms, but it is not the headline result and should not be used
to claim end-to-end Computer performance.

## Reproduce the benchmark

Requirements are WSL2, `/dev/fuse`, `fusermount3`, Node.js 22 or newer in WSL,
and the local workerd/Wrangler dependencies prepared by the repository.

```powershell
cd cloudflare/durable-object-storage/benchmarks/storage
npm.cmd run bootstrap
npm.cmd run typecheck
npm.cmd run run:local-smoke
npm.cmd run run:local-medium
```

The final run used Computer commit
[`76d9e75c5688713b656bce85540d9e0071cece8b`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b)
and package SHA-256
`f2d1c56b7e685be887be3e63a9869948bbd5c7380ccdbb6e79e5801080fde0d2`.

Generated artifacts:

- [`results/medium-summary.md`](./results/medium-summary.md) — compact tables;
- [`results/medium-summary.json`](./results/medium-summary.json) — derived data;
- [`results/medium-speed.csv`](./results/medium-speed.csv) — speed table;
- [`results/medium-space.csv`](./results/medium-space.csv) — storage table;
- [`results/raw/local-medium-d64d142688d0.json`](./results/raw/local-medium-d64d142688d0.json) — complete observer spans, sync counts, authoritative verification, and storage snapshots.

The raw result reports `backend.kind = "fuse"`. Verification time is excluded
from the native, FUSE-command, and durable-exec columns. Local caches are left
warm and are not forcibly evicted; the reported labels make no cold-cache
claim.
