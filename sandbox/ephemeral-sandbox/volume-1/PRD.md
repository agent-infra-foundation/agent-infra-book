# Product Requirements Document

# Volume I: The Agent Workspace
## Building Parallel Agent Workspaces with Ephemeral Sandbox

## 1. Product Definition

Volume I is a repository-grounded technical book about building parallel
coding-agent workspaces. It uses Ephemeral Sandbox as the primary case study
and explains how immutable project history, private copy-on-write sessions,
namespace execution, publication, and observability fit together.

The book must distinguish clearly between:

- behavior implemented in the current Ephemeral Sandbox repository;
- experimental or partially implemented behavior;
- comparisons with external systems;
- proposed designs for a future agent runtime.

## 2. Audience

Primary readers:

- infrastructure and platform engineers;
- developers building coding-agent runtimes;
- systems engineers interested in filesystems and namespaces;
- security and reliability engineers evaluating agent execution;
- technical leaders designing multi-agent development workflows.

Readers should be comfortable with Linux processes, filesystems, networking,
APIs, containers, and basic distributed-systems concepts. The book should
explain agent-specific concepts without assuming a particular model provider.

## 3. Core Thesis

Parallel agents do not primarily need more branches. They need bounded
execution sessions with explicit bases, private deltas, observable activity,
and deliberate publication.

The central invariant is:

> Agents share immutable project truth and typed coordination state, never
> another agent’s uncommitted execution state.

## 4. Reader Outcomes

By the end of Volume I, readers should be able to:

- explain the difference between a sandbox, workspace, session, layer, delta,
  changeset, and publication;
- distinguish process isolation, filesystem isolation, network isolation, and
  tenant isolation;
- trace an operation from CLI or MCP through the gateway and runtime;
- design a LayerStack-backed copy-on-write workspace;
- understand workspace capture and publish-time three-way merge;
- reason about conflict rejection, provenance, and protected paths;
- inspect resource, process, filesystem, and execution observability;
- evaluate parallel-agent workspace designs with meaningful benchmarks;
- identify what Ephemeral Sandbox v1 does and does not provide.

## 5. Scope

The book covers:

- the sandbox landscape and terminology;
- the concurrency problem for coding agents;
- the Ephemeral Sandbox request path;
- operation contracts, catalogs, protocols, and interfaces;
- LayerStack and immutable shared history;
- private copy-on-write workspace sessions;
- overlay mounts and namespace holders;
- shared and isolated network profiles;
- command execution, PTYs, and process lifecycle;
- workspace capture and changesets;
- three-way merge and publication;
- provenance and file blame;
- leases, squashing, teardown, and cleanup;
- observability and resource accounting;
- configuration and platform behavior;
- tests, benchmarks, and known limitations.

## 6. Non-Goals

Volume I will not present the current project as a complete solution for:

- hardened microVM isolation between hostile tenants;
- general-purpose capability and credential brokering;
- unrestricted cloud fleet scheduling;
- durable process-memory checkpointing;
- browser or computer-use session isolation;
- universal agent protocols;
- all forms of prompt-injection defense;
- production governance for every agent workload.

These topics may appear as comparisons, limitations, or Volume II directions,
but they must not be described as completed v1 functionality.

## 7. Writing Rules

Every chapter should contain:

1. An opening incident, task, or agent workflow.
2. The central question and the concept being introduced.
3. A concrete scenario, trace, or worked example that makes the concept visible.
4. The corresponding Ephemeral Sandbox implementation.
5. Alternatives and design trade-offs.
6. Failure modes, limits, and trust assumptions.
7. A concise synthesis that carries the argument into the next chapter.

The manuscript is an informative systems book, not a course. Chapters should
not contain exercises, labs, quizzes, learning objectives, or reader homework.
Commands and traces may appear when they explain real behavior, but they should
be presented as annotated evidence rather than step-by-step practice.

Use the following labels whenever needed:

- **Implemented** — verified in the repository or documented runtime.
- **Experimental** — present but incomplete, unstable, or narrowly scoped.
- **Compared** — implemented by another project or research system.
- **Proposed** — design work not yet implemented.

## 8. Part and Chapter Requirements

## Part 0 — Agent Sandbox Architectures

Part 0 is an eight-chapter, beginner-friendly landscape survey. It uses the
analogy of a personal workshop becoming a workplace for hundreds or thousands
of agents. It should explain categories before products and compare systems by
their unit of work, boundary, state, concurrency, auditability, lifecycle, and
return path.

### 0. Agent Workloads and the Runtime Substrate

Introduce the vision: today’s OS and filesystem help a human operate a personal
computer, while large populations of agents need a new runtime layer with
private workspaces, identity, resource budgets, history, recovery,
orchestration, and controlled publication. Define the two agent-placement modes:
an in-sandbox agent and an external agent using sandboxed tool execution.
Clarify that Sandbox-as-a-Service is a delivery model that can support either
placement.

### 1. Sandboxing in Coding-Agent Products

Compare coding-agent-provided and agent-specific sandboxes: Claude Code, Codex,
Docker Sandboxes, Copilot, Gemini CLI, Cursor, and Jules. Separate permissions,
worktrees, process sandboxes, containers, cloud runtimes, and microVMs.

### 2. On-Demand Cloud Sandboxes

Explain on-demand cloud sandboxes through E2B, Daytona, Modal, Cloudflare, and
CubeSandbox. Cover templates, lifecycle, persistence, pause/resume, snapshots,
cleanup, and artifact return. Contrast local embedded sandboxes briefly.

### 3. Browser and Computer-Use Sandboxes

Cover browser sessions, persistent profiles, computer-use environments, and
all-in-one sandboxes through Browserbase, Steel, Kernel, Browserless, and AIO
Sandbox. Explain authenticated state, recordings, downloads, and human takeover.

### 4. RL and Evaluation Sandboxes

Explain RL and evaluation environments through CubeSandbox and DeltaBox.
Use MCTS rollouts to show why checkpoint, restore, and private branching matter.
Distinguish the sandbox substrate from the external search policy, episode,
verifier, reward, and rollout fabric.

### 5. Filesystem Branching and Runtime Checkpointing

Cover agent filesystems, state capsules, branches, snapshots, checkpointing,
rollback, and external-side-effect limits through AgentFS, BranchFS, DeltaBox,
CubeSandbox, Crab, and related systems.

### 6. Meta-Agent Runtimes, Control Planes, and Fleets

Separate meta-agent execution semantics, sandbox control planes, remote
execution, and fleet scheduling. Use SHEPHERD, Kubernetes Agent Sandbox,
OpenSandbox, Sandbox0, Crabbox, SWE-ReX, Kelos, AX, and Agent Substrate as
representative systems.

### 7. Workspace Isolation, Changesets, and Publication

Explain why isolation is not collaboration. Compare values, artifacts, patches,
branches, changesets, and publication. Place Ephemeral Sandbox in the landscape
as the Volume I case study for private parallel workspaces and explicit
publication.

Part 0 must remain informative rather than promotional. It should contain
strong diagrams and comparison tables, no product ranking, installation guide,
exercise, or setup tutorial.

## Part I — The Problem

### 8. Agents Are Processes with Side Effects

Explain why an agent needs filesystem, process, network, and resource
boundaries.

### 9. Why Parallel Coding Agents Collide

Cover shared checkouts, dependency changes, port conflicts, stale tests, and
ambiguous ownership.

### 10. The Workspace Contract

Define:

- project base;
- LayerStack;
- sandbox;
- workspace session;
- private delta;
- changeset;
- publication;
- artifact.

### 11. What Ephemeral Sandbox Is—and Is Not

Clarify that v1 provides workspace isolation for cooperating agents, not
hardened hostile-tenant isolation.

## Part II — Reading the System

### 12. From Agent Request to Runtime

Trace the complete request path:

```text
CLI/MCP → catalog → client → protocol → gateway → manager → daemon → runtime
```

### 13. Contracts Before Transports

Explain operation contracts, catalogs, routes, request envelopes, response
envelopes, and compatibility.

### 14. Gateway, Manager, and Daemon

Separate composition, lifecycle management, sandbox execution, and runtime
behavior.

### 15. CLI, MCP, and the Agent-Facing Interface

Explain why management, runtime, and observability are separate surfaces and
how an agent should interact with each one.

## Part III — Shared History, Private Workspaces

### 16. LayerStack: Immutable Shared History

Cover content-addressed layers, manifests, root hashes, leases, active heads,
and storage ownership.

### 17. Copy-on-Write Workspace Sessions

Explain how agents receive private writable views over a shared base without
repeatedly cloning the project.

### 18. Overlay Mounts and Namespace Holders

Cover mount lifecycle, holder processes, namespace file descriptors, and
remount behavior.

### 19. Shared and Isolated Network Profiles

Explain shared networking, isolated networking, veth pairs, bridge allocation,
and per-session port behavior.

### 20. Commands, PTYs, and Process Lifecycle

Cover shell execution, stdin, output streaming, transcript windows, process
groups, timeouts, and cleanup.

## Part IV — From Runtime State to Published Work

### 21. Capturing a Workspace

Explain how filesystem mutations become a changeset.

### 22. Publish-Time Resolution

Cover base revision, active revision, command changes, protected paths, and
route preparation.

### 23. Three-Way Merge and Conflict Semantics

Cover line-level merging, binary and oversized-file limitations, source
conflicts, and rejection reasons.

### 24. Provenance and File Blame

Explain structural line origins, ownership attribution, file history, and
reviewability.

### 25. Publish, Reject, Rebase, or Destroy

Explain why rejection is normal control flow and why publication must be
all-or-reject.

### 26. Squashing, Leases, and Layer Garbage Collection

Cover autosquash, active sessions, storage cleanup, remount sweeps, and lease
safety.

## Part V — Seeing and Operating the Runtime

### 27. Observability as a First-Class Runtime Surface

Cover events, traces, snapshots, diagnostics, and query boundaries.

### 28. Resource Isolation

Cover cgroups, CPU and memory accounting, disk usage, process topology, and
workload reserves.

### 29. Teardown, Failure, and Recovery

Cover holder exits, retryable cleanup, stale generations, failed remounts, and
shutdown transactions.

### 30. Configuration and Platform Boundaries

Cover Linux, macOS, Windows, Docker, Multipass, YAML configuration, and
provider-specific behavior.

### 31. Testing the Agent Workspace

Cover unit tests, contract tests, integration tests, live CLI/MCP tests, and
external benchmark repositories.

### 32. Benchmarking Parallel Agents

Compare worktrees, copied sandboxes, and LayerStack-backed sessions across
concurrency, latency, conflict rate, storage, and human-review effort.

## Part VI — The Boundary of Version 1

### 33. What Version 1 Solves

Summarize reliable parallel workspace isolation, execution boundaries,
publication, provenance, and observability.

### 34. What Version 1 Deliberately Does Not Solve

Discuss microVM tenancy, credential brokering, unrestricted hostile workloads,
durable process checkpoints, fleet scheduling, and browser-state isolation.

### 35. The Next Runtime Boundary

Point toward Volume II without attempting to design the entire future system in
Volume I.

## 9. Appendices

- **Appendix A:** Repository and crate map
- **Appendix B:** Operation catalog reference
- **Appendix C:** LayerStack and manifest concepts
- **Appendix D:** CLI and MCP cookbook
- **Appendix E:** Benchmark methodology
- **Appendix F:** Security limitations and deployment guidance

## 10. Narrative Arc

> Problem → architecture → state → execution → publication → observability →
> limits.

Volume I should remain grounded in the current repository. The larger bounded
agent runtime—credentials, durable execution, fleet scheduling, hostile-tenant
security, and browser state—belongs in Volume II.
