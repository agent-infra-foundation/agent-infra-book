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
| [One Workspace, two modes](part-ii/one-workspace-two-modes.png) | Chapter 1 mental model | One authoritative durable Workspace supports lightweight isolate work and on-demand native Linux work. | Illustrative only; the exact physical-copy and synchronization model is documented in the article |
| [Build a website in two modes](part-ii/build-website-two-modes.png) | Chapter 2 tutorial map | Author and inspect in isolates, build in a container, then verify from the durable Workspace. | Illustrative only; exact backend calls come from the runnable example |

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
| 3.1 | Part III | One Workspace, Three Computers | Compare isolate JavaScript, `just-bash`, and container execution over one durable Workspace |
| 3.2 | Part III | The Execution Ladder | Choose native capability, JavaScript, `just-bash`, or Linux by required authority |
| 3.3 | Part III | Capability and Credential Boundary | Keep credentials and unrestricted external authority outside disposable isolate code |

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
