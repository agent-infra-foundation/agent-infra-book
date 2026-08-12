# Visual Assets

Part I currently includes three generated conceptual illustrations. Exact
architecture and benchmark evidence remain in ASCII diagrams, source-linked
tables, and code.

## Part I Illustrations

| Asset | Role | Message | Evidence status |
| --- | --- | --- | --- |
| [State survives the machine](part-i/state-survives-machine.png) | Opening teaser | Execution may disappear while identity and committed state survive. | Illustrative only |
| [SQLite, synchronization, and FUSE](part-i/sqlite-fuse-workspace.png) | Architecture overview | FUSE exposes the disposable execution-side VFS rather than Durable Object SQLite directly. | Illustrative only; exact boundary is documented in the article |
| [The cost of a tiny edit](part-i/tiny-edit-cost.png) | Storage mechanism | Edit shape determines how many fixed chunks are replaced. | Illustrative only; exact values come from the retained benchmark |

## Part II Illustrations

| Asset | Role | Message | Evidence status |
| --- | --- | --- | --- |
| [One Workspace, two modes](part-ii/one-workspace-two-modes.png) | Chapter 5 mental model | One authoritative durable Workspace supports lightweight isolate work and on-demand native Linux work. | Illustrative only; the exact physical-copy and synchronization model is documented in the article |
| [Build a website in two modes](part-ii/build-website-two-modes.png) | Chapter 6 tutorial map | Author and inspect in isolates, build in a container, then verify from the durable Workspace. | Illustrative only; exact backend calls come from the runnable example |

## Part III Illustrations

| Asset | Role | Message | Evidence status |
| --- | --- | --- | --- |
| [Part III cover — English](part-iii/part-iii-cover-5x2-en.png) | English X Article cover | Highlights 98.4% less branch storage, 3.18× faster edits, and safe multi-agent work. | Editorial illustration; benchmark values are linked from the article |
| [Part III cover — Chinese](part-iii/part-iii-cover-5x2.png) | Chinese X Article cover | Highlights the same C3 results for the Simplified Chinese edition. | Editorial illustration; benchmark values are linked from the article |
| [C3 overview](part-iii/c3-overview.png) | Opening mental model | CAS, CDC, and COW form one SQLite-backed storage prototype. | Illustrative only |
| [Shared base and COW branches](part-iii/shared-base-cow-branches.png) | Chapter 10 branch model | Agents share immutable base content and retain only private COW changes. | Illustrative only; measured branch storage is reported in the article |
| [Fixed chunks versus CDC](part-iii/fixed-vs-cdc.png) | Chapter 11 edit model | CDC can resynchronize after an offset-shifting edit instead of invalidating every later boundary. | Illustrative only; algorithm details remain in pseudocode |
| [Multi-agent publication gate](part-iii/multi-agent-publication-gate.png) | Chapter 12 coordination model | Independent work converges through one transactional publication authority. | Illustrative only; conflict semantics are documented in the article |
| [Two FUSE workspaces](part-iii/two-fuse-workspaces.png) | Chapter 13 E2E model | Two isolated execution workspaces synchronize with one authoritative SQLite store. | Illustrative only; exact E2E results remain in the benchmark tables |

## Planned Figure Inventory

| Figure | Location | Working title | Editorial purpose |
| --- | --- | --- | --- |
| P.1 | Prologue | From Always-On VM to Durable State | Show the CamelAI-inspired architecture transition without presenting it as a platform guarantee |
| 1.1 | Part I | The Object That Owns State | Follow namespace and object identity to one active state owner and private storage |
| 1.2 | Part I | Durable Object Lifecycle | Separate active memory, hibernation, eviction, reconstruction, and persistent state |
| 1.3 | Part I | Legacy KV to SQLite | Compare APIs, transactions, gates, limits, PITR, and migration status without confusing API shape with storage backend |
| 1.4 | Part I | File to Chunks to Manifest | Place Computer's fixed chunks, hashes, manifests, and deduplication above `ctx.storage.sql` |
| 1.5 | Part I | Durable Files to `/workspace` | Show the authoritative DO VFS, synchronization, ephemeral container mirror, FUSE, and `/workspace` |
| 2.1 | Part II | One Workspace, Two Modes | Separate the authoritative Durable Object from isolate and container execution paths |
| 2.2 | Part II | Build One Website in Two Modes | Present the isolate → isolate → container → isolate tutorial flow |
| 2.3 | Part II | When Container Output Becomes Durable | Separate FUSE visibility, process exit, pull, and SQLite commit |
| 2.4 | Part II | The 10% Container Cost Model | Compare the always-active and 10%-duty-cycle estimates with exact values |
| 3.1 | Part III | One Shared Base, Many Private Branches | Show CAS references and 4 KiB COW pages without implying full-workspace copies |
| 3.2 | Part III | Keep Small Changes Local | Compare fixed boundaries with CDC resynchronization after a front insertion |
| 3.3 | Part III | Fifty Agents, One Durable Main | Show disjoint publication, same-file conflict, and the single transactional authority |

## Visual System

Follow the Agent Infra Book visual language:

| Color | Meaning |
| --- | --- |
| Deep navy | Durable infrastructure and authoritative state |
| Blue | Policy, routing, lifecycle, and control surfaces |
| Cyan | Active execution, Workers, and isolate sessions |
| Amber | Mutable, buffered, or temporary state |
| Purple | Identity, audit, provenance, and coordination |
| Green | Confirmed durability, recovery, and accepted output |
| Red | Failure, rejection, overload, and irreversible side effects |

Use generated PNG illustrations only for conceptual explanations. Keep exact
architecture, algorithms, and benchmark results in ASCII, tables, or code.
Every figure should include accessible alternative text. Captions should state
the conclusion rather than repeat labels.

## Boundary Rule

Never draw Computer's 512 KiB chunks, manifests, or VFS tables as if they were
inside the Durable Objects platform implementation. The diagram hierarchy must
remain:

```text
Cloudflare Computer application
          ↓
Durable Objects public storage API
          ↓
Cloudflare-managed storage infrastructure
```
