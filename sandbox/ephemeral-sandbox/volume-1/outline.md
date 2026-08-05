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

### 10. Workspace Sessions at the Tool-Call Boundary

Explain automatic `publish_then_destroy` sessions for independent commands,
explicit sessions for related command and file operations, and the sessionless
file-operation exception. Then define project base, LayerStack, sandbox,
workspace session, command session, private delta, changeset, publication, and
artifact.

### 11. Ephemeral Sandbox: Raise the Concurrency Ceiling for Multi-Agent Programming

Present Ephemeral Sandbox as one agent workspace runtime connecting shared
LayerStack history, private sessions, attributable execution, conflict-aware
publication, provenance, and observability.

## Part II — Shared History and Workspace Sessions

### 12. Workspace Session Per Tool Call

Begin with the user-visible lifecycle: automatic workspaces for independent
commands, explicit workspaces for related operations, session-ID behavior,
command sessions, and the task-scoped ownership rule. Close the chapter by
mapping the session design directly to Part I's four challenges. Organize the
opening as problem → workspace-per-tool-call response, and explain why the
private boundary must be automatic rather than an optional caller convention.

### 13. One LayerStack, Many Stable Bases

Explain how sessions share published history without sharing unfinished writes,
how leases keep starting revisions stable, and how concurrent sessions may use
different LayerStack revisions.

### 14. Inside LayerStack: Layers, Manifests, and Leases

Cover base, published, and squashed layers; newest-first path resolution;
manifest identity and root hashes; lease-aware squashing and storage ownership.

## Part III — Private Workspaces and Published History

### 15. Copy-on-Write Workspace Projection

Open Part III by turning the Part II LayerStack lease into a writable kernel
view: leased shared lower layers, private upper and work directories, read
fall-through, and private deltas without full project copies.

### 16. Namespace Holders and Command Sessions

Open Part III by keeping the Part II COW workspace alive across operations.
Cover holder-owned mount and process namespaces, namespace file descriptors,
one-shot runners, and the distinction between process completion and workspace
finalization. End with a settled private delta ready for capture.

### 17. Capturing a Workspace

How filesystem mutations become a changeset.

### 18. Publish-Time Resolution

Base revision, active revision, command changes, protected paths, and route
preparation.

### 19. Three-Way Merge and Conflict Semantics

Line-level merging, binary and oversized-file limitations, source conflicts,
and rejection reasons.

### 20. Provenance and File Blame

Structural line origins, ownership attribution, file history, and reviewability.

### 21. Publish, Reject, Rebase, or Destroy

Why rejection is normal control flow and why publication must be all-or-reject.

### 22. Squashing, Leases, and Layer Garbage Collection

Autosquash, active sessions, storage cleanup, remount sweeps, and lease safety.

## Part IV — Running and Operating the Workspace Runtime

### 23. Commands, PTYs, and Process Lifecycle

Shell execution, stdin, output streaming, transcript windows, process groups,
timeouts, and cleanup.

### 24. Network Profiles and Port Ownership

Shared and isolated networking, veth pairs, bridge allocation, port behavior,
and attribution.

### 25. Observability as a First-Class Runtime Surface

Events, traces, snapshots, diagnostics, and query boundaries.

### 26. Resource Ownership and Isolation

cgroups, CPU, memory, workspace disk use, changeset size, process topology,
occupied ports, workload reserves, and ownership attribution.

### 27. Teardown, Failure, and Recovery

Holder exits, retryable cleanup, stale generations, failed remounts, and
shutdown transactions.

### 28. Configuration and Platform Boundaries

Linux, macOS, Windows, Docker, Multipass, YAML configuration, and provider
behavior.

### 29. Testing and Benchmarking Parallel Workspaces

Unit, contract, integration, and live CLI/MCP tests, followed by comparisons of
worktrees, copied sandboxes, and LayerStack-backed sessions.

## Part V — The Boundary of Version 1

### 30. What Version 1 Solves

Reliable parallel workspace isolation, execution boundaries, publication,
provenance, and observability.

### 31. What Version 1 Deliberately Does Not Solve

MicroVM tenancy, credential brokering, unrestricted hostile workloads,
durable process checkpoints, fleet scheduling, and browser-state isolation.

### 32. The Next Runtime Boundary

Introduce the design questions that will become Volume II without solving them
inside Volume I.

## Part VI — Reading the Implementation: From Tool Call to Workspace Runtime

### 33. Following One Tool Call Through the Runtime

Follow CLI/MCP → catalog → client → protocol → gateway → manager → daemon →
runtime.

### 34. Contracts Before Transports

Operation contracts, catalogs, routes, request envelopes, response envelopes,
and compatibility.

### 35. Gateway, Manager, and Daemon

Separate composition, lifecycle management, sandbox execution, and runtime
behavior.

### 36. CLI, MCP, and the Agent-Facing Interface

Why management, runtime, and observability are separate surfaces.
