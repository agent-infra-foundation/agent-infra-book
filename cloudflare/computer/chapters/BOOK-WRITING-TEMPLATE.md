# Editorial Blueprint: Durable Objects — From Stateful Compute to Agent Computers

## Purpose

This blueprint keeps the three parts of the book aligned around one argument:

> State can have a durable, globally addressable home while execution remains
> disposable and capability-scoped.

It is a drafting instrument, not reader-facing prose. Use it to preserve the
narrative arc, evidence discipline, running system, and chapter rhythm while
individual manuscripts are written.

## Reader Starting Point

The reader understands TypeScript, HTTP, and basic SQL. They may think of:

- serverless functions as inherently stateless;
- a database as a service reached across a network;
- a filesystem as a directory tree on a VM disk;
- Bash as evidence that a Linux process exists;
- a snapshot as equivalent to application version history.

The book should replace those assumptions one layer at a time.

## Book Promise

By the final chapter, the reader should be able to explain and build this
architecture:

```text
Client
  │
  ▼
Workspace Durable Object
  ├── globally addressable identity
  ├── coordination and connected clients
  ├── private transactional SQLite
  ├── durable virtual filesystem
  └── runtime policy
         ├── native capability
         ├── isolate JavaScript / Code Mode
         ├── just-bash
         └── short-lived Linux container
```

## Narrative Arc

### Prologue: Replace the Permanent Machine

Open with the CamelAI migration from an always-on VM to a Durable Object,
durable files, JavaScript capabilities, and short-lived containers. Use the
story to pose the problem. Do not use it to establish platform guarantees.

### Part I: Introducing Durable Objects

Move from stateless request handling to identity, routing, coordination,
lifecycle, attached storage, and recovery. Treat legacy KV-backed storage as
historical and maintenance knowledge, then use Computer's VFS and FUSE path to
show how an application can turn Durable Object SQLite into durable files.

Part I must end with the reader understanding why one logical project can be
modeled as one object, why the DO-side VFS is authoritative, and why FUSE does
not mount the production Durable Object database directly.

### Part II: Engineer the Durable Computer

Read Cloudflare Computer's implementation in depth. Move from Workspace
construction through filesystem operations, atomic writes, synchronization,
conflicts, garbage collection, checkpoints, and failure analysis.

Part II must end with a durable filesystem whose source of truth survives the
execution environments attached to it.

### Part III: Give the Workspace Temporary Hands

Compare native capabilities, Code Mode, isolate JavaScript, `just-bash`, and
containers. Move from least authority and lowest startup cost toward full Linux
compatibility only when the workload requires it.

Part III must end by resolving the question from the prologue: the agent lives
with its durable state, not inside a permanently running machine.

## Evidence Discipline

Draft every technical claim under one of these classifications:

### Platform Contract

Use official Durable Objects documentation. Examples include object identity,
private attached storage, supported APIs, and documented consistency semantics.

### Current Platform Behavior

Use dated official documentation. Examples include limits, prices, lifecycle
timing, API status, and currently recommended configuration.

### Documented Implementation

Use Cloudflare engineering articles. Examples include embedded SQLite, WAL
interception, Storage Relay Service, replication, snapshots, and recovery.
Present these as published implementation descriptions, not stable storage
formats available to applications.

### Open-Source Implementation

Pin a source commit. Examples include Computer's 512 KiB chunks, VFS tables,
manifests, GC function, sync protocol, FUSE backend, and isolate adapters.

### Case Study

Name and date the architecture. Keep CamelAI's per-chat objects, SQLite/R2
thresholds, Artifacts usage, and cost claims specific to CamelAI.

### Proposal

Label design extensions before describing them. Examples include CDC,
version-root tables, public automatic GC, or a cross-object checkpoint graph.

## Recurring Misconceptions to Correct

- Computer uses Durable Objects, but Computer is not the Durable Objects
  implementation.
- Computer chooses fixed 512 KiB file chunks; Durable Objects do not expose
  that as a storage rule.
- Hot embedded SQLite can remove a network hop without making end-to-end
  latency literally zero.
- PITR restores an object database; it is not selective file version control.
- A content hash and current manifest enable deduplication and synchronization;
  they do not automatically create retained history.
- `just-bash` accepts Bash syntax but does not imply Linux, Node, or `npm`.
- Code Mode executes JavaScript over capabilities; it is not a package manager
  or a general development machine.
- A container may project the Workspace through FUSE, but the DO-side SQLite
  workspace remains authoritative.

## Running System Ledger

Keep the implementation cumulative:

| Stage | New capability | State that becomes durable |
| --- | --- | --- |
| Part I, early | Project identity and RPC | Object ID and project metadata |
| Part I, middle | Attached storage | Members, messages, tasks, and recovery policy |
| Part I, end | Workspace architecture | Nodes, chunks, manifests, and the `/workspace` projection |
| Part II, early | Filesystem implementation | Directory entries, file bytes, and atomic mutations |
| Part II, middle | Deduplicated content | Chunks, hashes, manifests, revisions |
| Part II, end | Linux projection | Sync watermarks and accepted container writes |
| Part III, early | Capability execution | Command and execution audit records |
| Part III, end | Runtime policy | Allowed runtime, authority, limits, outputs |

## Part Opening Template

```markdown
# Part [I/II/III] — [Title]

> Verified against Cloudflare documentation and companion source on YYYY-MM-DD.

[Opening scene or architecture transition.]

This part answers one question:

> [Question]

By its end, the running system will [concrete system transition].

## Part Map

[Brief description of the chapter progression.]
```

## Reusable Chapter Template

```markdown
# Chapter N — Title

> Evidence scope: [platform contract / current behavior / documented
> implementation / open-source implementation / case study / proposal]

[Open with an incident, decision, or agent task. Avoid opening with definitions.]

## The Question

[State one question and the invariant the design must preserve.]

## The Mental Model

[Explain the smallest useful model. Include a figure only if relationships are
harder to understand in prose.]

## Following One Operation

[Trace one request, SQL write, file edit, sync pass, or code execution end to
end. Keep the running system visible.]

## What the Implementation Does

[Describe verified behavior. Pin source versions for repository-derived
claims.]

## A Worked Measurement or Failure

[Use a reproducible trace, benchmark, restart, race, or deliberately unsupported
operation as evidence. State environment and measurement boundaries.]

## Failure Modes, Limits, and Misconceptions

[Explain where the model stops being true and which adjacent concepts are easy
to confuse.]

## What Is Guaranteed, Observed, and Proposed

[Summarize the evidence layers without turning the section into legal boilerplate.]

## The Point

[State the chapter conclusion and transition the running system to the next
chapter.]

## Sources

- Primary source: `URL`
- Pinned implementation source: `URL`
```

## Code and Command Style

- Prefer TypeScript for Durable Object examples.
- Use JSONC for Wrangler configuration unless the surrounding example requires
  TOML.
- Use PowerShell commands when documenting the repository's Windows development
  path; show portable alternatives only when they add value.
- State whether `npm run dev` runs on the host, inside a Dynamic Worker, or
  inside a container.
- Do not present pseudo-code as a verified API call.
- Keep examples small enough to trace completely.

## Worked Experiment Style

A measurement block must identify:

```text
environment:
deployment:
compatibility date:
package versions:
Computer commit:
payload:
execution policy and operation count:
hot/cold state:
included layers:
excluded layers:
result:
interpretation:
```

Prefer one operation that reveals an architectural boundary over a large table
of context-free timings.

## Visual Language

Use a consistent semantic palette with the rest of Agent Infra Book:

- deep navy for durable infrastructure and authoritative state;
- blue for policy and control;
- cyan for active execution and isolate sessions;
- amber for mutable or temporary state;
- purple for identity, audit, and coordination;
- green for confirmed durability, recovery, and accepted output;
- red for failure, rejection, and irreversible external effects.

Architecture diagrams should make ownership and durability boundaries visually
obvious. Avoid showing Computer's 512 KiB chunks inside the box representing
the Durable Objects platform.

## Part-Specific Review Questions

### Part I

- Does the chapter distinguish object identity from database identity?
- Does it avoid claiming all asynchronous code is race-free?
- Does it treat memory as disposable?
- Does it distinguish the legacy KV backend from KV APIs on SQLite-backed objects?
- Does it cover legacy coalescing, gates, transactions, `sync()`, and
  `deleteAll()` caveats accurately?
- Does it distinguish SQL execution latency from durable response latency?
- Does it distinguish PITR from application history?
- Does it attribute chunks, hashes, deduplication, synchronization, and FUSE to
  Computer rather than Durable Objects storage?

### Part II

- Is the Computer commit pinned?
- Is shipped behavior separated from forward-looking documentation?
- Are file chunks clearly attributed to Computer?
- Are referenced, orphaned, logical, physical, and billed bytes distinguished?
- Is the container mirror separated from the authoritative DO workspace?

### Part III

- Is each runtime described by actual authority rather than familiar syntax?
- Is Code Mode separated from Computer's JavaScript backend where necessary?
- Does `just-bash` avoid implying arbitrary binaries or processes?
- Does container setup explain synchronization, networking, and port exposure?
- Does the runtime choice follow least-powerful sufficient authority?

## Author Review Checklist

- [ ] The chapter advances the running durable workspace.
- [ ] The opening presents a concrete problem before terminology.
- [ ] One invariant organizes the chapter.
- [ ] Platform claims link to official documentation.
- [ ] Repository claims link to a pinned source revision.
- [ ] Third-party choices remain case-study-specific.
- [ ] Planned behavior is labeled as planned.
- [ ] Local development is not presented as production evidence.
- [ ] Measurements state their boundaries.
- [ ] Security and authority assumptions are explicit.
- [ ] The conclusion changes the reader's mental model.
- [ ] The transition makes the next chapter necessary.
