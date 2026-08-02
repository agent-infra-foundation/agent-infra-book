# Part 0 — Agent Sandbox Architectures

Landscape sources checked 2026-08-02. Product capabilities below are described
from primary documentation and project repositories. Performance or maturity
claims are attributed to their authors. Capabilities reported by a vendor are
vendor-reported, not independent guarantees.

## Chapter 0 — Agent Workloads and the Runtime Substrate

### The computer that worked for one person

A developer opens a familiar laptop and asks three coding agents to help with
one dependency update. The first agent edits the manifest. The second changes a
source file against the old dependency. The third starts the test server on the
same port the first agent is using. Minutes later, every agent reports progress.
The checkout contains a mixture of their edits, the lockfile reflects only one
attempt, and nobody can say which server produced the screenshot in the final
message.

Nothing exotic failed. The operating system did exactly what it was designed
to do: it let one user start processes and modify files. The filesystem kept
the latest bytes. The shell inherited the user's environment. Git recorded
nothing until somebody chose to commit. The missing component was the human
who normally notices collisions, remembers which terminal owns a process, and
decides what work is safe to keep.

Hundreds of agents turn those informal human duties into infrastructure
requirements. Each attempt needs a private place to edit and run tools, a
stable identity, bounded resources, a reconstructable starting state, a useful
history, and a deliberate route back to shared work. A sandbox environment
provides part of that answer. It contains the tools, processes, browser state,
and workspace state that belong to an execution. An agent runtime calls the
model, chooses actions, and incorporates observations. The two are related,
but they are not the same component.

> *💡 **Core principle:** A sandbox environment contains execution state; an
> agent runtime owns the decision cycle.*

![A personal computer becomes a managed population of agent workspaces](../assets/illustrations/part-0/00-human-to-agent-runtime.png)

*Figure 0.1 — One human can coordinate a personal computer informally; a
population of agents needs explicit private work, control, and return paths.*

### Exactly two placement modes

The first architectural question is where the agent runtime runs. Use one test:

> *🧭 **Placement test:** Where does the model → tool → observation →
> next-model-call cycle run?*

**There are exactly two answers.**

In an **in-sandbox agent**, the agent runtime runs inside the sandbox
environment with its tools, processes, and workspace. Calls to a remote model
service do not change that classification. The component that interprets the
model response, selects a tool, receives the result, and prepares the next
model call remains inside.

In an **external agent with sandboxed tool execution**, the agent runtime runs
outside the sandbox environment. It sends operations through an execution
protocol: a request, any streamed input or output, and a result. An execution
worker inside performs those operations. That worker may hold a PTY, expose an
MCP server, or manage processes, but it is not another agent runtime because it
does not own the decision cycle.

![The only two agent placement modes](../assets/diagrams/part-0/00-agent-placement-modes.svg)

*Figure 0.2 — Placement depends only on where the decision cycle runs; a remote
model service and a sandbox-side worker do not create another mode.*

| Dimension | In-sandbox agent | External agent with sandboxed tool execution |
| --- | --- | --- |
| Agent runtime | Inside the sandbox environment | Outside the sandbox environment |
| Tool path | Local calls and system interfaces | Execution protocol to an execution worker |
| Private state | Usually coupled to the environment unless exported | Workspace and processes remain inside; session history may remain outside |
| Failure shape | Runtime and environment can fail together | Runtime can replace or reconnect to an environment |
| Main cost | Larger image and coupled lifecycle | Transport, serialization, and remote-tool semantics |
| Important non-guarantee | Locality does not imply strong isolation | External orchestration does not imply durable or publishable state |

Neither placement is the default winner. An in-sandbox agent is attractive
when the agent runtime expects ordinary local CLIs, PTYs, sockets, and files.
Tool calls can be direct, interactive programs behave naturally, and the
sandbox image contains one self-sufficient worker. The cost is coupling. If the
environment freezes, the decision cycle may freeze with it. Model or service
credentials may enter the environment unless a proxy keeps them outside.
Updating the agent runtime can also require rebuilding or replacing sandbox
images.

An external agent runtime centralizes decisions and durable history. It can
replace an execution environment, coordinate several environments, and keep
high-value credentials outside code execution. The cost is an execution
protocol that must faithfully represent real tools. A command is not only a
string and a final exit code: it may stream output, accept stdin, resize a PTY,
spawn a long-running process, expose a port, produce artifacts, or survive a
temporary disconnection. If the protocol omits those semantics, tools that
worked locally become unreliable remotely.

Placement also shapes observation ordering. Inside one environment, the agent
runtime can read a file immediately after a command writes it. Across a
protocol, the system must define whether the result means output was flushed,
the process exited, artifacts were captured, and workspace mutations are now
visible. Retries need operation identities so a lost response does not cause a
second package publish or database migration. These are distributed-systems
concerns introduced by the boundary, not reasons to invent another placement
mode.

Sandbox-as-a-Service is a delivery model, not an agent-placement mode. A
managed service can start an environment containing an agent runtime, or it can
offer an API to an external agent runtime. The placement test still returns one
of the same two answers.

Anthropic's Managed Agents architecture is a useful supporting example of the
second mode, not a new category. Anthropic describes a harness outside the
sandbox, a durable session log outside the harness, and an execute interface
that makes sandbox environments replaceable. The execution worker is the
“hands,” while the external harness owns the decision cycle. That separation
also keeps some credentials outside generated-code execution. The point here is
the boundary, not the Claude product: another agent runtime and another
sandbox provider could implement the same interfaces. [Anthropic engineering
description](https://www.anthropic.com/engineering/managed-agents)

### A private room is not a runtime

Give each agent a private directory and the obvious file collision disappears,
but several harder questions remain. Can an agent read the user's SSH keys? Can
two test servers bind the same port? What happens when memory is exhausted?
Which base revision produced the result? Can a failed attempt resume? Does a
downloaded artifact belong to shared history? Who authorizes publication?

These questions expose six pressures.

**Concurrency** demands ownership of files, processes, ports, and other mutable
state. **Auditability** demands a link from identity and starting state to tool
events and outputs. **Cost** demands fast creation, density, suspension, and
cleanup rather than one permanent machine per short task. **Reproducibility**
demands explicit templates and bases. **Recovery and exploration** demand
snapshots, forks, or replay. **Publication** demands a decision that turns
private results into shared truth.

Consider the changed file from the opening incident. Its contents look
reasonable, and the test output beside it says “passed.” That is not enough to
trust it. The result needs a chain of answers: Which agent and session wrote
the file? Which project revision did that session begin from? Which dependency
lockfile was present when the test started? Did the test run inside the same
workspace that produced the edit? Was another server already listening on the
port? Did the agent retry after changing its environment? Which exact bytes are
being proposed for return?

Ordinary development tools contain fragments of this record. Git can identify
a committed diff and its parent. Shell history may show commands. A CI system
may retain logs and artifacts. An agent runtime must connect those fragments
before a human has reconstructed the story manually. The useful record is not
an undifferentiated video of everything. It is structured identity and
causality: session S-17 started at base B-4, command C-9 ran with policy P-2,
artifact A-3 came from process E-8, and changeset D-6 contains the files now
under review.

That record also changes recovery. If the environment dies after the test, the
runtime can distinguish “rerun from the same base” from “continue from retained
workspace state.” If the agent runtime dies, durable session history can tell a
replacement what was observed and what remains private. If only the connection
drops, the execution protocol can reconnect to a still-running process instead
of starting a duplicate. Recovery is no longer a vague retry; it is a
transition from named state.

Security crosses all six, but “contains hostile code” is too narrow a
definition of an agent sandbox. A system may strongly separate a guest kernel
from its host yet offer no useful changeset. Another may be designed for
cooperating agents and provide excellent workspace provenance without claiming
hostile-tenant isolation. The word sandbox must always be followed by a unit,
a boundary, a state model, and a return path.

![The minimum agent runtime substrate](../assets/diagrams/part-0/00-agent-runtime-reference.svg)

*Figure 0.3 — Private execution becomes dependable only when policy and session
history surround a controlled path from action to return or publication.*

The minimum substrate is therefore small enough to remember. An agent runtime
acts through a sandbox environment. The environment contains a private
workspace and tools. Session history and policy surround the interaction.
Return or publication is an explicit transition. Lifecycle controllers,
schedulers, checkpoint stores, credential brokers, and fleet managers may be
needed at scale, but they refine this path rather than replace it.

A compact evaluation can now follow the task from end to end. First name the
unit: command, session, machine, browser, episode, branch, or workspace. Locate
the agent runtime with the placement test. Identify what enforces separation
and which resources remain shared. Name the private state and its base. Follow
the lifecycle through allocation, pause, restore, completion, and destruction.
Ask how simultaneous attempts contend for resources. Locate session history
and determine whether it records identity, inputs, events, outputs, and
failures. Finally, follow the result across the boundary and state the most
important guarantee the system does not make.

This checklist prevents two common comparison errors. The first is comparing a
filesystem to a VM as though one should replace the other; they govern
different state and trust boundaries. The second is treating a feature list as
an architecture. Two services may both advertise snapshots while one captures
only files and the other retains processes. Two coding agents may both use
worktrees while only one adds an OS-enforced command boundary. Precise nouns
make these distinctions visible before product names enter the discussion.

The next chapters follow one task—update a dependency, change a source file,
run tests, open the application, and return the proposal—through different
parts of this landscape. Each category solves a different problem. None should
be mistaken for the whole agent computer.

## Chapter 1 — Sandboxing in Coding-Agent Products

### Rules, workspaces, and execution boundaries

Suppose the dependency update now runs in three separate Git worktrees. The
agents stop overwriting one another's files, but all three may still see the
same home directory, credentials, kernel, network, and local services. A
worktree is a private desk, not a locked room.

Coding-agent products combine several boundaries that are easy to blur:

- A permission policy says which operations may proceed without approval.
- A private workspace separates unfinished file edits.
- A process sandbox restricts filesystem, process, or network access.
- A container namespaces resources but normally shares the host kernel.
- A VM or microVM adds a guest-kernel boundary.

**These controls compose; they do not form a universal strength score.** A
worktree may solve the collision that matters most for cooperative coding,
while a microVM may be necessary when executed code is untrusted. Conversely,
a microVM alone says nothing about how two good patches are compared or merged.

> *🧱 **Boundary rule:** Ask what is separated—files, processes, network,
> kernel, or policy—and what still remains shared.*

![Isolation mechanisms answer different questions](../assets/diagrams/part-0/01-isolation-boundaries.svg)

*Figure 1.1 — Moving from policy to a guest kernel changes which resources are
shared; it does not automatically add history or publication.*

Codex illustrates the separation. In local chats, spawned commands run inside
a platform-native sandbox while the agent runtime remains outside that command
boundary: external agent with sandboxed tool execution. Approvals decide when
Codex must ask to cross the boundary; sandboxing enforces what a command can do
inside it. Codex worktrees give independent working copies that share Git
metadata. They reduce edit collisions, but they are not described as a tenant
security boundary. Cloud chats instead create a container, check out a chosen
revision, run environment setup, execute the task, and return an answer plus a
diff. [Codex sandbox documentation](https://learn.chatgpt.com/docs/sandboxing),
[worktree documentation](https://learn.chatgpt.com/docs/environments/git-worktrees),
[cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environment)

Claude Code makes a similar distinction locally. Its Bash sandbox applies
filesystem and network restrictions to commands and their children, with OS
primitives enforcing the boundary. The Claude Code agent runtime remains
outside that Bash-command boundary, so this is also external agent with
sandboxed tool execution. Its documentation explicitly keeps permission rules
separate from sandbox enforcement and describes controlled fallback for
commands that cannot run inside the sandbox. [Claude Code sandbox
documentation](https://code.claude.com/docs/en/sandboxing)

Docker Sandboxes demonstrates the other placement mode. Docker launches a
coding agent inside an isolated microVM with its own Docker daemon, filesystem,
and network. The agent runtime, tools, and workspace live in that sandbox
environment; the model service may remain remote. That is an in-sandbox agent.
The microVM is a stronger host boundary than a worktree, but the documentation
does not make it a publication system. [Docker Sandboxes
documentation](https://docs.docker.com/ai/sandboxes/)

| Example | Unit and placement | Boundary and private state | Lifecycle, evidence, and return | Important non-guarantee |
| --- | --- | --- | --- | --- |
| Codex local | Command execution; external agent | OS-enforced command sandbox; optional worktree | Chat history and diff; worktree can be handed off or restored | Worktree is not a guest-kernel boundary |
| Claude Code local | Bash execution; external agent | OS-enforced filesystem and network restrictions | Session plus working-directory changes; exceptions follow permission flow | Permission approval is not isolation |
| Docker Sandboxes | MicroVM; in-sandbox agent | Guest kernel, private Docker daemon, filesystem, and network | Environment persists for the sandbox session; work leaves through Git or exported files | MicroVM isolation does not resolve competing changes |

Run the dependency task once through each row and the differences become
concrete. In a Codex worktree, the agent can edit without touching the
developer's checkout, but a command sandbox still decides whether it may read
outside the project or reach the network. If the test opens a local port, that
port may still belong to the host's network context unless another boundary
separates it. The worktree answers “whose files?” while the command sandbox
answers “which operations?”

In Claude Code's local sandbox, a package-manager command and every child it
spawns inherit filesystem and network restrictions. If installation needs a
new domain or an out-of-bound path, the regular permission flow becomes
visible. That is useful evidence: the task did not simply “have network.” It
crossed a named policy boundary for a reason. The same approval would be much
less meaningful if it silently granted unrelated tools permanent access.

Inside a Docker Sandbox, the agent can start nested containers through its
private Docker daemon without controlling the host daemon. That changes the
blast radius of build scripts and container lifecycle. Yet the proposed change
still needs to leave the microVM. A Git commit, patch, or copied artifact can
carry it out, and each preserves different context. The stronger execution
boundary does not choose the correct return form.

These examples also clarify concurrency. Ten private worktrees can prevent ten
agents from overwriting source files, while all ten still compete for host CPU,
memory, disk, ports, and rate-limited external services. Ten microVMs can
separate more of those resources but cost more to start and operate. A useful
coding-agent product states which collision it prevents rather than presenting
“sandboxed” as the end of the analysis.

Gemini CLI's documented choices reinforce the category lesson: it can use a
container with a mounted workspace, gVisor, or tool-level sandboxing. The
product name does not determine the boundary; the selected mechanism does.
[Gemini CLI sandbox documentation](https://geminicli.com/docs/cli/sandbox/)

When evaluating any coding-agent sandbox, ask what crosses the wall: the
workspace, shared Git metadata, credentials, network traffic, caches, Docker
sockets, local services, and explicit approval escapes. Then ask what comes
back. A terminal transcript and modified files may be sufficient for one
developer, but parallel agents need a more deliberate return contract.

## Chapter 2 — On-Demand Cloud Sandboxes

### A computer with a lifecycle API

The same task now arrives at a service as “give this agent a clean Linux
computer for twenty minutes.” The request sounds simple until the run times
out after the tests pass but before the patch is downloaded. The machine was
isolated; the work was still lost.

An on-demand cloud sandbox is best understood as a computer with an explicit
lifecycle. A template defines the starting tools and dependencies. Allocation
creates an identity and private state. Active execution owns processes, files,
and ports. A pause or snapshot may retain some state. A timeout or destroy
operation ends the rest. Finally, a return path carries selected values, files,
artifacts, URLs, snapshots, or patches to another system.

> *🔄 **Lifecycle rule:** Isolation protects a running sandbox; retention and
> return protect the work it produces.*

“Fresh” can mean a new process, a clean filesystem, a cached template, a
restored snapshot, or a resumed machine. Those states are operationally
different. **Reproducibility depends on naming the base**, not merely calling
the result new.

![Lifecycle choices determine whether private work survives](../assets/diagrams/part-0/02-sandbox-lifecycle.svg)

*Figure 2.1 — Stop, pause, export, and destroy are distinct transitions because
they retain different state.*

E2B exposes on-demand Linux VMs and templates through SDKs. Its documentation
separates lifecycle, persistence, snapshots, forking, filesystem transfer,
commands, metrics, and telemetry. In the common API topology, an external agent
runtime requests tool execution in the VM, making this external agent with
sandboxed tool execution. A caller can also install an agent runtime in the
template, which would use the in-sandbox mode; the delivery service itself
does not decide placement. [E2B documentation](https://e2b.dev/docs)

Daytona likewise exposes sandboxes through SDKs and an API, with documented
pause operations and snapshots. Its documentation distinguishes filesystem-only
cold snapshots from experimental snapshots that include memory. That detail
matters: restoring files is not the same as restoring a running process.
These are vendor-documented capabilities, not an independent performance
benchmark. [Daytona sandbox documentation](https://www.daytona.io/docs/en/sandboxes/)

Modal Sandboxes make the lifetime boundary visible in another way: the
documentation recommends filesystem snapshots when work must survive beyond
the sandbox's maximum run. A long-lived project is therefore assembled from
successive environments and retained files, not assumed to be one immortal
machine. [Modal Sandbox documentation](https://modal.com/docs/guide/sandboxes)

| Example | Unit and placement | Isolation and private state | Lifecycle, concurrency, and audit | Return and non-guarantee |
| --- | --- | --- | --- | --- |
| E2B | On-demand VM; usually external agent | VM files, processes, and environment | Create, connect, pause, snapshot, fork; metrics and telemetry are documented | Files, command results, URLs, snapshots; no built-in merge contract |
| Daytona | Sandbox from an image or snapshot; usually external agent | Private filesystem and experimental process-memory snapshot | Create, pause, resume, snapshot; many sandboxes are API-managed | Files and command results; snapshot is not publication |
| Modal | Sandbox process environment; external agent in the common API use | Filesystem plus attached volumes or snapshots | Bounded run with retained filesystem options | Function results and files; lifetime limits remain |

Follow one environment through the task to see why these fields belong
together. The service starts from template T-12 and checks out revision B-7.
The external agent runtime sends an install command through the execution
protocol. The command streams output for six minutes and leaves a package cache,
modified lockfile, and background development server. The agent then changes a
source file and receives a preview URL.

At this point, “pause the sandbox” is underspecified. Are processes frozen or
terminated? Does the private filesystem remain attached? Does the preview URL
survive? Is billed compute released? Can another process reconnect to the same
session identity? A provider may answer these questions differently for pause,
snapshot, and stop. The caller must record the actual transition rather than
infer it from a familiar verb.

Return has the same ambiguity. Capturing stdout preserves neither the lockfile
nor the source edit. Downloading the two changed files may miss a deletion or a
generated migration. Keeping a full snapshot aids later debugging but makes
code review awkward and can retain secrets or caches unnecessarily. A Git
patch is compact but assumes a compatible base. The safest design usually
separates a diagnostic snapshot from a reviewable change proposal.

Timeout policy should follow that distinction. An inactive environment may be
cheap to pause but dangerous to retain indefinitely if it contains credentials.
A completed environment may be safe to destroy only after outputs and history
are durably linked. Cleanup is therefore part of the correctness path:
“destroyed after capture D-8” is a stronger event than “worker disappeared
around 14:03.”

The common non-guarantee is decisive: **a task sandbox generally returns
material, not shared truth.** Stdout can say the tests passed while the useful
patch remains inside. A file download can omit deletions. A snapshot can
preserve too much state for review. A branch can conflict with a newer base.
The caller still needs capture, comparison, and publication.

## Chapter 3 — Browser and Computer-Use Sandboxes

### The state behind the pixels

The dependency update passes its tests, so an agent opens the application and
logs into a staging account. It dismisses a banner, changes a preference,
downloads a report, and hands control to a human for a payment confirmation.
Closing the browser process does not answer which parts of that interaction
should persist.

A browser sandbox carries more than executable code. Tabs, cookies,
localStorage, IndexedDB, downloads, browser permissions, authentication,
display state, and input state can all affect the next action. A disposable
browser session may attach to a durable profile. Human live view or takeover
crosses into the same state. Screenshots, recordings, extracted data, and
downloads can leave even when the session itself disappears.

> *🔐 **State rule:** A browser process may be disposable while its authenticated
> profile, evidence, and downloads persist.*

![Browser state has several lifetimes and return paths](../assets/diagrams/part-0/03-browser-session-state.svg)

*Figure 3.1 — The browser process may be temporary while identity, evidence,
and selected outputs follow different retention rules.*

Browserbase makes the profile distinction explicit. Sessions start with a
fresh user-data directory by default; a Context can retain cookies,
authentication tokens, local storage, IndexedDB, and other application data
across sessions. Persistence must be enabled when session changes should update
that Context. In the usual topology, an external agent runtime drives the
remote browser through an automation protocol, so this is external agent with
sandboxed tool execution. [Browserbase Context
documentation](https://docs.browserbase.com/platform/browser/core-features/contexts)

AIO Sandbox illustrates a different unit: one Docker container combines
browser automation, VNC, shell, files, notebook, editor, and MCP surfaces over
a shared filesystem. An external agent client can call those surfaces as
tools. The integration is convenient because a downloaded file is immediately
visible to the shell, but a shared container does not by itself create a
stronger tenant boundary or a publication transaction. [AIO Sandbox
repository](https://github.com/agent-infra/sandbox)

| Example | Unit and placement | Private state and lifecycle | Auditability and return | Important non-guarantee |
| --- | --- | --- | --- | --- |
| Browserbase | Remote browser session; external agent | Fresh session data or a retained Context | Context identity plus browser automation results | A retained login is sensitive state, not proof of authorization |
| AIO Sandbox | Tool-rich container; external agent in its client topology | Browser, display, tools, and workspace share one container | Tool results, files, screenshots, and remote views | One container does not imply hostile-tenant isolation or code publication |

A short browser timeline shows why an interactive session needs its own state
model. At 10:00 the agent attaches profile P-4 and opens the staging site. At
10:02 it downloads report R-1 into the shared workspace. At 10:04 a human takes
over and confirms a dialog. At 10:05 the agent resumes, reads the resulting
page state, and edits the application so the same dialog is clearer. At 10:09
the environment closes.

Several outputs now exist: the report file, screenshots, browser events, the
human decision, changed source, and an updated profile. They should not all
follow the same route. The report may be a task artifact. The screenshots may
be audit evidence. The source edit may become a changeset. The profile may be
retained for a later session, but only under the same identity and policy. The
human action needs an explicit marker so it is not attributed to the agent.

Teardown must address both confidentiality and reproducibility. Deleting a
container while retaining its browser Context can preserve precisely the
authenticated state the next run needs. It can also preserve a compromised
session or an unintended preference change. Conversely, discarding every
profile after every run reduces risk but may make workflows unusable and
encourage agents to handle raw credentials repeatedly. The infrastructure
needs an explicit profile owner, retention rule, revocation path, and event
history.

The visual surface creates one more trap: **a screenshot is an observation, not
the state itself.** Two pages can look identical while cookies, permissions,
downloads, and open connections differ. Reliable computer-use evaluation and
replay therefore require structured browser and session facts alongside
pixels.

Credentials make the teardown problem sharper. A profile that survives may
contain authority long after a task ends. A screenshot may expose a secret that
filesystem cleanup cannot erase. A human takeover may perform an action that
the automated trace alone cannot explain. Useful browser infrastructure
therefore binds session identity, policy, redaction, retained evidence, and
profile lifecycle. Its return path must distinguish an observation from an
approved project change.

## Chapter 4 — RL and Evaluation Sandboxes

### Fork one state into a population of rollouts

Now repeat the dependency task ten thousand times. Some attempts should begin
from the same repository and process state, then diverge at one model decision.
The infrastructure should not rebuild the operating system, reinstall packages,
and warm the same caches for every candidate. It should bootstrap one clean
root, preserve it as a named checkpoint, and fork private branches for parallel
rollouts.

Monte Carlo tree search makes the requirement concrete. The controller selects
a promising node, restores the sandbox state associated with that node, expands
one or more candidate actions, and rolls each branch forward. A verifier scores
the resulting leaves. The controller then backpropagates rewards and visit
counts through the logical search tree before selecting again. The expensive
work is not only model inference. It is repeatedly materializing a consistent
world at the exact point where alternatives diverge.

> *🌲 **Rollout rule:** Bootstrap one named root, fork private branches, score
> leaves, and record the exact checkpoint behind every reward.*

![MCTS forks a bootstrapped sandbox state into parallel private rollouts](../assets/diagrams/part-0/04-rl-environment-stack.svg)

*Figure 4.1 — An external MCTS controller bootstraps one clean checkpoint,
restores a selected state, forks private sandboxes for parallel rollouts,
evaluates the leaves, and backpropagates their scores. CubeSandbox or DeltaBox
can accelerate state reuse; neither supplies the search policy or verifier.*

The figure shows stateful agent search, where selected tree nodes are
materialized as sandbox checkpoints. It does not claim that every MCTS
implementation must preserve every node as a full machine image. A system may
checkpoint only branch points, reconstruct cheap nodes by replay, or evict old
states under memory pressure. The invariant is that a rollout begins from the
state named by its selected node, not from whatever state a reused worker
happens to contain.

CubeSandbox provides the service-shaped substrate. Its project documents a
RustVMM/KVM microVM sandbox, an E2B-compatible API, single-node and clustered
deployment, and snapshot operations that can checkpoint a running sandbox,
clone parallel environments, and roll a branch back. In an MCTS deployment,
the external controller can bootstrap a root from a template, clone several
hardware-isolated branches, stream actions into each, and retain only the
checkpoints worth exploring further. These capabilities are project-reported;
they do not by themselves define the dataset, rollout policy, reward, or
trainer. [CubeSandbox repository](https://github.com/TencentCloud/CubeSandbox)
and [lifecycle documentation](https://cubesandbox.com/guide/lifecycle.html)

DeltaBox focuses on the checkpoint path itself. The research system coordinates
filesystem changes with process state so a controller can return to a prior
agent state without rebuilding the entire environment or replaying the whole
prefix. Its paper evaluates this mechanism on SWE-bench tree search and RL
fan-out. The authors report millisecond-level checkpoint and rollback latency;
those are research results, not independent service guarantees. DeltaBox is
therefore useful here as an architectural example of change-based state reuse,
not as a complete training stack. [DeltaBox paper](https://arxiv.org/abs/2605.22781)
and [project page](https://dongyunpeng-sjtu.github.io/deltabox/)

The two systems illuminate complementary layers. CubeSandbox presents a
hardware-isolated sandbox service with templates, lifecycle, networking, and
cluster-oriented fan-out. DeltaBox concentrates on coordinated file-and-process
rewind under high-frequency branching. A deployment could choose either state
substrate according to its isolation, maturity, and checkpoint requirements;
the manuscript does not need a longer product catalog to establish that
boundary.

| Sandbox substrate | Unit and placement | Fork and rollback state | Parallel rollout role | Return and non-guarantee |
| --- | --- | --- | --- | --- |
| CubeSandbox | KVM microVM sandbox; commonly an external agent with sandboxed tool execution | Templates and running-state snapshot, clone, and rollback operations | A controller can fan out private microVM branches across a service or cluster | Returns execution and sandbox state; does not define MCTS, reward, or training |
| DeltaBox | Stateful agent sandbox controlled by an external search or training loop | Coordinated filesystem and process checkpoint/rollback using changed state | Reduces repeated state materialization during tree search and RL fan-out | Restores agent state; does not define the verifier, search policy, or fleet service |

The placement rule remains unchanged. In the topology shown, the model → tool →
observation → next-model-call cycle is controlled outside each sandbox, so this
is an external agent with sandboxed tool execution. An in-sandbox agent is also
possible, but it still needs a controller above the branches to assign episode
identity, collect scores, and select the next node.

Bootstrap must be explicit. The root checkpoint should name the base image,
repository revision, dependency state, initialization procedure, tool policy,
and any retained process state. If rollout A warms a compiler cache and rollout
B silently inherits it, timing and behavior are no longer attributable to the
candidate action. If A leaves a test server or database row behind and B's
verifier accepts it, B receives reward for work performed by A. The apparent
model improvement is an isolation bug.

Forks also need identities. Child rollouts share an immutable prefix but own
their later files, processes, action trace, termination reason, and reward. A
checkpoint reference records where each child diverged. A branch that loses the
search can be destroyed; a promising leaf can become a new checkpoint for the
next fan-out. Promotion changes which state is retained, but it must not merge
unfinished child state back into its siblings.

Failure is data too. Allocation timeout, restore failure, tool protocol error,
verifier crash, policy denial, and model-selected termination do not mean the
same thing. Treating all of them as reward zero teaches the trainer about
infrastructure availability as if it were agent quality. Hiding all of them as
retries biases the dataset toward eventual successes. The rollout fabric needs
typed termination and retry policy so evaluators can decide which outcomes
belong in a metric or training batch.

Scale makes auditability part of correctness. A reward without the exact root,
selected checkpoint, model and agent-runtime versions, actions, verifier
version, and termination reason is ambiguous training data. A verifier with
broader credentials than the sandbox can become a target for reward hacking.
Because search fans out systematically, a small state leak or scoring loophole
can be exploited thousands of times.

**Fast checkpointing is an enabling primitive, not the episode contract.** The
complete system must still isolate branches, protect verifier
integrity, bound egress and resources, record every fork and restore, and make
the winning trajectory reproducible from its bootstrapped root.

## Chapter 5 — Filesystem Branching and Runtime Checkpointing

### Save points have different coverage

Three agents try different repairs from the same repository base. Copying the
entire directory three times works, but it duplicates dependencies and obscures
their relationship. A copy-on-write branch can share the base and record only
private deltas. A checkpoint can go further and preserve a running process.
Those mechanisms solve exploration and recovery, but they save different
things.

Agent state may include the conversation, tool events, files, process memory,
open descriptors, browser profiles, mounted volumes, and remote resources. A
filesystem snapshot captures no more than its filesystem domain. A
process-aware checkpoint may preserve memory and a process tree. Neither can
undo an email, payment, database write, published message, or disclosed
credential.

> *⏪ **Restore rule:** A checkpoint can rewind only the state domains it
> captured; external effects remain real.*

![Restore operations stop at external effects](../assets/diagrams/part-0/05-state-coverage-side-effects.svg)

*Figure 5.1 — More complete checkpoints improve internal recovery, but effects
outside the captured domain remain real.*

AgentFS makes files and agent history queryable state. Its project stores file
operations, tool calls, and state changes in SQLite, and describes snapshots
as copies of the database file. That improves auditability and portability.
The project also labels itself beta. A database-backed filesystem does not
automatically isolate processes, networks, or tenants; its important unit is
agent state. [AgentFS repository](https://github.com/tursodatabase/agentfs)

BranchFS makes speculative filesystem state a tree. It describes FUSE-based
copy-on-write branches with snapshot isolation, commit-to-parent, and abort.
Separate agents can access different branch paths through one mount. Its atomic
commit means the branch delta is applied as one filesystem operation relative
to its parent; it does not mean arbitrary semantic conflicts with a separately
advancing shared project have been resolved. [BranchFS
repository](https://github.com/multikernel/branchfs)

DeltaBox is a research system that coordinates filesystem state with process
state for checkpoint and rollback. The authors report millisecond-level
checkpoint and restore in their evaluated setup by combining OverlayFS changes
with CRIU-coordinated process state. Those are author-reported research results,
not independently reproduced numbers here. The architectural lesson is that
**“checkpoint” must name both its coverage and consistency boundary.**
[DeltaBox project page](https://dongyunpeng-sjtu.github.io/deltabox/)

| Example | Unit and placement | Private state and lifecycle | Concurrency and audit | Return and non-guarantee |
| --- | --- | --- | --- | --- |
| AgentFS | SQLite agent filesystem; either placement mode | Files, key-value state, and tool history; copyable snapshots | One portable history can be queried and inspected | Database file or mounted files; no process or tenant isolation |
| BranchFS | Copy-on-write filesystem branch; either placement mode | Snapshot view plus private delta; commit or abort | Parallel branch paths with explicit parent relationships | Filesystem merge to parent; no external-side-effect rollback |
| DeltaBox | Filesystem-and-process state node; external controller in the described design | Coordinated filesystem and memory checkpoint or rollback | Designed for branching exploration with state pairs | Restored execution state; no undo of remote effects and no publication contract |

Imagine three save operations during the same task. After the dependency is
installed, the agent snapshots the workspace. After the development server
loads the new package, it checkpoints processes and files. After a human
approves the rendered result, the system captures a changeset. All three are
valuable, but they answer different recovery questions.

The workspace snapshot can reproduce the source and lockfile, then restart the
server from scratch. The process checkpoint may resume more quickly and retain
in-memory caches or interpreter state, but it is tied to a compatible runtime
and kernel context. The changeset is the reviewable proposal: it should exclude
ephemeral caches and memory while retaining enough base and provenance data to
compare with shared history. Calling all three “state” would hide the reason
each exists.

Branch relationships need the same precision. A child branch inherits a parent
view at a point in time. If its parent advances, the child may continue against
its captured view or be rebased according to explicit rules. Commit-to-parent
can be atomic at the filesystem layer while still overwriting a semantically
incompatible configuration. Publication against a moving project base needs
conflict detection above storage mechanics.

External effects should appear in the history even when they cannot appear in
the checkpoint. If the agent pushed a branch, changed a ticket, or sent a test
notification, recovery should not repeat the effect blindly. An idempotency
key, compensating operation, or human decision may be required. The honest
runtime says “restored internal state; external action X may already have
occurred” rather than promising a rewind it cannot perform.

A checkpoint selects a point inside one execution history. **Publication is a
different operation against shared history that may have advanced.** Restoring a
successful test run does not decide whether its edits are compatible with
another accepted patch. Filesystem branching supplies private alternatives;
the return boundary still needs capture, comparison, conflict semantics, and
provenance.

## Chapter 6 — Meta-Agent Runtimes, Control Planes, and Fleets

### A supervisor over a reversible trace

A worker is about to issue a tool call that would edit the wrong dependency.
A meta-agent observes the proposed action, intercepts it before execution, and
forks a corrected branch. If the original branch has already run, the
meta-agent reverts to the preceding event and tries again. This simple story
hides three different control roles.

A **meta-agent** observes or redirects another agent's decisions. A **sandbox
lifecycle control plane** creates, pauses, restores, routes, and destroys
sandbox environments. A **scheduler** places those environments on machines
and manages queues or warm capacity. One product may implement more than one
role, but the roles remain distinct. A sandbox-side daemon that executes a
command is still an execution worker, not a placement mode.

> *🧭 **Control rule:** Meta-agent supervision, sandbox lifecycle, and fleet
> placement may cooperate, but they are not the same responsibility.*

![A meta-agent creates, observes, intercepts, reverts, and forks a worker trace](../assets/illustrations/part-0/06-shepherd-meta-agent.png)

*Figure 6.1 — A meta-agent creates and observes a worker, intercepts a proposed
action, then reverts or forks the reversible trace. Source: [SHEPHERD Figure
1](https://shepherd-agents.ai/). Lifecycle control and fleet placement remain
separate roles described below.*

SHEPHERD focuses on meta-agent semantics. Its project describes reversible,
Git-like agent execution traces that can be created, observed, intercepted,
forked, replayed, and reverted. The repository also labels the software early
alpha with changing APIs. It should therefore be read as a research-driven
trace substrate, not mistaken for a mature fleet scheduler or an isolation
boundary. [SHEPHERD repository](https://github.com/shepherd-agents/shepherd)

Kubernetes Agent Sandbox focuses on lifecycle orchestration. It defines a
Sandbox custom resource for a stateful singleton workload with stable identity
and persistent storage, and it can use warm pools. Its documentation is
explicit that low-level isolation is delegated to sandbox runtimes such as
gVisor or Kata Containers. The managed workload can contain an in-sandbox
agent, or it can serve an external agent through an execution protocol; the
control plane does not add another placement mode. [Kubernetes Agent Sandbox
repository](https://github.com/kubernetes-sigs/agent-sandbox)

SWE-ReX occupies the remote-execution layer. Its project presents sandboxed
code execution for agents across local and cloud backends. In the common use,
an external agent runtime acquires or connects to an environment, executes
commands, and receives evidence. It does not become the scheduler merely
because it can address several backends. [SWE-ReX
repository](https://github.com/SWE-agent/swe-rex)

| Role or example | Primary unit and placement | Lifecycle authority | Concurrency and evidence | Important non-guarantee |
| --- | --- | --- | --- | --- |
| SHEPHERD meta-agent substrate | Reversible trace; external supervisor topology | Fork, replay, and revert trace execution | Trace history supports comparison and intervention | Early-alpha trace substrate is not a scheduler or isolation runtime |
| Kubernetes Agent Sandbox | Stateful sandbox resource; supports either of the two placement modes | Declarative create, identity, storage, claim, and warm-pool management | Kubernetes reconciliation and workload identity | Delegates the actual isolation mechanism |
| SWE-ReX remote execution | Execution environment; external agent | Backend-specific acquire, command, and release | Parallel remote commands and returned execution evidence | Remote access is not publication or meta-agent supervision |

Walk the worker failure through these roles. The scheduler first notices that
worker W-3 stopped heartbeating. It marks the placement unavailable and stops
sending new sessions there. The lifecycle control plane consults the session's
retention policy: workspace snapshot Q-8 exists, but its process tree was not
checkpointed. It allocates a replacement environment, attaches Q-8, and gives
the environment a new execution identity while preserving the logical session
identity.

The agent runtime then needs an observation that describes the discontinuity.
“Command timed out” would be misleading if the worker vanished. A structured
event can say that process E-11 has unknown completion status, workspace state
is restored through command C-10, and external effects after that command may
need reconciliation. The agent can inspect before deciding whether to retry.
A meta-agent may instead fork two recovery strategies or stop the run for
review.

This trace prevents a common fleet error: continuing successfully while losing
the reason a result should be distrusted. If the replacement reruns tests and
passes, the final evidence still records the worker loss and the restored base.
If a cost report shows two environments, the session history explains why. If
the first worker returns late, the lease prevents it from publishing stale work
under the current session identity.

Warm pools add a second layer of state. A warm environment can contain a
prepared image and dependencies without containing a user's private workspace.
Once claimed, it must acquire a session identity and policy before tool
execution. On release, cleanup must remove private state before the environment
returns to the pool. Fast reuse without this ownership transition turns a
performance optimization into cross-session contamination.

Auditability becomes a control input at this scale. Identity tells the
controller which session owned a workspace. Events show whether a failure
occurred in the agent runtime, execution protocol, worker, or tool. Resource
records support quotas and scheduling. Retained evidence lets a replacement
continue without pretending the failed work never happened.

Recovery also requires honesty about state. Reassigning a durable workspace is
not the same as restoring its processes. Replaying session history is not the
same as undoing an external API call. A warm environment reduces startup time
but may weaken reproducibility if its base is not named. The control plane must
make those distinctions visible instead of hiding them behind a single
“running” status.

## Chapter 7 — Workspace Isolation, Changesets, and Publication

### Returning work is part of execution

The agents have now produced three plausible fixes. One changed the dependency
with a small adapter. One pinned an older transitive package. One rewrote the
affected module. All pass their private tests. Isolation kept the attempts
clean; it did not decide which result belongs in the project.

> *🚦 **Publication rule:** Finishing creates a private result; publishing makes
> an accepted result shared truth.*

Return mechanisms carry different meanings.

| Return form | What it preserves | Conflict behavior | What it does not establish |
| --- | --- | --- | --- |
| Value or stdout | A result from one operation | None | Which files or state produced it |
| File or artifact | Selected bytes | Usually overwrite or rename | Relationship to a project base |
| Patch | File edits relative to an assumed base | May fail or apply partially | Complete runtime evidence |
| Branch | Commits and Git ancestry | Merge or rebase semantics | Non-Git state or policy approval |
| Changeset | Captured mutations plus explicit base and identity | Can be compared and resolved | Acceptance into shared history |
| Publication | Accepted all-or-reject transition | Rejects unresolved or forbidden change | Hostile-tenant isolation |

Consider a concrete conflict. Session A begins at base B-10 and changes a
configuration line from timeout 30 to timeout 60. Session B also begins at
B-10 and replaces the same setting with a structured retry policy. B publishes
first, producing shared base B-11. A's tests still pass in its private
workspace, but publishing A as a blind overwrite would silently erase B's
policy.

A changeset gives the resolver three relevant states: B-10, A's private result,
and current B-11. It can identify the overlapping semantic region and reject
publication, request resolution, or prepare a new proposal. Rejection is not
task failure. A's commands, artifacts, and rationale remain useful evidence,
and the private workspace can be rebased or inspected. The shared project
remains internally consistent.

All-or-reject publication also protects multi-file changes. A dependency update
may require a manifest, lockfile, source edit, and generated metadata to move
together. Applying only the easy files can leave a build that no agent actually
tested. The publication transaction either accepts the resolved set and records
its provenance or leaves shared history untouched.

Provenance should follow the accepted result rather than live only in a log
archive. A reviewer asking “why is this line here?” should be able to reach the
changeset, session, starting base, commands, test evidence, agent identity, and
publication decision. That chain does not prove the code is correct, but it
makes the decision inspectable and reversible at the project-history level.

A sound workspace contract separates four events. **Finish** means the agent
runtime stopped or returned. **Capture** turns private filesystem mutations
into a reviewable proposal. **Resolve** compares that proposal with the
currently accepted base and policy. **Publish** makes the accepted result shared
history. Any step may fail without erasing the earlier evidence.

Container Use is a concrete branch-oriented example. Its environments combine
a dedicated Git branch, a container, and tracked command and file history. A
reviewer can inspect a log or diff, continue the environment, merge its branch,
apply changes as staged modifications, or discard the attempt. The product
therefore makes return choices visible, although Git remains the state and
conflict substrate. [Container Use environment
workflow](https://container-use.com/environment-workflow)

![Publication turns a private proposal into accepted shared history](../assets/diagrams/part-0/07-publication-provenance.svg)

*Figure 7.1 — A private workspace becomes shared history only after capture and
an explicit accepted-or-rejected publication decision.*

### The Volume I case study

Ephemeral Sandbox sits at this return boundary. Its project describes multiple
coding agents working in isolated workspace sessions over one stable project
base inside a shared sandbox. Each session has private writable state. The
runtime captures a reviewable changeset, resolves it against shared history,
and publishes an accepted result with provenance. CLI and MCP surfaces control
the runtime; observability records activity around the transition.
[Ephemeral Sandbox repository](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox)

Using the same profile questions as the rest of this landscape:

- **Sandbox unit:** one shared sandbox containing private workspace sessions.
- **Placement:** it can serve an external agent runtime through its control
  surfaces; an agent runtime placed inside the larger sandbox remains the other
  valid mode.
- **Isolation mechanism:** private workspace state and execution-session
  boundaries for cooperating coding agents.
- **Private state:** each session's writable delta, processes, and captured
  changes before publication.
- **Lifecycle:** create a session from an explicit base, execute, capture,
  publish or reject, and destroy.
- **Concurrency:** many sessions can share immutable project truth without
  sharing unfinished writes.
- **Auditability:** session identity, operations, changesets, decisions, and
  provenance connect accepted work to its origin.
- **Return path:** a changeset enters an all-or-reject publication transition.
- **Important non-guarantee:** version 1 workspace isolation is not a hardened
  microVM boundary for mutually untrusted tenants.

That limit is central, not a footnote. Ephemeral Sandbox addresses private
parallel workspaces and controlled publication. A deployment that runs hostile
tenant code still needs an appropriate container, VM, or microVM boundary,
credential controls, network policy, and a fleet layer. The publication
contract can compose with those systems; it does not replace them.

Composition works only when adjacent contracts stay explicit. A microVM
provider may supply the sandbox environment while Ephemeral Sandbox manages
several private workspace sessions inside it. An external agent runtime may
send commands through a remote-execution protocol, while a lifecycle control
plane replaces the microVM after failure. A browser service may attach an
interactive session whose downloads enter one workspace. A scheduler may place
the whole unit on a warm worker. Publication still has one job: decide whether
a captured private proposal becomes shared project history.

Each layer must pass stable identity to the next. The fleet knows a worker and
lease. The lifecycle controller knows a sandbox environment. The runtime knows
a workspace session and execution. Session history knows an agent and its
observations. The changeset knows its base. The publication decision knows the
accepted shared revision. Without those links, operators receive many logs but
cannot answer which execution produced a line of code.

The same explicitness prevents capability inflation. Adding a microVM does not
make workspace publication conflict-aware. Adding provenance does not stop
kernel exploits. Adding process checkpointing does not revoke a leaked token.
Adding a scheduler does not turn an execution worker into an agent runtime.
**The useful architecture is not one giant box labeled “agent sandbox.”** It is a
set of boundaries whose guarantees can be checked independently and then
composed.

### From landscape to implementation

Today's sandbox landscape already supplies many pieces of an agent-facing
runtime: coding-tool policies, disposable computers, persistent browser
profiles, repeatable evaluation environments, branching state, checkpoints,
reversible histories, lifecycle controllers, schedulers, and remote execution.
The remaining engineering challenge is to compose the pieces without losing
their boundaries.

Volume I now narrows its focus. It is not a general design for every hostile
workload or thousand-node fleet. It follows one problem in depth: how
cooperating coding agents can receive private parallel workspaces over shared
project truth, how their activity can remain observable, and how one result can
be captured, resolved, rejected, or published without exposing another
agent's unfinished state. That is the path from a sandbox environment to an
agent workspace.
