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

## Part 0 — Overview of Agent Sandboxes in Practice

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

## Part I — The Concurrency Ceiling of Parallel Coding Agents

Show how native operating-system and filesystem abstractions expose processes,
paths, users, ports, and resource counters while leaving human developers to
supply task ownership, serialization, and publication decisions. Explain why
that implicit coordination becomes a bottleneck when many coding agents run in
parallel.

### 8. Agents Are Processes with Side Effects

Explain why an agent needs filesystem, process, network, and resource
boundaries.

### 9. Why Coding Agents Hit a Concurrency Ceiling

Explain the two common failure modes of parallel coding: direct interference
inside one shared mutable workspace, and partial observability plus late
integration across isolated workspaces coordinated through A2A messages. Use
CooperBench as evidence for the second mode without claiming that messaging is
useless or that a shared mutable checkout is the remedy. End with four explicit
challenges: private execution and publication, file and line auditability,
resource ownership, and lifecycle/recovery.

### 10. Workspace Sessions at the Tool-Call Boundary

Make the default command lifecycle prominent: an independent `exec_command`
without a `workspace_session_id` receives an automatic private workspace
session with `publish_then_destroy` finalization. Related command and file
operations share state only when the caller deliberately targets an explicit
workspace session. Also state the important exception: sessionless file writes
and edits publish an operation-attributed layer directly rather than creating
an automatic workspace session. Then define the following contract objects:

- project base;
- LayerStack;
- sandbox;
- workspace session;
- private delta;
- changeset;
- publication;
- artifact.

### 11. Ephemeral Sandbox: Raise the Concurrency Ceiling for Multi-Agent Programming

Assemble the Part I concepts into one positive product definition centered on a
workspace session per independent command tool call: shared LayerStack history,
private workspace sessions, automatic and explicit lifecycles, attributable
execution, conflict-aware publication, provenance, and observability.

## Part II — LayerStack and Shared Project History

Move from the Part I product definition into the filesystem state model that
makes private parallel work possible. The organizing idea is one sandbox, one
shared LayerStack, and many leased workspace sessions. End after defining the
automatic and explicit session lifecycles that consume LayerStack history. Part
III begins by constructing the private writable projection, then follows its
execution, capture, and publication.

### 12. One LayerStack, Many Workspace Sessions

Introduce the complete mental model: the sandbox is the managed runtime
boundary; LayerStack is durable published history; a workspace session is a
temporary writable projection of one leased history; and a command session is
one process and transcript inside that workspace. Establish four invariants:
history is shared, the execution view is leased, mutation is private, and
publication is atomic.

### 13. LayerStack: Immutable Shared History

Cover content-addressed base, published, and squashed layers; newest-first
manifests; root hashes; active heads; leases; and storage ownership. Explain why
a live workspace pins the exact lower-layer chain from which it began.

### 14. Automatic and Explicit Workspace Sessions

Explain the two workspace lifecycles. An independent command may use an
automatic `publish_then_destroy` session. A multi-operation task may target an
explicit session so commands and file operations share one stable private view.
Contrast both with sessionless snapshot reads and operation-attributed file
writes. This chapter is where the book makes the tool-call boundary precise.

## Part III — Private Workspaces and Published History

### 15. Copy-on-Write Workspace Projection

Open Part III by constructing a writable workspace from the LayerStack lease
defined in Part II. Explain how OverlayFS projects leased shared lower layers
with a private upper directory and work directory. Reads fall through to shared
history, mutations remain in the private delta, and agents avoid copying the
complete project for every task.

### 16. Namespace Holders and Command Sessions

Begin by explaining how the private COW view from Part II remains alive across
operations. Cover holder-owned mount and process namespaces, namespace file
descriptors, one-shot runners, and the lifecycle of commands inside a
workspace. Make clear that a command session tracks one process and transcript,
while filesystem finalization belongs to the containing workspace session.
End with commands settled and the private delta ready for capture.

### 17. Capturing a Workspace

Explain how filesystem mutations become a changeset.

### 18. Publish-Time Resolution

Cover base revision, active revision, command changes, protected paths, and
route preparation.

### 19. Three-Way Merge and Conflict Semantics

Cover line-level merging, binary and oversized-file limitations, source
conflicts, and rejection reasons.

### 20. Provenance and File Blame

Explain structural line origins, ownership attribution, file history, and
reviewability.

### 21. Publish, Reject, Rebase, or Destroy

Explain why rejection is normal control flow and why publication must be
all-or-reject.

### 22. Squashing, Leases, and Layer Garbage Collection

Cover autosquash, active sessions, storage cleanup, remount sweeps, and lease
safety.

## Part IV — Running and Operating the Workspace Runtime

### 23. Commands, PTYs, and Process Lifecycle

Cover shell execution, stdin, output streaming, transcript windows, process
groups, timeouts, and cleanup.

### 24. Network Profiles and Port Ownership

Explain shared and isolated networking, veth pairs, bridge allocation,
per-session port behavior, and how operators attribute occupied ports to work.

### 25. Observability as a First-Class Runtime Surface

Cover events, traces, snapshots, diagnostics, and query boundaries.

### 26. Resource Ownership and Isolation

Cover cgroups, CPU and memory accounting, workspace disk usage, changeset size,
process topology, occupied ports, workload reserves, and attribution to the
responsible sandbox, workspace, command, or operation.

### 27. Teardown, Failure, and Recovery

Cover holder exits, retryable cleanup, stale generations, failed remounts, and
shutdown transactions.

### 28. Configuration and Platform Boundaries

Cover Linux, macOS, Windows, Docker, Multipass, YAML configuration, and
provider-specific behavior.

### 29. Testing and Benchmarking Parallel Workspaces

Combine unit, contract, integration, and live CLI/MCP testing with external
benchmark repositories. Compare worktrees, copied sandboxes, and
LayerStack-backed sessions across concurrency, latency, conflict rate, storage,
resource attribution, and human-review effort.

## Part V — The Boundary of Version 1

### 30. What Version 1 Solves

Summarize reliable parallel workspace isolation, execution boundaries,
publication, provenance, and observability.

### 31. What Version 1 Deliberately Does Not Solve

Discuss microVM tenancy, credential brokering, unrestricted hostile workloads,
durable process checkpoints, fleet scheduling, and browser-state isolation.

### 32. The Next Runtime Boundary

Point toward Volume II without attempting to design the entire future system in
Volume I.

## Part VI — Reading the Implementation: From Tool Call to Workspace Runtime

Place the repository tour last. Readers should first understand the state,
lifecycle, and publication contracts that the implementation must preserve.

### 33. Following One Tool Call Through the Runtime

Trace the complete request path:

```text
CLI/MCP → catalog → client → protocol → gateway → manager → daemon → runtime
```

### 34. Contracts Before Transports

Explain operation contracts, catalogs, routes, request envelopes, response
envelopes, and compatibility.

### 35. Gateway, Manager, and Daemon

Separate composition, lifecycle management, sandbox execution, and runtime
behavior.

### 36. CLI, MCP, and the Agent-Facing Interface

Explain why management, runtime, and observability are separate surfaces and
how an agent or orchestrator should interact with each one.

## 9. Appendices

- **Appendix A:** Repository and crate map
- **Appendix B:** Operation catalog reference
- **Appendix C:** LayerStack and manifest concepts
- **Appendix D:** CLI and MCP cookbook
- **Appendix E:** Benchmark methodology
- **Appendix F:** Security limitations and deployment guidance

## 10. Narrative Arc

> Landscape → concurrency problem → shared state and private work → publication
> → operation → version boundary → implementation.

Volume I should remain grounded in the current repository. The larger bounded
agent runtime—credentials, durable execution, fleet scheduling, hostile-tenant
security, and browser state—belongs in Volume II.
