# Product Requirements Document

# From Stateful Compute to Agent Computers

## Building Durable Systems and Agent Workspaces with Cloudflare Durable Objects

## 1. Product Definition

This volume is an independently authored systems book about Cloudflare Durable
Objects and the architectures they enable. It begins with the Durable Objects
programming model, studies Cloudflare Computer as an open-source application
built on Durable Object SQLite storage, and ends by comparing the execution
surfaces that can act on one durable workspace.

The book is not an API catalog. It should give readers a durable mental model
that remains useful when APIs, limits, prices, and preview implementations
change.

Working title:

> **Durable Objects: From Stateful Compute to Agent Computers**

## 2. Audience

Primary readers are TypeScript developers building:

- stateful edge applications;
- collaborative and real-time systems;
- coding agents and agent infrastructure;
- multi-tenant systems with per-entity coordination;
- durable workspaces with disposable execution.

Readers should know basic TypeScript, HTTP, and SQL. The book must not assume
prior knowledge of distributed coordination, SQLite internals, FUSE, Dynamic
Workers, or capability security.

## 3. Core Thesis

> A Durable Object gives one logical entity a globally addressable home where
> computation, coordination, and durable storage meet. That durable state can
> then be paired with disposable, capability-scoped execution environments.

The thesis has three layers:

1. **State has an address.** Identity and routing establish one coordination
   point for a logical entity.
2. **State can become a computer.** A SQLite-backed filesystem can give that
   entity a persistent workspace without requiring an always-on VM disk.
3. **Execution can be disposable.** JavaScript isolates, a Bash interpreter,
   and Linux containers provide different levels of authority and compatibility.

## 4. Reader Promise

By the end of the book, a reader should be able to:

- explain when Durable Objects are preferable to stateless Workers or a shared
  database;
- choose an object identity and sharding boundary;
- reason about concurrency, lifecycle, eviction, and durable state;
- use SQLite-backed storage without confusing synchronous access with literal
  zero latency;
- distinguish point-in-time recovery from application-level version history;
- explain how Cloudflare Computer stores and synchronizes files;
- distinguish Computer's fixed 512 KiB chunks from Durable Objects internals;
- choose among native methods, Code Mode, isolate JavaScript, `just-bash`, and
  containers;
- identify which claims are platform guarantees, documented implementation
  details, open-source application behavior, or proposals.

## 5. Running System

One durable coding workspace evolves throughout the book:

```text
Client
  │
  ▼
Workspace Durable Object
  ├── conversation and task state
  ├── connected clients
  ├── SQLite-backed filesystem
  ├── recovery and version metadata
  └── runtime policy
         ├── native capabilities
         ├── isolate JavaScript / Code Mode
         ├── just-bash
         └── short-lived Linux container
```

Part I creates the object and its durable application state. Part II adds the
filesystem. Part III gives the workspace execution and a policy for choosing
the least-powerful sufficient runtime.

## 6. Scope

The book must cover:

- namespaces, IDs, stubs, RPC, placement, and routing;
- object boundaries, serialization, concurrency, and external I/O;
- lifecycle, eviction, hibernation, WebSockets, and alarms;
- legacy KV-backed storage, its asynchronous API and operational caveats;
- SQLite and KV interfaces, schemas, indexes, transactions, and PITR;
- input gates, output gates, write coalescing, and failure visibility;
- the published SQLite, WAL, Storage Relay Service, snapshot, and PITR model;
- Cloudflare Computer's Workspace and VFS architecture;
- inodes, directory entries, chunks, blobs, manifests, revisions, and GC;
- container synchronization, `computerd`, FUSE, and local fallback behavior;
- Code Mode, isolate JavaScript, `just-bash`, and container execution;
- capability boundaries, credentials, networking, and runtime selection;
- reproducible performance and failure analysis.

## 7. Non-Goals

The book must not:

- present Cloudflare Computer as the implementation of Durable Objects;
- claim that Durable Objects use Computer's 512 KiB file chunks;
- infer proprietary physical storage layout from local Wrangler files;
- present published SRS architecture as an API-level storage format;
- treat Computer manifests as persistent file versions or checkpoints;
- imply that `just-bash` is Linux or can run arbitrary native programs;
- imply that Code Mode provides Node.js, `npm install`, or a development server;
- present local Miniflare behavior or benchmark results as production guarantees;
- reproduce prices or limits without a verification date;
- read as an official Cloudflare publication.

## 8. Evidence Model

Every substantive technical claim should be classifiable as one of:

| Label | Meaning | Preferred evidence |
| --- | --- | --- |
| Platform contract | Publicly supported Durable Objects behavior | Official Cloudflare documentation |
| Current platform behavior | Current limits, pricing, lifecycle timing, or API status | Dated official documentation |
| Documented implementation | Cloudflare's published explanation of SQLite, WAL, SRS, or snapshots | Official engineering articles |
| Open-source implementation | Behavior visible in Computer, `workerd`, Workers SDK, or `just-bash` | Pinned source commit and tests |
| Case study | A company's architecture or reported result | Named, dated source |
| Proposal | A possible extension such as CDC-backed versioning | Explicitly labeled design analysis |

When code and forward-looking Computer documentation disagree, shipping code
wins and the disagreement should be noted.

## 9. Source Policy

The two canonical anchors are:

1. [Cloudflare Durable Objects documentation](https://developers.cloudflare.com/durable-objects/)
2. [Cloudflare Computer](https://github.com/cloudflare/computer)

Part I's initial source audit was performed on 2026-08-06 against Computer
commit [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b).

The opening motivation comes from:

- [Our coding agent runs in a Cloudflare Durable Object, not a VM](https://camelai.com/blog/our-coding-agent-runs-in-a-cloudflare-durable-object-not-a-vm)

Supporting primary sources include:

- [Legacy KV Storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/)
- [SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Objects storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/)
- [Easy, Fast, and Correct — Choose Three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- [Code Mode](https://blog.cloudflare.com/code-mode/)
- [`workerd`](https://github.com/cloudflare/workerd)
- [Workers SDK and Miniflare](https://github.com/cloudflare/workers-sdk)
- [`just-bash`](https://github.com/vercel-labs/just-bash)

Secondary sources may motivate comparisons but must not establish platform
guarantees.

## 10. Part Requirements

### Prologue — The Agent That Left Its VM

Use the CamelAI progression as a cold open: always-on VM, agent brain in a
Durable Object, filesystem in durable storage, JavaScript capabilities for most
work, and short-lived containers for genuine Linux jobs.

The prologue must identify CamelAI-specific choices as a case study rather than
Cloudflare guarantees.

### Part I — Introducing Durable Objects

Part I must establish the Durable Objects mental model and then use Computer as
a concrete application of that model. It should answer:

- What owns state?
- How does a request find that owner?
- What is serialized and what may interleave?
- What survives eviction or restart?
- How do legacy KV-backed and modern SQLite-backed storage differ?
- Which gates, transactions, confirmations, and recovery tools define storage
  behavior?
- How does Computer turn Durable Object SQLite rows into durable files?
- What does FUSE project, and which filesystem remains authoritative?

The part ends at `/workspace`, with a clear boundary between Durable Objects
platform guarantees and Computer's application-level VFS design.

### Part II — Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by 80%

Part II must turn Computer's dual-mode architecture into a runnable tutorial
and a transparent cost model rather than repeat Part I's storage explanation.
It should answer:

- How does one `Workspace` register isolate and container backends?
- Which website-building operations can stay in `workspace.fs` or `just-bash`?
- Why do `npm install` and a native Vite build escalate to Linux?
- What is pushed before execution and pulled afterward?
- When does container output become authoritative and durable?
- Why is there one authoritative copy but a temporary second materialization?
- Which pricing assumptions produce the article's 79.6% modeled reduction?
- Which workloads invalidate the 10% container-duty-cycle assumption?

The part ends with a website authored and verified in isolates, built in a
container, synchronized to Durable Object SQLite, and served from the durable
Workspace.

### Part III — C3: Optimizing Cloudflare Computer for Storage, Speed, and Multi-Agent Workloads

Part III must present C3 as an independent prototype built on Durable Object
SQLite. It should answer:

- How do CAS references make private branches space-efficient?
- How do 4 KiB COW pages reduce private edit cost?
- When does CDC reduce structural-edit amplification, and what does it cost?
- How do file-level optimistic checks merge disjoint work and reject stale
  same-file publication?
- Which results come from the storage engine, and which pass through the full
  Computer/FUSE pipeline?

The part ends with measured storage, speed, and 50-agent results plus a
two-agent branch-aware Computer run through independent computerd/FUSE mirrors.
It must separate implemented regular-file semantics from production gaps such
as directory metadata, symlinks, pooling, recovery, and quotas.

## 11. Chapter Rhythm

Chapters should generally include:

1. an opening incident, architecture decision, or agent task;
2. one central question and invariant;
3. a compact mental model;
4. a concrete trace, implementation slice, or worked experiment;
5. failure modes, limitations, and common misconceptions;
6. explicit evidence labels;
7. a synthesis that advances the running system.

Write as an informative systems book. Do not add quizzes, homework, generic
learning objectives, or tutorial exercises. Commands and benchmarks should be
worked evidence inside the narrative.

## 12. Visual Requirements

The initial visual plan must include:

- the VM-to-Durable-Object agent transition;
- request to object identity to state owner;
- Durable Object lifecycle and persistent-state boundary;
- platform contract versus Computer implementation layers;
- file to chunk hash to manifest to SQLite rows;
- DO-to-container synchronization and FUSE projection;
- one workspace with three execution surfaces;
- the execution decision ladder.

Prefer editable SVG for architecture diagrams. Captions should state the
conclusion, not merely restate labels.

## 13. Benchmark and Experiment Policy

Every reported measurement must state:

- local or deployed environment;
- exact package versions and Computer commit;
- payload and file sizes;
- hot or cold state;
- exact execution policy, operation count, and raw elapsed time;
- whether time includes HTTP, RPC, VFS, synchronization, or command execution;
- whether storage size is logical VFS content, SQLite allocation, or billed
  platform storage.

Experiments should deliberately expose boundaries: restart an object, race two
clients, edit one byte repeatedly, restart the container mirror, fail `npm` in
`just-bash`, and run the same task through isolate and container backends.

## 14. Maintenance Policy

- Put a verification date at each part boundary.
- Pin the companion examples to exact dependencies and a Computer commit.
- Keep volatile limits and prices in a dated appendix or online table.
- Run automated link checks and companion-code tests before publication.
- Publish compatibility notes when a new edition changes API assumptions.
- Preserve the distinction between stable concepts and current product details.

## 15. Definition of Done

The book is complete when:

- all three parts form one continuous argument;
- every chapter advances the running durable workspace;
- claims are labeled and traceable to primary sources;
- the Computer case study is verified against a pinned commit;
- worked experiments are reproducible and their scope is stated;
- platform, application, and case-study layers cannot be confused;
- the visual inventory is complete and accessible;
- all internal and external links pass validation.
