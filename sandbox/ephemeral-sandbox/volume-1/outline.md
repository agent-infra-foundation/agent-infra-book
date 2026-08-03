# Volume I Outline

## Part 0 — Overview of Agent Sandboxes in Practice

### 0. Agent Workloads and the Runtime Substrate

Use a workshop built for one person as the central analogy. Show why hundreds
or thousands of agents need private workbenches, identities, resource budgets,
logbooks, recovery, orchestration, and a controlled inspection gate. Introduce
the two placement modes: the agent runtime runs inside the sandbox environment,
or it runs outside and invokes sandboxed tool execution through a protocol.

### 1. Sandboxing in Coding-Agent Products

Compare Claude Code, Codex, Docker Sandboxes, Copilot, Gemini CLI, Cursor, and
Jules. Separate agent interfaces, permissions, worktrees, process sandboxes,
containers, cloud runtimes, and microVMs.

### 2. On-Demand Cloud Sandboxes

Explain on-demand sandbox computers through E2B, Daytona, Modal, Cloudflare,
and CubeSandbox. Cover templates, lifecycle, persistence, snapshots, cleanup,
and the path by which results leave the sandbox.

### 3. Browser and Computer-Use Sandboxes

Cover browser sessions, persistent profiles, computer-use environments, and
all-in-one sandboxes through Browserbase, Steel, Kernel, Browserless, and AIO
Sandbox.

### 4. RL and Evaluation Sandboxes

Explain how RL and evaluation sandboxes turn one environment into many scored,
repeatable attempts. Focus on CubeSandbox and DeltaBox, using MCTS rollouts to
connect checkpoint, restore, branching, verification, and backpropagation.

### 5. Filesystem Branching and Runtime Checkpointing

Cover AgentFS, BranchFS, DeltaBox, CubeSandbox, and Crab. Distinguish files,
process state, snapshots, checkpoints, branches, rollback, and publication.

### 6. Meta-Agent Runtimes, Control Planes, and Fleets

Separate meta-agent supervision, sandbox control planes, remote execution, and
fleet scheduling through SHEPHERD, Kubernetes Agent Sandbox, OpenSandbox,
Sandbox0, Crabbox, SWE-ReX, Kelos, AX, and Agent Substrate.

### 7. Workspace Isolation, Changesets, and Publication

Explain how values, artifacts, patches, branches, and changesets return from a
sandbox. Place Ephemeral Sandbox in the landscape as the Volume I case study
for private parallel workspaces and explicit publication.

## Part I — The Concurrency Ceiling of Parallel Coding Agents

Explain why native OS and filesystem primitives can run many processes but do
not encode agent tasks, stable project bases, private changesets, resource
ownership, or publication decisions. Human developers traditionally provide
that coordination; parallel agents expose its scaling limit.

### 8. Agents Are Processes with Side Effects

Why agents need filesystem, process, network, and resource boundaries.

### 9. Why Coding Agents Hit a Concurrency Ceiling

Compare two failure modes: direct interference when agents share one mutable
workspace, and partial observability with late integration when isolated agents
coordinate only through A2A messages. Use CooperBench as evidence for the
second mode, then name four explicit challenges: private execution and
publication, file and line auditability, resource ownership, and
lifecycle/recovery.

### 10. The Workspace Contract: A Workspace Session per Tool Call

Lead with the default invariant: every independent command tool call receives an
automatic private workspace session, while related calls share an explicit
multi-call session only by choice. Then define project base, LayerStack,
sandbox, private delta, changeset, publication, and artifact.

### 11. Ephemeral Sandbox: Raise the Concurrency Ceiling for Multi-Agent Programming

Present Ephemeral Sandbox as one agent workspace runtime connecting shared
LayerStack history, private sessions, attributable execution, conflict-aware
publication, provenance, and observability.

## Part II — Reading the System

### 12. From Agent Request to Runtime

Follow CLI/MCP → catalog → client → protocol → gateway → manager → daemon →
runtime.

### 13. Contracts Before Transports

Operation contracts, catalogs, routes, request envelopes, response envelopes,
and compatibility.

### 14. Gateway, Manager, and Daemon

Separate composition, lifecycle management, sandbox execution, and runtime
behavior.

### 15. CLI, MCP, and the Agent-Facing Interface

Why management, runtime, and observability are separate surfaces.

## Part III — Shared History, Private Workspaces

### 16. LayerStack: Immutable Shared History

Content-addressed layers, manifests, root hashes, leases, active heads, and
storage ownership.

### 17. Copy-on-Write Workspace Sessions

Private writable views over a shared base without repeatedly cloning the
project.

### 18. Overlay Mounts and Namespace Holders

Mount lifecycle, holder processes, namespace file descriptors, and remount
behavior.

### 19. Shared and Isolated Network Profiles

Shared networking, isolated networking, veth pairs, bridge allocation, and
per-session port behavior.

### 20. Commands, PTYs, and Process Lifecycle

Shell execution, stdin, output streaming, transcript windows, process groups,
timeouts, and cleanup.

## Part IV — From Runtime State to Published Work

### 21. Capturing a Workspace

How filesystem mutations become a changeset.

### 22. Publish-Time Resolution

Base revision, active revision, command changes, protected paths, and route
preparation.

### 23. Three-Way Merge and Conflict Semantics

Line-level merging, binary and oversized-file limitations, source conflicts,
and rejection reasons.

### 24. Provenance and File Blame

Structural line origins, ownership attribution, file history, and reviewability.

### 25. Publish, Reject, Rebase, or Destroy

Why rejection is normal control flow and why publication must be all-or-reject.

### 26. Squashing, Leases, and Layer Garbage Collection

Autosquash, active sessions, storage cleanup, remount sweeps, and lease safety.

## Part V — Seeing and Operating the Runtime

### 27. Observability as a First-Class Runtime Surface

Events, traces, snapshots, diagnostics, and query boundaries.

### 28. Resource Isolation

cgroups, CPU and memory accounting, disk usage, process topology, and workload
reserves.

### 29. Teardown, Failure, and Recovery

Holder exits, retryable cleanup, stale generations, failed remounts, and
shutdown transactions.

### 30. Configuration and Platform Boundaries

Linux, macOS, Windows, Docker, Multipass, YAML configuration, and provider
behavior.

### 31. Testing the Agent Workspace

Unit tests, contract tests, integration tests, live CLI/MCP tests, and external
benchmark repositories.

### 32. Benchmarking Parallel Agents

Compare worktrees, copied sandboxes, and LayerStack-backed sessions across
concurrency, latency, conflict rate, storage, and human-review effort.

## Part VI — The Boundary of Version 1

### 33. What Version 1 Solves

Reliable parallel workspace isolation, execution boundaries, publication,
provenance, and observability.

### 34. What Version 1 Deliberately Does Not Solve

MicroVM tenancy, credential brokering, unrestricted hostile workloads,
durable process checkpoints, fleet scheduling, and browser-state isolation.

### 35. The Next Runtime Boundary

Introduce the design questions that will become Volume II without solving them
inside Volume I.
