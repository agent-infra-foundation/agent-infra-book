# Chapter 5 — Measuring the Durable Workspace

> Evidence scope: one local end-to-end measurement of the open-source
> Cloudflare Computer implementation at commit
> [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b).
> These numbers are not measurements of Cloudflare's production network,
> placement, billing, or Container lifecycle.

The previous chapter established how a file moves from authoritative Durable
Object SQLite, through synchronization, into a container-side VFS, through
FUSE, and back. That architecture gives a coding agent something a temporary
container cannot provide by itself: a workspace that survives the machine
running the command.

Durability is not free. The important question is not whether Computer beats
a local filesystem. It did not in this run, and matching local disk is not the
system's purpose. The useful question is what the durable design buys, where
it spends storage, and where it spends time.

This chapter gives a compact answer:

> Exact content reuse and batched edits are Computer's storage strengths.
> Fixed chunk boundaries, delayed reclamation, FUSE metadata crossings, and
> synchronization are its principal costs.

## Proof that the benchmark uses Computer

Before reading any number, we need to know what was measured. A benchmark
that writes to a hand-built SQLite schema or a host directory cannot support
claims about Computer's complete path.

The following file is the smallest proof used by the harness. It is exactly
48 physical lines. The benchmark imports the official Computer packages,
constructs `Workspace` over the Durable Object's `state.storage`, connects an
official RPC client to a local `computerd`, and invokes the public
`Workspace.runtime.exec()` method.

```ts
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorageLike } from "@cloudflare/dofs";
import {
  type BackendHandle,
  Workspace,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
interface Env {
  COMPUTERD_URL: string;
}

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

export class ComputerIn48Lines extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
    });
  }

  override async fetch(): Promise<Response> {
    using run = await this.#workspace.runtime.exec(
      "LC_ALL=C ls -lR --time-style=+%s . >/dev/null",
      { backend: "local-computerd", encoding: "utf8" },
    );
    const result = await run.result();
    return Response.json(result);
  }
}
```

The local backend is a small adapter, not a replacement filesystem. It swaps
Computer's production Container startup and reverse connection for a direct
WebSocket to an already-running local `computerd`. Storage, VFS operations,
chunking, synchronization, FUSE, and command execution remain the pinned
Computer implementation. No upstream Computer source file was changed.

This is evidence of **implementation authenticity**, not user authentication.
The run used local workerd, so the listing does not prove a Cloudflare account,
credential, or production deployment was authenticated.

The measured path was:

```text
Durable Object Workspace + SQLite authority
                 │
                 │ pre-command push
                 ▼
       computerd process-local SQLite VFS
                 │
                 │ FUSE projection
                 ▼
          Bash command in /workspace
                 │
                 │ post-command pull and apply
                 ▼
Durable Object Workspace + SQLite verification
```

The full source is preserved as
[`computer-in-48-lines.ts`](../../benchmarks/storage/local-pipeline/computer-in-48-lines.ts).

## What the benchmark measures

The corpus contains 6,385 files totaling 274.781 MiB. It combines many small
files with larger sequential files so that metadata operations, content reads,
deduplication, and large-file edits all appear in the same workspace.

The baseline runs the same Bash operations on the native WSL2 filesystem. The
Computer path uses local workerd Durable Object SQLite, the official Workspace
and sync implementations, `computerd`, and a real FUSE mount. The tables keep
two Computer timing boundaries separate:

- **FUSE command** is the time spent by Bash against the mounted workspace.
- **Durable exec** includes `Workspace.runtime.exec()`, its push and pull, and
  command execution, but excludes the final independent verification query.

The results describe this pinned local setup. They establish implementation
behavior and bottlenecks; they do not predict production latency.

## Storage: reuse is excellent, mutation can be expensive

Storage is the more important result because it reveals what accumulates after
the command has finished. `Computer DB` is the size reported by Durable Object
SQLite. `Unique blob` counts hash-addressed payload bytes. `Orphan` counts blob
bytes that are no longer reachable from the current filesystem tree.

| Workspace state | Logical MiB | Computer DB MiB | Unique blob MiB | Orphan MiB |
| --- | ---: | ---: | ---: | ---: |
| Initial unique tree | 274.781 | 282.023 | 274.781 | 0.000 |
| Exact duplicate tree | 549.563 | 283.750 | 274.781 | 0.000 |
| One 10-byte overwrite | 549.563 | 284.250 | 275.281 | 0.000 |
| Five separately synchronized edits | 549.563 | 286.758 | 277.781 | 2.000 |
| Five more edits in one synchronization | 549.563 | 287.258 | 278.281 | 2.000 |
| Prepend 10 bytes to a 32 MiB file | 549.563 | 319.309 | 310.281 | 2.000 |
| Delete every file | 0.000 | 318.785 | 310.281 | 310.281 |

### Strength: exact deduplication works

Duplicating the complete 274.781 MiB tree doubled the logical file content but
did not add another copy of its payload. Unique blob storage remained 274.781
MiB, while the database grew by only 1.727 MiB for the second namespace and
metadata. This is the design at its best: repeated immutable content is cheap
inside one Workspace database.

The qualification matters. Deduplication is exact and local to one Workspace.
It is not content-defined chunking, and it is not a global blob pool shared by
unrelated Durable Objects.

### Weakness: a tiny edit can replace a large fixed chunk

Computer divides file data into fixed chunks of at most 512 KiB. Small files
are stored at their actual length; 512 KiB is not a minimum allocation. But a
10-byte in-place overwrite inside a full chunk produced one new 512 KiB blob:
52,428.8 times the changed payload.

Synchronization boundaries also matter. Five 10-byte edits synchronized
separately produced 2.5 MiB of new unique payload. Five edits made within one
command and synchronized once produced only one new 512 KiB chunk. Coalescing
therefore turns batching into a real storage optimization, not merely a speed
optimization.

The worst case is a boundary-shifting edit. Prepending 10 bytes to a 32 MiB
file changed the alignment of every following fixed chunk and created about 32
MiB of new payload. By contrast, appending 10 bytes to the aligned end of a
1 MiB file added exactly 10 payload bytes.

### Weakness: deletion does not mean immediate reclamation

After every file was deleted, the logical workspace was empty, but the
database still occupied 318.785 MiB and 310.281 MiB of blob payload was
orphaned. At the pinned commit, Computer contains internal garbage-collection
machinery and a safety window, but exposes no public `Workspace.gc()` method
for this benchmark to force reclamation. Applications must not assume that
unlink immediately reduces physical or billed storage.

The storage lesson is simple: Computer is favorable for repeated immutable
content and batched changes. It is unfavorable for frequently rewritten large
files, boundary-shifting edits, and workloads that require immediate space
reclamation.

## Speed: local disk wins, but the location of the cost is clear

| Operation | Native ms | FUSE command ms | Durable exec ms | Durable/native |
| --- | ---: | ---: | ---: | ---: |
| Recursive `ls -lR` | 921.322 | 14,360.184 | 14,491 | 15.73× |
| Read all file content | 197.986 | 7,041.529 | 7,069 | 35.70× |
| Overwrite 10 bytes once | 8.511 | 14.702 | 167 | 19.62× |
| Five edits, five synchronizations | 38.619 | 73.157 | 473 | 12.25× |
| Five edits, one synchronization | 23.390 | 53.617 | 126 | 5.39× |
| Append 10 bytes | 3.618 | 8.014 | 56 | 15.48× |
| Prepend 10 bytes to 32 MiB | 51.126 | 204.673 | 1,596 | 31.22× |

### Strength: ordinary writes inside FUSE are not the main problem

The 10-byte overwrite took 14.702 ms inside the mounted filesystem versus
8.511 ms natively, a 1.73× command-level difference. Five edits grouped into
one execution completed the full durable path in 126 ms, compared with 473 ms
when each edit crossed its own synchronization boundary. Computer benefits
substantially when a tool performs related work in one command.

### Weakness: metadata-heavy traversal crosses FUSE repeatedly

Recursive `ls` and full-tree reads spent almost all of their time inside the
FUSE command. Each directory listing, `stat`, open, read, and close crosses the
kernel FUSE boundary into `computerd`'s JavaScript and SQLite VFS. This explains
why `ls` was 15.59× slower at the command boundary and why adding durable sync
changed 14,360 ms to only 14,491 ms. Synchronization was not the main cost for
that operation.

### Weakness: changed chunks make synchronization visible

For the 32 MiB prepend, the FUSE command itself took 205 ms, but the complete
durable execution took 1,596 ms. Most of the additional time came from pulling
and applying roughly 32 MiB of newly shifted chunks. Here the storage weakness
and the speed weakness are the same event.

One implementation limit also affected the bulk setup. Sending all newly
written hashes in one synchronization exceeded local SQLite's SQL-variable
limit because the pinned Computer batching constants were too large for this
workerd configuration. The final harness kept the upstream implementation
unchanged and opened multiple runtime brackets, each with at most 40 new
hashes. This workaround makes the bulk-create timing useful for diagnosis, but
not a clean headline for normal command latency.

## Strengths and weaknesses

| Strength | Weakness |
| --- | --- |
| Exact hash-based reuse made a second 274.781 MiB tree add no duplicate payload. | A 10-byte overwrite can create a new 512 KiB chunk. |
| One synchronization coalesced five edits into one new chunk. | A small prepend can shift every fixed boundary in a large file. |
| The Durable Object remains authoritative while the FUSE copy is disposable and reconstructible. | Deletes leave unreachable payloads until garbage collection can reclaim them. |
| Native tools can operate on `/workspace` without being rewritten for a storage API. | Metadata-heavy native tools pay repeated FUSE-to-JavaScript-to-SQLite crossings. |
| Push and pull make the durability boundary explicit and measurable. | Small commands can spend more time synchronizing than executing. |

The right conclusion is neither “Computer is slow” nor “deduplication makes
storage free.” Computer purchases persistence, coordination, exact reuse, and
native-tool compatibility with extra layers. It is a good fit when a durable
workspace is more valuable than local-disk latency, especially when content is
reused and mutations can be batched. It needs care when large files are edited
near the front, directories contain thousands of tiny entries, or storage must
shrink immediately after deletion.

Part I began with a logical project name and ended with a measured durable
workspace. Part II can now open the implementation and ask how each of these
costs follows from construction, filesystem operations, synchronization, and
garbage collection.

## Sources and reproducibility

The complete method, timing boundaries, caveats, and interpretation are in the
[`benchmark document`](../../benchmarks/storage/BENCHMARK.md). The compact
[`result table`](../../benchmarks/storage/results/medium-summary.md) and
[`raw result`](../../benchmarks/storage/results/raw/local-medium-d64d142688d0.json)
preserve the reported values. The runnable harness is under
[`benchmarks/storage`](../../benchmarks/storage/).

Implementation claims were checked against the pinned Computer
[`Workspace`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts),
[`computerd`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src),
[`dofs`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src),
and [`rpc`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src)
packages.
