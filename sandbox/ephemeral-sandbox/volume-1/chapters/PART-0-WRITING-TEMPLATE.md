# Part 0 Editorial Blueprint: Agent Sandbox Architectures

## Phase 1 Editorial Decision Record

Part 0 remains an eight-chapter landscape survey, numbered 0–7. The category
boundaries are useful, and removing a chapter would either blur a real
architectural distinction or force unnecessary renumbering throughout Volume I.
The reading-time target is met by cutting repeated explanation inside the
chapters, not by cutting an essential category.

| Topic | Keep / cut / merge | Reason |
| --- | --- | --- |
| Chapters 0–7 | Keep | The sequence moves cleanly from workload and placement to execution, state, orchestration, and publication while preserving the existing Volume I numbering. |
| Repeated workshop analogy | Merge | Use it for the Chapter 0 hook and only brief callbacks later; repeated mappings made the outline feel academic and slowed the landscape tour. |
| Six recurring infrastructure problems | Keep, compress | Introduce them once in Chapter 0, then demonstrate them through incidents instead of restating the list in every chapter. |
| Chapter 0 architecture inventories | Merge | Replace the ten-layer catalog and three large tables with two placement modes, one minimum-substrate figure, and one compact comparison. |
| Coding-agent product walkthroughs | Cut to examples | Use Codex, Claude Code, Docker Sandboxes, and brief supporting examples to distinguish policy, worktree, process, container, and microVM boundaries. |
| Cloud sandbox profiles | Merge by lifecycle choice | Compare fresh allocation, pause/resume, snapshot, and return paths; avoid one mini-chapter per vendor. |
| Browser product list | Cut to examples | Keep profile persistence, live interaction, audit, and output as the category story; products illustrate those choices. |
| RL product list | Cut to CubeSandbox and DeltaBox | Use the two systems to explain service-level microVM branching and coordinated file/process rewind; keep search policy, verifier, and trainer as separate layers. |
| Filesystem and checkpoint products | Merge by state coverage | Contrast file history, process checkpoints, and external effects; retain products only where they make one boundary concrete. |
| Meta-agent, control-plane, and fleet inventories | Keep distinction, cut catalog | The three roles must remain separate, but a single scenario and compact comparison can establish them. |
| Publication chapter | Keep and focus | It supplies the return-path conclusion and the transition to Ephemeral Sandbox without duplicating later LayerStack internals. |
| Comparison tables | Cut from 18 to 8 | One table per chapter is enough; tables are reserved for repeated fields that are genuinely clearer side by side. |
| Figures | Cut from 13 to 10 | Fold rollout branching into the Chapter 4 MCTS figure; remove the redundant shared-base/private-delta and failure-reassignment figures. |
| Formal product-profile template | Keep as an editorial check | Apply its nine required questions to any named profile, but express most products as short, sourced examples rather than form-like subsections. |

### Revised Part 0 Structure and Prose Budget

| Chapter | Technical title | Narrative job | Prose target |
| ---: | --- | --- | ---: |
| 0 | Agent Workloads and the Runtime Substrate | Hook, two placement modes, and the minimum runtime contract | 1,100 words |
| 1 | Sandboxing in Coding-Agent Products | Separate permissions, workspaces, and execution boundaries | 850 words |
| 2 | On-Demand Cloud Sandboxes | Explain template, lifecycle, private state, and return path | 850 words |
| 3 | Browser and Computer-Use Sandboxes | Show why interactive identity and UI state extend the sandbox | 750 words |
| 4 | RL and Evaluation Sandboxes | Distinguish a task sandbox from an episode and rollout fabric | 850 words |
| 5 | Filesystem Branching and Runtime Checkpointing | Compare save domains and expose irreversible side effects | 850 words |
| 6 | Meta-Agent Runtimes, Control Planes, and Fleets | Separate supervision, lifecycle, and placement at scale | 850 words |
| 7 | Workspace Isolation, Changesets, and Publication | Make controlled return the conclusion and enter the case study | 1,000 words |
| **Total** |  |  | **7,100 words** |

At roughly 160 words per minute, 7,100 words take about 44 minutes to read.
Ten figures and eight compact tables add approximately 5–8 minutes of visual
reading, producing the requested 45–55 minute experience.

## Part 0 Decision

Part 0 begins with a concrete failure on a familiar computer, tours the main
sandbox categories through incidents and contrasts, and ends with the
publication boundary and the Ephemeral Sandbox case study.

The chapters are:

| Chapter | Technical title | Sandbox category |
| --- | --- | --- |
| 0 | Agent Workloads and the Runtime Substrate | Vision and landscape map |
| 1 | Sandboxing in Coding-Agent Products | Coding-agent-provided sandboxes |
| 2 | On-Demand Cloud Sandboxes | Task and session sandbox services |
| 3 | Browser and Computer-Use Sandboxes | Interactive browser and desktop state |
| 4 | RL and Evaluation Sandboxes | Training environments and rollout systems |
| 5 | Filesystem Branching and Runtime Checkpointing | State, branch, snapshot, and rollback systems |
| 6 | Meta-Agent Runtimes, Control Planes, and Fleets | Supervision, lifecycle, orchestration, and scheduling |
| 7 | Workspace Isolation, Changesets, and Publication | Parallel work and controlled integration |

This replaces the previous plan to put the entire landscape in one Chapter 0.

## Phase 2 Naming Convention

| Preferred term | Meaning |
| --- | --- |
| Agent runtime | The component that calls the model, chooses actions, and incorporates observations |
| Sandbox environment | The isolated environment containing tools, processes, browser state, and workspace state |
| Execution protocol | The request, stream, and result boundary from an external agent runtime to a sandbox environment |
| Workspace | The private project files and related state |
| Execution worker | The sandbox-side component that performs requested operations; it is not an agent runtime |

Classify placement by asking where the model → tool → observation → next-model-call
cycle runs. Inside the sandbox environment means an **in-sandbox agent**. Outside
means an **external agent with sandboxed tool execution**. These are the only two
placement modes. Sandbox-as-a-Service is a delivery model, not a third mode.

## Phase 2 Figure Design List

| Figure | One question it answers | Maximum visible components | Components to remove or merge |
| --- | --- | ---: | --- |
| 0.1 Human-to-Agent Runtime Transition | Why does one human-oriented computer become inadequate for many agents? | 3 scenes | Keep the existing label-free illustration; its visual transition is already immediate. |
| 0.2 Agent Runtime Reference | What is the minimum substrate that carries private work to a controlled return? | 5 | Merge policy, control plane, scheduler, execution session, state, isolation, and observability into four stages plus the surrounding session-history-and-policy frame. |
| 0.3 Agent Placement Modes | Where does the agent runtime run in each of the only two placement modes? | 5 per mode | Remove lifecycle panels, optimization claims, return-path lists, and worker subcomponents; demote the remote model service to a note. |
| 1.1 Isolation Boundaries | Which boundary prevents which kind of collision? | 5 | Keep the five boundary choices but remove the dense per-boundary matrix and decorative icons. |
| 2.1 Sandbox Lifecycle | Which state transitions decide whether private work survives? | 5 | Merge template and allocation, merge pause with retained state, and move exceptional detail into the caption. |
| 3.1 Browser Session State | Which interactive state is temporary, which is retained, and what can leave? | 5 | Merge browser, display, shell, and files into one sandbox environment; merge takeover into the access boundary. |
| 4.1 MCTS Rollouts over Checkpointed Sandboxes | How do selection, restore, private expansion, evaluation, and backpropagation reuse sandbox state? | 5 | Replace the incorrect linear stack with one search tree, one external control loop, one verifier, and a substrate boundary naming CubeSandbox and DeltaBox. |
| 4.2 Rollout Branching and Selection | How are alternative attempts selected? | 0 — merged | Merge its unique conclusion into Figure 4.1 rather than keeping a second RL figure. |
| 5.1 Shared Base and Private Deltas | How can sessions share a base without sharing unfinished edits? | 0 — cut | Remove the figure; Chapter 7's publication figure covers this relationship where it matters. |
| 5.2 State Coverage and External Effects | What can a restore operation rewind? | 5 | Merge conversation and tool metadata, combine file/process/runtime state into a checkpoint domain, and group irreversible effects as the external world. |
| 6.1 Meta-Agent over a Reversible Worker Trace | How can a supervisor observe, intercept, revert, and fork a worker? | 6 | Use the supplied SHEPHERD Figure 1 directly with attribution; keep lifecycle control and fleet placement separate in the surrounding prose. |
| 6.2 Failure Recovery and State Reassignment | What survives a worker failure? | 0 — cut | Remove the figure; retained workspace and session history are already explicit in Figure 6.1 and the prose scenario. |
| 7.1 Publication and Provenance | How does private work become—or fail to become—shared history? | 5 | Merge capture and comparison, merge provenance boxes into session history, and keep accepted/rejected outcomes as one decision component. |

The final inventory is two raster illustrations and eight editable SVG diagrams:
ten figures total. Every SVG retains a machine-readable `title`, `desc`, and
ARIA references, uses the existing palette, and carries implementation detail
in its caption and surrounding prose rather than in the drawing.

## The Vision

Use this as the central idea of Part 0:

> Today’s computers are organized around human users: people start programs,
> arrange files, notice conflicts, and decide what to keep. AI agents can work
> in much larger numbers, run many speculative tasks at once, and produce
> changes faster than a human can supervise them.
>
> To unlock that capacity, computers need an agent-facing runtime layer. It must
> provide private workspaces, stable identity, resource control, complete
> history, recovery, and a safe path from private results to shared work.
>
> Brief analogy: the OS provides a personal workshop; the agent runtime turns it
> into a managed facility for many workers.

The phrase **agent operating system** can be used as the vision, but explain
that it does not necessarily mean replacing Linux, Windows, or macOS. It may be
a new runtime layer built above existing operating systems, filesystems,
containers, VMs, and cloud schedulers.

## Reference Architecture

![Agent runtime reference architecture](../assets/diagrams/part-0/00-agent-runtime-reference.svg)

This is the minimum substrate, not a claim that one current product implements
every concern. The agent runtime acts through a sandbox environment over a
private workspace and tools. Return or publication is a separate transition.
Session history and policy surround the path so work can be attributed,
recovered, accepted, or rejected.

## Chapter Keynotes and Visual Budget

Use technical chapter titles. Keep each analogy to a short opening paragraph or
one labeled figure.

| Chapter | Keynote | Brief analogy | Diagrams | Comparison tables |
| --- | --- | --- | ---: | ---: |
| 0 | Existing OS and filesystem primitives need an agent-native runtime layer for concurrency, auditability, recovery, and controlled sharing. | One-person workshop becomes a multi-worker facility. | 3 | 1 |
| 1 | Coding-agent products combine several different boundaries: permissions, worktrees, process sandboxes, cloud runtimes, and microVMs. | House rules, separate desks, and separate rooms. | 1 | 1 |
| 2 | A cloud sandbox is an on-demand computer with an explicit template, lifecycle, state policy, and return path. | A prepared hotel room for one job. | 1 | 1 |
| 3 | Browser and computer-use sandboxes isolate interactive identity and UI state, not only code execution. | A borrowed office with a reusable identity case. | 1 | 1 |
| 4 | RL infrastructure manages repeatable episodes, rewards, trajectories, and large rollout populations—not merely fast task execution. | Many identical training fields with judges. | 1 | 1 |
| 5 | Filesystem branches and checkpoints cover different portions of state and cannot rewind external side effects. | Transparent layers and save points. | 1 | 1 |
| 6 | Meta-agent traces, lifecycle control planes, and fleet schedulers are separate layers that compose at scale. | Supervisor, workshop manager, and control tower. | 1 | 1 |
| 7 | Workspace isolation becomes collaboration only through capture, conflict handling, provenance, and explicit publication. | An inspection gate for shared work. | 1 | 1 |
| **Total** |  |  | **10** | **8** |

## The Workshop Analogy

Reuse the same objects throughout Part 0:

| Workshop object | Agent-runtime meaning |
| --- | --- |
| Private workbench | Sandbox environment and workspace |
| Worker's badge | Agent and session identity |
| Power allowance | CPU, memory, disk, network, and time budget |
| Logbook | Session history, provenance, and audit |
| Inspection gate | Capture, review, and publication |

Use the analogy first, then give the precise technical term. Do not stretch an
analogy beyond the point where it helps.

## Problems Introduced in Part 0

Part 0 should repeatedly return to six problems:

1. **Concurrency:** Many agents can edit the same files, use the same ports, or
   change shared dependencies at the same time.
2. **Auditability:** We need to know which agent did what, from which starting
   state, with which tools, and with what result.
3. **Cost and density:** Giving every short task a large permanent machine does
   not scale to thousands of agents.
4. **Reproducibility:** A result is hard to trust when its starting state and
   environment cannot be reconstructed.
5. **Recovery and exploration:** Agents need to try, fail, rewind, fork, and
   compare alternatives cheaply.
6. **Publication:** Private work should not silently become shared truth.

Security remains important, but do not let the introduction reduce the whole
landscape to hostile-code containment. Agent sandboxes also solve state,
parallelism, lifecycle, cost, observability, and coordination problems.

## Part-Wide Demonstration

Use one task in every chapter:

> Update a dependency, modify one source file, run the test suite, open the
> resulting application in a browser, and return the proposed change.

Each chapter changes the environment around that task:

- one agent performs it locally;
- one agent receives a disposable cloud computer;
- one agent uses a browser and desktop;
- thousands of rollouts repeat and score variations of it;
- several branches try alternative fixes;
- a meta-agent supervises the attempts;
- one accepted result passes through a publication gate.

This keeps the landscape understandable. Readers compare the worlds around the
agent rather than unrelated product feature lists.

# Chapter 0 — Agent Workloads and the Runtime Substrate

## Purpose

Explain why agent sandboxes are becoming a distinct infrastructure layer. Start
with the personal workshop and gradually fill it with digital workers.

## Sections

### 0.1 The Personal Computer Is a Personal Workshop

Explain how today’s OS and filesystem support a human who starts programs,
chooses filenames, notices conflicts, and manually decides what becomes shared.
This is not a criticism of existing operating systems; it identifies the human
assumptions built around their use.

### 0.2 When a Thousand Workers Arrive

Show what changes when agents start jobs continuously, work in parallel, and
explore several paths. Introduce concurrency, cost, and lifecycle pressure in
plain language.

### 0.3 The Mystery of the Changed File

Tell a short incident in which several agents produce a correct-looking result,
but nobody can establish which base, dependency set, or process generated it.
Introduce auditability through the workshop logbook analogy.

### 0.4 A Private Workbench Is Necessary but Not Sufficient

Isolation prevents some collisions, but a complete system also needs identity,
budgets, history, recovery, scheduling, and a return path.

### 0.5 Where the Agent Runtime Runs

Define the placement test precisely as:

```text
model call → tool decision → tool execution → observation → next model call
```

Present exactly two placement modes, classified by where the agent runtime
executes this cycle:

1. **In-sandbox agent (sandbox-hosted agent):** the agent runtime, tool
   execution, and workspace run inside the sandbox. The model service may still
   be remote.
2. **External agent with sandboxed tool execution (externally orchestrated
   sandbox):** the agent runtime runs outside and invokes an execution worker
   inside the sandbox through an execution protocol.

Do not introduce another placement mode. An execution daemon, MCP server, PTY
holder, or tool worker inside an externally orchestrated sandbox carries out
requests but does not own the model-to-tool decision cycle. In nested systems,
classify each agent runtime independently.

Clarify that **Sandbox-as-a-Service** is a delivery model, not an agent-placement
mode: a managed sandbox service can support either placement.

Use Anthropic Managed Agents only as a short supporting example. State that its
architecture separates external orchestration and durable session history from
sandboxed tool execution. Do not expand into a product walkthrough.

### 0.6 The Agent-Native Runtime Substrate

Introduce the vision without prescribing one implementation. Define the
capabilities the rest of Part 0 will discover:

```text
private workbench
    + identity
    + bounded tools and resources
    + recoverable state
    + complete activity history
    + orchestration
    + controlled publication
```

### 0.7 The Map of the Sandbox Landscape

Preview Chapters 1–7. Explain that each category solves a different part of the
workshop problem.

## Diagrams

### Figure 0.1 — Human-to-Agent Runtime Transition

Show the transition from one human workstation to a managed population of
private agent workspaces. Use this as the chapter-opening conceptual
illustration; do not depend on it for exact labels.

### Figure 0.2 — Agent Runtime Reference Architecture

Show only the agent runtime, sandbox environment, workspace and tools, and
return or publication, surrounded by session history and policy.

### Figure 0.3 — Two Agent Placement Modes

Use two side-by-side topologies. The left places the agent runtime inside the
sandbox environment. The right keeps the agent runtime outside and sends
requests through an execution protocol. Show that the model service can remain
remote in both modes and that the execution worker in the second mode is not
another agent runtime.

## Tables

### Table 0.1 — Agent Placement Modes

| Dimension | In-sandbox agent | External agent with sandboxed tool execution |
| --- | --- | --- |
| Agent runtime | Runs inside the sandbox environment. | Runs in an external runner or orchestrator. |
| Sandbox responsibility | Hosts decisions, tools, processes, and workspace state. | Executes requested operations and owns local processes and workspace state. |
| Tool interaction | Direct syscalls, local APIs, PTYs, and filesystem access. | Versioned execution protocol, streams, artifacts, and state references. |
| Latency | Low latency for frequent local tool use. | Adds transport latency and serialization. |
| Tool compatibility | Existing CLI agents usually work with fewer adapters. | Interactive and stateful tools require explicit remote semantics. |
| Failure recovery | Agent runtime may fail with the sandbox unless its state is exported. | External agent runtime can replace or reconnect to the sandbox. |
| Credentials | Model and service credentials may enter the sandbox unless proxied. | Credentials can remain with the runner, vault, or policy proxy. |
| Orchestration | Agent is naturally attached to one environment. | One runner can coordinate several environments. |
| Sandbox image | Includes the agent harness and its dependencies. | Can contain only the execution worker and workload tools. |
| Main trade-off | Locality and compatibility versus a larger coupled failure domain. | Centralized control and replaceability versus distributed-systems complexity. |

## Chapter Ending

> The sandbox landscape exists because a private room is only one part of the
> future agent computer. The next chapters visit the different rooms, tools,
> arenas, and control systems being built today.

# Chapter 1 — Sandboxing in Coding-Agent Products

## Category

Developer-facing coding agents and the execution boundaries bundled with or
designed specifically for them.

## Representative Systems

- Claude Code local sandbox, worktrees, and cloud sessions;
- Codex local sandbox, worktrees, and cloud environments;
- Docker Sandboxes as a microVM substrate that can host several coding agents;
- GitHub Copilot local and cloud sandboxes;
- Gemini CLI process, container, and worktree options;
- Cursor and Jules as additional hosted-agent comparisons.

Clarify early that Claude Code and Codex are agent products spanning several
execution modes, while Docker Sandboxes is an execution substrate that hosts
agents. A worktree separates working copies but is not a security boundary.

## Sections

### 1.1 House Rules, Separate Desks, and Separate Rooms

Use three analogies:

- permissions are house rules;
- a worktree is a separate desk with another copy of the project;
- an OS sandbox, container, or microVM is a more strongly separated room.

### 1.2 Claude Code: One Product, Several Boundaries

Separate the agent interface, local command sandbox, worktree mechanism, and
hosted execution environment.

### 1.3 Codex: Local, Worktree, and Cloud Worlds

Use the same decomposition so the comparison remains fair.

### 1.4 Docker Sandboxes: Give the Agent Its Own Machine

Explain the microVM boundary, private Docker daemon, and the difference between
a live host-workspace mount and a private clone.

### 1.5 Other Coding-Agent Approaches

Briefly compare Copilot, Gemini CLI, Cursor, and Jules. The goal is to reveal
design patterns, not catalog every coding agent.

### 1.6 What Can Still Cross the Wall?

Discuss workspace files, Git metadata, credentials, network traffic, caches,
Docker access, local services, and approval escape paths.

## Diagrams

- **Figure 1.1 — Isolation Boundary Levels:** permission policy, worktree,
  process sandbox, container, and microVM; use house rules, desks, and rooms as
  the brief analogy.

## Comparison Table

- **Table 1.1 — Boundary, Placement, and Outcome:** boundary mechanism,
  agent placement, private state, lifecycle, auditability, return path, and the
  important guarantee each example does not provide.

## Chapter Ending

> Coding agents can bring their own house rules or even their own room. But many
> builders do not want to operate those rooms themselves; they want to request
> one through an API.

# Chapter 2 — On-Demand Cloud Sandboxes

## Category

On-demand sandbox computers created through an API for a task or session.
"One-shot" describes the common usage pattern, not a guarantee that the system
is stateless or cannot pause, resume, or snapshot.

## Representative Systems

- E2B;
- Daytona;
- Modal Sandboxes;
- Cloudflare Sandbox SDK;
- CubeSandbox as a bridge from task sandboxes toward cheap pause, snapshot,
  clone, and rollback;
- local embedded alternatives such as BoxLite, WebContainers, Wasmtime/WASI,
  and restricted interpreters as a short contrast.

## Sections

### 2.1 The Hotel-Room Model

The agent checks into a prepared room, performs a job, takes its outputs, and
checks out. Explain templates, images, sandbox identity, timeout, and cleanup.

### 2.2 What Does "Fresh" Actually Mean?

Distinguish a new process, clean filesystem, prepared template, cached image,
restored snapshot, and resumed machine.

### 2.3 E2B: The Sandbox as an API

Explain the template-to-sandbox lifecycle and command, filesystem, process, and
port surfaces.

### 2.4 Daytona: A Composable Computer

Explain container and VM choices, persistence, pause/resume, snapshots, and
forking without turning the section into an SDK guide.

### 2.5 Modal, Cloudflare, and CubeSandbox

Use these systems to show different identities, lifecycle models, and state
choices. Mark vendor-reported performance numbers as such.

### 2.6 A Sandbox Without Renting a Cloud Machine

Briefly explain local embedded approaches. A restricted interpreter, Wasm
instance, browser runtime, and embedded microVM all avoid the same cloud round
trip but provide very different compatibility and security boundaries.

### 2.7 Returning the Work

Compare stdout, files, artifacts, previews, snapshots, branches, and patches.
Emphasize that most task sandbox APIs leave merge and publication to another
layer.

## Diagrams

- **Figure 2.1 — Sandbox Lifecycle State Machine:** prepare, allocate, run,
  retain outputs, pause, resume, or destroy; use a hotel room as the brief
  analogy.

## Comparison Table

- **Table 2.1 — Lifecycle, State, and Return:** sandbox unit, agent placement,
  isolation, private state, pause or snapshot behavior, concurrency,
  auditability, returned output, and important non-guarantee.

## Chapter Ending

> A task sandbox gives one agent a computer. Training changes the problem: now
> the system must create, reset, score, and record enormous numbers of attempts.

# Chapter 3 — Browser and Computer-Use Sandboxes

## Category

Browser sessions, computer-use environments, and all-in-one tool-rich
sandboxes.

## Representative Systems

- Browserbase;
- Steel;
- Kernel;
- Browserless;
- AIO Sandbox;
- E2B Desktop or comparable desktop environments;
- Anthropic's computer-use reference container as a pedagogical non-production
  baseline.

## Sections

### 3.1 A Browser Is More Than a Process

Introduce tabs, cookies, local storage, downloads, profiles, authentication,
display state, and input state.

### 3.2 Borrowed Browser versus Persistent Identity

Use a hotel-browser analogy: the room may be disposable while a locked travel
case—the profile—moves between stays.

### 3.3 Browser Session Infrastructure

Compare Browserbase, Steel, Kernel, and Browserless through session identity,
profile persistence, live view, recording, and human takeover.

### 3.4 All-in-One Environments

Use AIO Sandbox to explain why browser, shell, files, notebook, MCP, and editor
may need to share one coherent session.

### 3.5 What Leaves a Computer-Use Sandbox?

Compare extracted data, screenshots, recordings, downloads, retained profiles,
and code changes. Make clear that a browser artifact is not automatically a
published project change.

### 3.6 The Credential and Audit Problem

Explain why authenticated state needs identity, policy, redaction, history, and
careful teardown.

## Diagrams

- **Figure 3.1 — Browser and Computer-Use Session State:** browser, shell, files,
  display, durable profile, human takeover, selected outputs, and shared audit
  timeline; use a borrowed office as the brief analogy.

## Comparison Table

- **Table 3.1 — Interactive State and Return:** session unit, agent placement,
  isolation, private profile state, lifetime, concurrency, auditability,
  selected output, and important non-guarantee.

## Chapter Ending

> A browser sandbox gives an agent a world to operate. An RL sandbox goes
> further: it turns worlds into repeatable arenas with scores.

# Chapter 4 — RL and Evaluation Sandboxes

## Category

Sandbox and environment infrastructure for reinforcement learning, evaluation,
large-scale rollouts, and repeated agent exploration.

## Representative Systems

- TencentCloud CubeSandbox as a hardware-isolated sandbox service with
  snapshot, clone, and rollback operations;
- DeltaBox as a research system for coordinated file and process checkpoint
  and rollback during high-frequency state exploration.

CubeSandbox belongs here as well as in Chapter 2 because it bridges two
categories: it exposes a task-sandbox-compatible API while adding state
operations valuable for large-scale branching and training.

## Sections

### 4.1 From One Job to a Thousand Attempts

Use a training-field analogy. One task sandbox is one field. RL infrastructure
must prepare many identical fields, send agents through them, score each run,
and reset them without contaminating the next attempt.

### 4.2 The Episode Contract

Explain dataset sample, initial state, observation, action, environment step,
reward, verifier, termination, and trajectory in plain language.

### 4.3 MCTS over Materialized Sandbox State

Explain select, restore, expand, rollout, evaluate, and backpropagate. Make clear
that a tree node may name a materialized sandbox checkpoint, while the search
policy and statistics remain outside the sandbox.

### 4.4 CubeSandbox: Isolated Branches as a Service

Explain KVM microVM isolation, templates, cluster lifecycle, snapshots, clones,
and rollback. Qualify all project-reported performance claims.

### 4.5 DeltaBox: Rewinding Files and Processes Together

Explain coordinated filesystem and process checkpoint/rollback for MCTS and RL
fan-out. Qualify all author-reported latency and scaling results.

### 4.6 What the Sandbox Substrate Does Not Supply

Keep dataset, external agent runtime, selection policy, verifier, reward,
episode record, rollout scheduler, and trainer outside the two product claims.

### 4.7 Auditability at Training Scale

Connect every reward to an exact model version, starting state, tool trace,
termination reason, and verifier result. Explain how silent retries or stale
state can corrupt learning.

### 4.8 Security against Systematic Exploration

An RL policy may discover loopholes across thousands of attempts. Discuss
egress, secrets, quotas, verifier integrity, and reward hacking without turning
the chapter into a general AI-safety survey.

## Diagrams

- **Figure 4.1 — MCTS Rollouts over Checkpointed Sandboxes:** select a node,
  restore its checkpoint, fork a private branch, evaluate the leaf, and
  backpropagate the result.

## Comparison Table

- **Table 4.1 — Task Sandbox versus RL Environment:** unit, agent placement,
  isolation, reset and private state, lifecycle, concurrency, evidence, return
  path or reward, and important non-guarantee.

## Chapter Ending

> Training needs many repeatable worlds. Efficient exploration also needs those
> worlds to branch and rewind without copying everything from the beginning.

# Chapter 5 — Filesystem Branching and Runtime Checkpointing

## Category

Agent filesystems, state capsules, speculative branches, snapshots, and
checkpoint/rollback systems.

## Representative Systems

- AgentFS;
- BranchFS;
- DeltaBox;
- CubeSandbox checkpoint, clone, and rollback;
- Crab as a semantics-aware checkpoint research system;
- NoKV or AGFS as artifact/state comparisons;
- platform snapshots from E2B, Daytona, or Modal where useful.

## Sections

### 5.1 The Photocopied Blueprint

Use carbon paper or transparent layers as the analogy: every agent sees the
same base drawing but writes changes on a private sheet.

### 5.2 Files as Agent State

Explain why normal directories are familiar but weak at answering who changed
what, when, and from which base.

### 5.3 AgentFS: The Filing Cabinet Becomes a Database

Explain queryable files, key-value state, tool history, portability, and
snapshots. Clarify that a state filesystem does not automatically provide
process, network, or tenant isolation.

### 5.4 BranchFS: A Tree of Experimental Workbenches

Explain copy-on-write branches, commit, abort, and the difference between the
implemented filesystem and broader proposed branch-context semantics.

### 5.5 DeltaBox and CubeSandbox: Rewinding More Than Files

Compare filesystem-only state with filesystem plus process-memory state.

### 5.6 What a Snapshot Does Not Rewind

A restored machine cannot undo an email, payment, external database write, or
leaked credential. Make external side effects visible in the diagram.

### 5.7 Checkpoint Is Not Publication

Checkpoint chooses a state inside one execution history. Publication attempts
to make private work part of a separately advancing shared history.

### 5.8 Auditability through State History

Show how bases, deltas, checkpoints, branches, and tool events can form a
reviewable record.

## Diagrams

- **Figure 5.1 — State Coverage and External Effects:** session history,
  workspace, and process checkpoint stop at the external world; show why
  messages, payments, database writes, and credential disclosures cannot be
  rewound.

## Comparison Table

- **Table 5.1 — Save Domain and Consequence:** state unit, agent placement,
  isolation, private state, lifecycle, concurrency, auditability, return path,
  and what a restore cannot undo.

## Chapter Ending

> Once thousands of private and branching worlds exist, something must decide
> where they run, watch what happens, recover failures, and choose which paths
> continue.

# Chapter 6 — Meta-Agent Runtimes, Control Planes, and Fleets

## Category

Meta-agent execution semantics, sandbox control planes, remote execution,
leasing, warm pools, orchestration, and high-density agent fleets.

## Representative Systems

- SHEPHERD for reversible traces and programmable meta-agent supervision;
- Kubernetes SIG Agent Sandbox for sandbox lifecycle objects and warm pools;
- OpenSandbox and Sandbox0 for sandbox control-plane patterns;
- Crabbox and SWE-ReX for leasing, synchronization, remote execution, and
  evidence return;
- Kelos, Google AX, Agent Substrate, and AgentScope Runtime for agent tasks,
  harnesses, actors, worker pools, and distributed execution.

Important distinction: SHEPHERD is not a Kubernetes scheduler. It exposes agent
and environment execution as reversible, manipulable history. It can sit above
the systems that place and run workers.

## Sections

### 6.1 A Workshop Needs More Than Rooms

Use the foreman analogy. Someone must assign workbenches, maintain a waiting
list, wake sleeping workers, enforce budgets, replace failed equipment, and
collect results.

### 6.2 Three Different Managers

Separate:

1. the meta-agent that observes and changes another agent's execution;
2. the control plane that creates and manages sandboxes;
3. the scheduler that places and multiplexes workloads across machines.

### 6.3 SHEPHERD: The Supervisor with a Reversible Logbook

Explain event traces, intercept, fork, replay, revert, and rewrite. Distinguish
paper capabilities from the maturity and roadmap of the installable package.

### 6.4 Sandbox Control Planes

Compare create, claim, lease, pause, resume, snapshot, route, expire, and delete
across Kubernetes Agent Sandbox, OpenSandbox, Sandbox0, E2B, and Daytona.

### 6.5 Remote Execution and Leasing

Use Crabbox and SWE-ReX to explain acquiring capacity, syncing a dirty checkout,
streaming commands, collecting evidence, and releasing the worker. Do not
describe Crabbox as the isolation boundary.

### 6.6 From Workers to Fleets

Introduce tasks, sessions, actors, worker pools, warm capacity, placement,
suspension, resumption, and multiplexing through Kelos, AX, and Agent Substrate.

### 6.7 Auditability Becomes the Control System

At thousand-agent scale, logs are not merely debugging output. Identity,
events, costs, state transitions, decisions, and retained evidence allow the
system to supervise and recover itself.

### 6.8 The Agent Runtime Stack

Present the compositional vision:

```text
meta-agent and policy
        ↓
agent harness and durable trace
        ↓
lease and remote-execution layer
        ↓
sandbox lifecycle control plane
        ↓
scheduler and warm pool
        ↓
isolation runtime
        ↓
filesystem, checkpoint, and artifact state
```

## Diagrams

- **Figure 6.1 — Meta-Agent over a Reversible Worker Trace:** a meta-agent
  creates and observes a worker, intercepts a proposed action, and chooses
  revert or fork. Use SHEPHERD Figure 1 directly and explain lifecycle control
  and fleet placement separately in the text.

## Comparison Table

- **Table 6.1 — Three Control Roles:** responsibility, unit, placement,
  lifecycle authority, concurrency function, durable evidence, return path,
  and important non-guarantee.

## Chapter Ending

> The foreman can create and supervise private work. One problem remains: how
> does a private result become trusted shared work without agents overwriting
> one another?

# Chapter 7 — Workspace Isolation, Changesets, and Publication

## Category

Workspace and publication runtimes that make the return path part of the
sandbox contract.

## Representative Systems

- Container Use as a container-plus-branch workflow with inspect, merge, apply,
  continue, and delete choices;
- Ephemeral Sandbox as the Volume I case study;
- Git worktrees and pull requests as familiar comparison mechanisms;
- NoKV-style artifact publication as a different meaning of publication;
- AgentFS, microVMs, browser sessions, and fleet managers as composable adjacent
  layers rather than competitors.

## Sections

### 7.1 Isolation Is Not Collaboration

A locked room protects private work, but it does not decide how several workers
combine edits to the same master blueprint.

### 7.2 The Return Path Is Part of the Runtime

Compare returning a value, file, artifact, patch, branch, changeset, or
publication transaction.

### 7.3 Shared Base, Private Work

Introduce immutable shared project truth and private agent workbenches in plain
language. Save LayerStack internals for later chapters.

### 7.4 Capture Before Publish

Explain why finishing a command, capturing changes, reviewing a result, and
publishing it are separate events.

### 7.5 Conflict and Rejection Are Normal

Two good agents can produce incompatible results. Rejecting publication protects
shared history and preserves reviewability.

### 7.6 Auditability Becomes Provenance

Connect each accepted line or artifact to the agent, base, session, commands,
changeset, and publication decision that produced it.

### 7.7 Ephemeral Sandbox in the Landscape

Explain why it is the case study for this volume: private copy-on-write
workspaces, capture, publication, conflict handling, provenance, and
observability. State immediately that its v1 workspace boundary for cooperating
agents is not automatically a hardened hostile-tenant microVM boundary.

### 7.8 Composing the Future Agent Computer

Show that a complete system may combine:

- a coding-agent interface;
- a cloud or local microVM boundary;
- browser or desktop tools;
- AgentFS-like queryable state;
- BranchFS- or DeltaBox-like exploration;
- a SHEPHERD-like reversible trace;
- a sandbox control plane and fleet scheduler;
- an Ephemeral Sandbox-like publication contract.

The chapter should not claim that one current product implements the entire
stack.

## Diagrams

- **Figure 7.1 — Workspace Publication and Provenance Pipeline:** shared base,
  private session, capture, comparison, resolution, all-or-reject publication,
  and the complete provenance chain.

## Comparison Table

- **Table 7.1 — Return and Publication Semantics:** value, artifact, file export,
  patch, branch, changeset, and publication compared by state model, conflict
  behavior, history, and trust assumption.

## Part 0 Closing

Use a short, non-promotional conclusion:

> Today’s sandboxes provide many of the pieces of the future agent computer:
> private rooms, disposable machines, browsers, training arenas, save points,
> supervisors, and fleets. The missing challenge is making these pieces work as
> one understandable runtime for large populations of agents.
>
> Volume I focuses on one part of that future: how parallel coding agents can
> share project truth without sharing unfinished work, and how their results can
> become reviewable, auditable shared history.

This transitions into Part I and the detailed Ephemeral Sandbox case study.

## Part-Wide Comparison Method

Every product profile and comparison table should answer the same questions:

1. What does the product call a sandbox?
2. Who is the primary user: human, agent, orchestrator, trainer, or meta-agent?
3. What is the primary unit: command, browser session, machine, episode,
   filesystem, branch, trace, workspace, task, or actor?
4. Where does it run: embedded, local, provider cloud, or customer-managed
   fleet?
5. Where does the agent runtime run: inside the sandbox environment or outside
   with sandboxed tool execution?
6. What is the enforcement mechanism: permissions, OS sandbox, restricted
   interpreter, Wasm, container, application kernel, VM, or microVM?
7. What state is private?
8. What survives stop, pause, restore, or destruction?
9. How does it handle concurrency?
10. What activity can be audited?
11. How does work leave the environment?
12. What important guarantee does it not provide?
13. What is the evidence and maturity level?

Avoid universal star ratings or a single "sandbox strength" score. A system can
be strong for host isolation and weak for publication, or excellent for RL
rollouts and unsuitable for interactive coding.

## Standard Product Profile

```markdown
### Product Name

**The simple picture:** One human-readable analogy.

**What it is:** Neutral one-paragraph description.

**Primary unit:** Command, machine, episode, browser session, branch, trace,
workspace, task, or actor.

**Boundary and placement:** What is separated from what, and where it runs.

**Agent placement:** In-sandbox agent or external agent with sandboxed tool
execution. Classify the primary model-to-tool decision loop, not helper daemons.

**State and lifetime:** What begins clean, remains private, persists, forks,
restores, or disappears.

**Concurrency and scale:** How the system behaves when many agents or attempts
run at once.

**Auditability:** Which events, traces, outputs, rewards, or provenance records
are available.

**Return path:** Value, artifact, patch, branch, changeset, publication, or
another mechanism.

**Important limit:** What readers must not infer from the word "sandbox."

**Evidence baseline:** Official documentation, repository revision or release,
paper, and date checked.
```

## Visual Style

- Use ordinary scenes—workshop, hotel room, training arena, filing cabinet,
  control tower, and inspection gate—before abstract architecture.
- Keep one visual question per diagram.
- Label agents with stable identities so readers can follow them across figures.
- Use the same colors throughout the part:
  - blue: shared or immutable state;
  - green: private mutable state;
  - orange: running work and resource use;
  - purple: capture, export, or publication;
  - red dashed lines: collision, failed transition, or boundary crossing;
  - gray: host or fleet infrastructure.
- Never depend on color alone; use icons, borders, and labels.
- Write captions as conclusions, not names. Prefer "A worktree separates edits
  but does not create a new security boundary" over "Worktree architecture."
- Use technical stack diagrams only after the analogy has established the
  mental model.

## Tone Rules

- Write for software developers who are new to agent sandbox infrastructure.
- Use plain language first and the precise systems term second.
- Explain why a category exists before listing products.
- Treat products as examples of design choices, not the chapter structure by
  themselves.
- Separate product interfaces from the runtime mechanisms behind them.
- Separate placement—local or cloud—from isolation strength.
- Separate agent-loop placement—inside or outside—from both sandbox delivery
  and isolation strength.
- Separate checkpointing from publication.
- Separate a meta-agent trace substrate from a scheduler or control plane.
- Label vendor-reported performance numbers and do not present them as
  independently reproduced benchmarks.
- Distinguish shipped products, preview features, open-source projects, and
  research prototypes.
- Keep important limits beside capabilities, not in a distant disclaimer.
- Do not include exercises, labs, quizzes, setup tutorials, or reader homework.
- Date every landscape comparison because this field changes quickly.

## Numbering Consequence

If this eight-chapter Part 0 is accepted, Part I should begin at Chapter 8 and
all later chapters in Volume I should be renumbered sequentially. Do not retain
another "Chapter 1" after Part 0; that would recreate the hierarchy confusion
this blueprint is meant to remove.

## Primary Source Ledger

Research baseline: 2026-08-02. Verify again when drafting each manuscript.

### Agent placement and remote tool execution

- Anthropic Managed Agents architecture:
  <https://www.anthropic.com/engineering/managed-agents>
- Anthropic self-hosted sandbox execution:
  <https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes>
- OpenAI Agents SDK sandbox clients:
  <https://openai.github.io/openai-agents-python/sandbox/clients/>
- OpenSandbox lifecycle and execution APIs:
  <https://github.com/opensandbox-group/OpenSandbox>

### Coding-agent-provided sandboxes

- Claude Code sandboxing: <https://code.claude.com/docs/en/sandboxing>
- Claude Code worktrees: <https://code.claude.com/docs/en/worktrees>
- Codex sandboxing: <https://learn.chatgpt.com/docs/sandboxing>
- Codex worktrees: <https://learn.chatgpt.com/docs/environments/git-worktrees>
- Docker Sandboxes: <https://docs.docker.com/ai/sandboxes/>
- Gemini CLI sandboxing: <https://geminicli.com/docs/cli/sandbox/>
- GitHub Copilot sandboxes:
  <https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes>

### On-demand cloud sandboxes

- E2B: <https://e2b.dev/docs>
- Daytona: <https://www.daytona.io/docs/en/sandboxes/>
- Modal Sandboxes: <https://modal.com/docs/guide/sandboxes>
- Cloudflare Sandbox SDK: <https://developers.cloudflare.com/sandbox/>
- TencentCloud CubeSandbox:
  <https://github.com/TencentCloud/CubeSandbox>

### Browser and computer-use sandboxes

- Browserbase contexts:
  <https://docs.browserbase.com/platform/browser/core-features/contexts>
- Steel: <https://github.com/steel-dev/steel-browser>
- Kernel: <https://www.kernel.sh/docs/integrations/overview>
- Browserless sessions:
  <https://docs.browserless.io/baas/session-management>
- AIO Sandbox: <https://github.com/agent-infra/sandbox>

### RL and evaluation environments

- CubeSandbox snapshot, clone, and rollback:
  <https://github.com/TencentCloud/CubeSandbox>
- DeltaBox paper and project page:
  <https://arxiv.org/abs/2605.22781>
  <https://dongyunpeng-sjtu.github.io/deltabox/>

### State, branching, and checkpoint systems

- AgentFS: <https://github.com/tursodatabase/agentfs>
- BranchFS: <https://github.com/multikernel/branchfs>
- DeltaBox: <https://dongyunpeng-sjtu.github.io/deltabox/>
- Crab paper: <https://arxiv.org/abs/2604.28138>
- NoKV: <https://github.com/NoKV-Lab/NoKV>

### Meta-agents, control planes, and fleets

- SHEPHERD paper: <https://arxiv.org/abs/2605.10913>
- SHEPHERD project page and Figure 1: <https://shepherd-agents.ai/>
- SHEPHERD project: <https://github.com/shepherd-agents/shepherd>
- Kubernetes Agent Sandbox:
  <https://github.com/kubernetes-sigs/agent-sandbox>
- OpenSandbox: <https://github.com/opensandbox-group/OpenSandbox>
- Sandbox0: <https://github.com/sandbox0-ai/sandbox0>
- Crabbox: <https://github.com/openclaw/crabbox>
- SWE-ReX: <https://github.com/SWE-agent/swe-rex>
- Kelos: <https://github.com/kelos-dev/kelos>
- Google AX: <https://github.com/google/ax>
- Agent Substrate: <https://github.com/agent-substrate/substrate>

### Workspace and publication runtimes

- Container Use: <https://container-use.com/environment-workflow>
- Ephemeral Sandbox:
  <https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox>
