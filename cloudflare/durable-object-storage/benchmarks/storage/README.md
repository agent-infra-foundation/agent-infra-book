# Durable Object storage benchmarks

The publication narrative and interpretation are in
[`BENCHMARK.md`](./BENCHMARK.md). The compact generated tables are in
[`results/medium-summary.md`](./results/medium-summary.md).

The publication comparison is **native local filesystem versus Cloudflare
Computer end to end**, with both sides running once in the same WSL2 Linux
environment:

```text
native:    local process -> native WSL filesystem
computer:  local process -> FUSE -> computerd -> sync ->
           local workerd Durable Object SQLite
```

The pipeline is supplied by the pinned Cloudflare Computer source. The
benchmark does not reimplement FUSE or synchronization: it starts the existing
`computerd`, verifies a real FUSE mount, and starts local workerd with a Durable
Object `Workspace` connected to `computerd`'s RPC endpoint. Each write is
persisted with the production-direction `Workspace.pull()` sync path before the
authoritative Durable Object result is verified. It times one operation per
target; there are no repeated trials.

The benchmark already present below is a **component diagnostic**, not the
headline comparison. It isolates the authoritative storage layer so chunking,
deduplication, edit amplification, orphan retention, and SQLite allocation can
be explained without FUSE or synchronization noise.

The component diagnostic compares two filesystem representations over real Durable
Object `SqlStorage` supplied by workerd:

1. a raw SQLite baseline using ordered 512 KiB BLOB rows without hashing or
   deduplication;
2. Cloudflare Computer's authoritative `Workspace.fs` implementation.

It deliberately excludes containers, FUSE, synchronization, shells, network
round trips, and `SQLiteTestStorage`. The harness follows the benchmark pattern
in Cloudflare Computer's own `packages/dofs/src/bench/fs-ops.bench.ts`: each
case runs inside `@cloudflare/vitest-pool-workers` and receives a real
`DurableObjectStorage` through `runInDurableObject()`.

## Source fidelity

The VFS is never copied into this directory. Bootstrap exports Computer commit
`76d9e75c5688713b656bce85540d9e0071cece8b` with `git archive`, builds the
official workspaces in a temporary directory, and installs the resulting
`@cloudflare/computer` package. Uncommitted changes in the developer checkout
cannot enter the package. The package SHA-256 and source commit are recorded in
`vendor/PROVENANCE.json` and every saved result.

The published `0.1.0-alpha.1` npm package is not used: its npm `gitHead` points
to a different commit than the Part I research pin.

## Run the end-to-end local pipeline

Docker and a Cloudflare Container are not used. The local test requires WSL2,
`/dev/fuse`, `fusermount3`, Node.js 22 or newer in WSL, and the source bootstrap:

```powershell
npm.cmd run bootstrap
npm.cmd run typecheck
npm.cmd run run:local-smoke
```

The publication-size native-filesystem comparison is a separate command:

```powershell
npm.cmd run run:local-medium
```

It creates a deterministic 6,385-file, 274.8 MiB tree on both native WSL
storage and the real Computer FUSE mount. The same Bash script performs a
recursive listing, complete read, exact duplicate, small edits, append,
boundary-shifting prepend, and deletion on both sides. Results are written to
`results/medium-summary.md`, `results/medium-summary.json`, and CSV tables;
the complete observer spans and storage snapshots remain in `results/raw/`.

The smoke run has two profiles. The direct storage-path profile performs exactly
one 1 MiB write, one full read, one 10-byte in-place edit, and one delete against
native WSL storage and the Computer FUSE mount. It reports FUSE operation, sync,
Durable Object verification, and durable-total latency separately.

The runtime profile performs the same four operations through
`Workspace.runtime.exec()`. It therefore exercises Computer's official command
bracket—`Workspace.push()` → shell RPC → process on the FUSE mount → event drain
→ `Workspace.pull()`—and records Computer's observer spans for connect, push,
spawn, and pull. Both profiles verify the authoritative Durable Object state.

## Run the component diagnostic

From this directory on PowerShell:

```powershell
npm.cmd run bootstrap
npm.cmd run typecheck
npm.cmd run run:smoke
```

The complete matrix is intentionally separate:

```powershell
npm.cmd run run:full
```

Smoke mode checks the complete measurement path with smaller data and fewer
iterations. Full mode runs the publication workload.

## What is measured

- new-file writes, full reads, and identical rewrites around the fixed 512 KiB
  boundary;
- small same-chunk edits, edits in different chunks, and head insertions;
- identical, half-shared, and unique multi-file datasets;
- raw database size, logical file bytes, VFS node/chunk/blob/manifest counts,
  reachable bytes, and orphaned bytes.

Computer's public `Workspace.fs` surface at the pinned commit has whole-file
`writeFile()` and streaming `readFile()`, but no public positional-write,
append, or rename operation. Small edits in this harness therefore construct
the new byte sequence outside the timer and time the official whole-file
`writeFile()` call. Computer's internal provider benchmark already covers its
positional and rename surfaces; silently substituting those internals here
would misrepresent the public Workspace API.

Read timing includes consumption of the returned stream. Hash verification is
performed after the timer stops. Payloads are generated deterministically
inside the Durable Object callback, so request transport is not part of the
measurement.

Workerd exposes millisecond-scale timing to Worker code. Smaller cases are
therefore measured in batches totaling about 4 MiB, capped at 256 operations,
and reported as amortized time per operation. This follows the batching pattern
in Computer's own microbenchmark and avoids presenting timer-rounded zeroes as
meaningful latency. Each `write-new` item uses unique deterministic content;
deduplication is measured only in the dedicated datasets.

The baseline is chunked because Durable Object SQLite rejects a 10 MiB value in
one row. It uses the same 512 KiB boundary as Computer so row and statement
effects remain comparable, while deliberately omitting SHA-256, CAS,
manifests, and deduplication.

## Component interpretation boundary

These results measure Computer code and Durable Object SQLite semantics under
the pinned workerd test runtime. They are not production edge latency, billing
data, or a claim about undocumented Cloudflare storage internals. A deployed
benchmark would be a separate environment and must not be merged into these
numbers.
