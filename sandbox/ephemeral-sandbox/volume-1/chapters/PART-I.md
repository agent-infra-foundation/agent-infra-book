# Part I — The Concurrency Ceiling of Parallel Coding Agents

*How native operating-system and filesystem abstractions limit safe multi-agent coding*

Part 0 toured the sandbox landscape. Part I asks what happens when an agent stops producing text and starts operating a computer.

An agent can edit files, install packages, launch processes, bind ports, and consume resources. Fifty agents can do all of those things at once. Who then explains which task changed line 418, consumed 6 GB of memory, or took port 3000?

For human development, the missing coordinator is usually the developer. A person remembers which checkout is active, waits for an install to finish, chooses another port, notices an old server, decides which files belong in a commit, and resolves conflicts before sharing the result. Much of this coordination lives in habit rather than in the operating system.

Parallel agents remove that implicit serialization. The kernel can schedule their processes and the filesystem can store their bytes, but neither represents an agent task, its stable project base, its private changeset, or its publication decision. At high concurrency, that semantic gap becomes the bottleneck.

“Check the terminal history and hope” is not an infrastructure strategy.

This part develops one argument:

```text
native OS and filesystem primitives expose processes, paths, and ports
        ↓
human developers normally supply task ownership and serialization
        ↓
parallel agents interfere or lose verifiable state
        ↓
each unit of work needs an attributable workspace session
        ↓
private work crosses an explicit publication boundary
        ↓
Ephemeral Sandbox turns the contract into one workspace runtime
```

---

## Chapter 8 — Agents Are Processes with Side Effects

An agent receives a modest request:

> Upgrade the web framework, fix the tests, and verify the development server still starts.

The agent launches a package manager. Scripts rewrite a lockfile, generate code, populate caches, and start children. Tests consume memory and write output. The server binds a port. One child survives shutdown.

The agent reports success.

The shell exited with code 0. The machine did not.

### A tool call is a machine event

A coding agent is often pictured as:

```text
request → think → call tool → answer
```

The computer sees a longer chain:

```text
agent decision → tool call → process tree → machine state
```

Some state is obvious, such as an edited source file. Some is easy to miss: a daemon, compiler cache, temporary socket, downloaded dependency, or occupied port.

![An agent invokes a tool that affects files, processes, network state, and resources.](../assets/diagrams/part-1/08-01-tool-call-side-effects.png)

*Figure 8.1 — A tool call returns a result and may leave machine state behind.*

| State | Examples | Why another agent cares |
| --- | --- | --- |
| Filesystem | Source edits, lockfiles, generated code, caches | It may read unfinished work or test the wrong build |
| Processes | Compilers, workers, language servers, development servers | A leftover process may mutate files or hold locks |
| Network | Ports, sockets, outbound requests | Another task may reach the wrong service or fail to bind |
| Resources | CPU, memory, disk, file descriptors, I/O | One task may slow or crash unrelated work |

A package install can touch all four rows. So can a test suite. In agent infrastructure, “read-only” is a property to enforce, not a mood expressed in the prompt.

The rows also compound one another. A test command may start six workers, write snapshots, reserve a port, and reach a database. If the command times out, its parent may exit while one worker continues running. The filesystem now contains output from an incomplete test, the port remains occupied, and the next agent inherits a mystery.

This is why tool output and machine outcome must be separated. The output is what the command reported. The outcome is the state transition the runtime must own, observe, publish, or clean up.

> *⚙️ **Side-effect rule:** An agent action is complete when the runtime can account for the machine state it created—not merely when the text response ends.*

### Native OS and filesystem primitives lack the agent story

Operating systems know process IDs, sockets, memory pages, open files, and CPU time. Filesystems know paths, permissions, owners, and modification times.

Those are machine-level identities. Agent orchestration needs task-level identities: which project base a task sees, which files and processes belong together, which evidence validates the result, and whether the result is still private. The kernel may comfortably run thousands of processes while the workspace model fails to explain what any of them mean.

They do not naturally know:

- which agent task owns a process tree;
- which tool call introduced a group of lines;
- which project revision the task started from;
- whether a listening port belongs to active work or an abandoned server;
- whether a file change is ready to enter shared history.

PID 19324 may own a socket. Git may show a modified file. Neither automatically says, “This socket and these lines belong to Agent B’s dependency upgrade, based on revision R42, and remain unpublished.”

A familiar filesystem is like a shared office with labels on the drawers. It records where a document is and when it changed. It does not record which task authorized the edit or whether the draft is ready to send.

A timestamp is useful. It is not an alibi.

### Follow one run to its actual end

The framework upgrade may create this state:

```text
upgrade request
  ├─ manifest and lockfile changes
  ├─ downloaded dependencies
  ├─ generated client code
  ├─ test workers and coverage output
  └─ development server on port 4173
```

“Exit code 0” cannot describe the whole result. A useful runtime record needs a base revision, changed paths, process and network activity, resource measurements, command evidence, a candidate changeset, and a cleanup outcome.

Suppose the run began at revision R42, changed eight source paths and a lockfile, started six test workers, and left port 4173 listening. The lockfile may belong in the changeset; coverage output may belong only in diagnostics; the surviving server belongs in cleanup. The runtime needs to preserve those differences.

Not every runtime exposes every field today. The list still reveals the missing noun: an attributable unit of agent work. Chapter 10 will call it a **workspace session**.

### Isolation is the beginning of the contract

A container can provide useful filesystem, process, and network boundaries. Agent work also needs a recorded project base, a way to separate useful source changes from runtime debris, and a controlled route back to shared history. Process isolation answers where a command ran. A workspace contract explains its beginning, private middle, and explicit end.

The end is especially important. Cleanup should terminate remaining process groups, release mounts and network state, and remove private temporary data. Publication should preserve only the accepted project transition and retained evidence. Otherwise an “ephemeral” task becomes a permanent collection of small surprises.

With one agent, missing ownership is inconvenient. With many agents, it becomes a concurrency limit.

---

## Chapter 9 — Why Coding Agents Hit a Concurrency Ceiling

If one coding agent completes one task, launching twenty agents against twenty issues sounds like ordinary parallelism.

It is not. Coding tasks discover overlap while they work. Several may update the same dependency, regenerate the same file, start the same service, or revise the same interface. The machine may run all twenty processes while the project becomes less likely to finish.

The **concurrency ceiling** is the point where additional agents create more interference, coordination, integration, and diagnosis work than useful progress.

### The human was the hidden concurrency control

A single developer performs many small acts of serialization without naming them. They avoid editing a file during a dependency rewrite, stop one server before starting another, inspect a diff before committing, and remember which test result belongs to which code state.

Native filesystems present mutable paths. Operating systems present processes, users, ports, and resource counters. These primitives are powerful, but they do not encode “Agent C is testing revision R42 in private while Agent A prepares a different candidate.” When hundreds of agents act independently, the human conventions that made one shared machine understandable stop scaling.

A filesystem is like warehouse shelving: a path tells you where an object sits, not which work order owns it. One worker can remember that context. A hundred concurrent workers need the context recorded by the system.

The ceiling therefore is not the number of processes the kernel can launch. It is the number of concurrent coding tasks the runtime can keep isolated, attributable, reviewable, and safe to integrate.

### Two ways parallel agents go wrong

The two common layouts fail differently.

```text
Shared workspace                       Isolated workspaces

Agent A ─┐                             Agent A → Workspace A ─┐
Agent B ─┼→ one mutable checkout       Agent B → Workspace B ─┼→ integrate later
Agent C ─┘                             Agent C → Workspace C ─┘

direct interference                    partial visibility
```

In a shared workspace, every agent sees current state—but “current” may mean halfway through another agent’s rewrite. Files, build output, processes, ports, and resources collide directly.

In isolated workspaces, agents stop overwriting one another. Each agent also loses direct access to another’s uncommitted files, process state, and test context. Messages carry descriptions; patches meet later.

One layout shares too much mutable state. The other shares too little verifiable state.

![Agents in one shared workspace encounter interference, while agents in separate private workspaces encounter late integration; both paths reach a concurrency ceiling.](../assets/diagrams/part-1/09-01-two-concurrency-failures.png)

*Figure 9.1 — Isolation removes direct collisions but still requires verifiable coordination and integration.*

A workspace runtime can instead give each agent a private writable session over the same recorded project history, followed by controlled publication. Agents share the codebase without sharing half-written files.

### Shared execution turns every action into somebody else’s input

Three agents begin from revision R42:

- Agent A upgrades a dependency.
- Agent B changes a shared authentication interface.
- Agent C runs integration tests.

Agent C starts testing. Agent A replaces dependencies and rewrites the lockfile. Agent B changes the interface before updating every caller. A test worker reloads code from disk and sees parts of both transitions. Agent A starts a preview server on port 3000; Agent C’s harness connects to it instead of its intended service.

Agent C reports that the tests pass.

Every local action was plausible. The evidence is meaningless because nobody can name the project state that was tested.

The failure is larger than a file conflict. Agent C may have loaded one module before Agent B’s edit and another afterward. Its dependency graph may change during the run. A successful HTTP check may have reached Agent A’s preview server. Even if `git diff` shows no overlapping lines, the test result describes a project state that never existed as one stable revision.

The operating system permits this. Most actions succeed, and inconsistency appears later. Port 3000 has no opinion about who planned better.

### Isolated A2A teams and CooperBench

Separate checkouts or containers remove direct interference. They do not remove dependency between tasks.

One agent may upgrade a library while another codes against the previous API. Both patches can be internally consistent and mutually incompatible. Messaging helps agents exchange plans, but a message cannot prove the sender’s current files, latest test state, or complete delta.

A2A chat is a meeting, not a database.

The runtime still needs a source of truth for code state, process state, resource ownership, evidence, and publication. Messages should coordinate decisions rather than carry the entire audit trail.

[CooperBench](https://arxiv.org/abs/2601.13295) studies this second failure mode. Two agents receive separate Docker-based environments initialized from the same repository state. They communicate through natural-language messages, and their patches are merged and tested afterward.

Across more than 600 tasks from 12 libraries and four languages, cooperating agents succeeded about 30% less often on average than comparable solo agents. A smaller 46-task experiment found success declining as the team grew from two to four agents. That small scaling experiment is evidence of a coordination problem, not a universal scaling law.

| Observation | Infrastructure lesson |
| --- | --- |
| Agents duplicated work or developed divergent designs | Messages do not provide authoritative ownership or compatible intermediate state |
| Communication reduced naive merge conflicts but did not significantly improve overall success | Textual integration is weaker than system integration |
| Successful messages referred more often to concrete files and lines | Coordination improves when it can point to inspectable state |
| Failures included unverifiable expectations and commitments | Agents need runtime evidence as well as prose |

The conclusion is narrow: A2A messaging can coordinate intent, but it cannot be the sole source of truth for code, execution state, resources, or tests. CooperBench does not show that messaging is useless, nor that agents should return to one shared mutable directory.

> *🚧 **Coordination rule:** Give agents private workspaces and a system-level way to inspect, attribute, and integrate their work.*

### A clean merge can still be broken

Two edits may touch different lines and merge cleanly while breaking the system. One agent can rename a configuration key while another adds a consumer of the old name. One can upgrade a library while another writes against its old API.

The same problem appears beyond source text. One change may remove a service while another adds a test that expects its port. One may regenerate a client from a new schema while another hand-edits the previous generated file. Textual independence does not imply behavioral independence.

A clean merge can produce a very cleanly broken program.

Branches record source history. Worktrees separate working files. Copies duplicate more state. Containers isolate configured files, processes, and networks. Each solves part of the problem.

| Approach | Separates well | Still needs an answer for |
| --- | --- | --- |
| Git worktree | Working files | Processes, ports, resources, cleanup, and integration |
| Directory copy | Files and some generated state | Efficient history, attribution, and publication |
| Container | Configured filesystem, process, and network state | Project lineage, changesets, provenance, and publication policy |
| Private workspace session | Task-owned writable and runtime state over a recorded base | Shared-history review and publication decisions |

Git is excellent at comparing text. It is not a runtime coordinator.

### Four challenges of running coding agents in parallel

The gap between native machine primitives and agent work appears as four challenges:

1. **Private execution and controlled publication.** A shared writable tree exposes changes immediately, while a native filesystem has no task-level base-and-publish contract. Agent work needs a stable base, private mutation, and a separate transition into shared history.
2. **File and line-level auditability.** Paths, users, and timestamps do not identify the agent task that introduced a published line. Reviewers need session and operation provenance.
3. **Resource ownership and observability.** PIDs, ports, CPU, memory, disk, and I/O must be grouped by agent work rather than inspected as unrelated machine objects.
4. **Lifecycle, validation, and recovery.** Process exit is narrower than task completion. The runtime must capture evidence, report publication or rejection, and clean up or preserve the session for repair.

Resource ownership deserves the same precision as file ownership. Operators should be able to ask which session owns a server, which task is consuming memory, whether two agents requested the same port, and how much disk a private delta occupies. Those facts help diagnose failures, enforce budgets, and decide which workload to stop without guessing from process names.

Auditability also has to survive publication. A changeset should retain its session and base identity after it becomes shared history, so a reviewer can move from a published line back to the task, commands, and evidence that produced it.

Isolation and publication belong together. A private workspace without integration is an island; publication without private execution accepts evidence produced under ambiguous conditions.

The requirements reinforce one another. Auditability needs a stable session identity. Resource ownership needs the same identity. Publication needs the session’s base and changeset. Recovery needs the private state and evidence associated with a rejection. Implementing each as a separate log with unrelated identifiers recreates the ambiguity in a more expensive form.

Files, processes, resources, changesets, and publication all need an owner. “The agent” is too broad because one agent may run many calls or keep one workspace across several commands. The next chapter defines the smaller boundary that owns one unit of work.

---

## Chapter 10 — Workspace Sessions at the Tool-Call Boundary

After the failed test run, the orchestrator asks:

> What belongs to Agent C’s work?

Git can list modified files. The process table can list workers. The network stack can identify who owns port 3000. None naturally connects those facts to one agent task and one project base.

The missing object is a **workspace session**: a bounded, attributable period of work over a recorded project state.

The workspace session adds the agent-level identity absent from native process and filesystem abstractions. It groups a project base, private files, command processes, network context, resources, changeset, and publication outcome under one lifecycle.

The default boundary is deliberately small:

```text
one independent tool call
    → one private workspace session
    → one attributable execution result
    → publish or reject
    → cleanup
```

For command execution, v1 applies this workspace-per-tool-call rule automatically. When the caller supplies no session ID, the runtime creates a private session, runs the command, captures its result, attempts publication, and tears the session down. Related calls share state only when the caller deliberately places them in a longer-lived explicit session.

Sessionless file writes currently follow a different path, so “one tool call, one session” is the design rule rather than a universal v1 implementation fact.

> *⏳ **Workspace-per-tool-call rule:** Every independent command tool call receives a workspace session by default. Related calls may explicitly join the same longer-lived session.*

| Operation | v1 behavior |
| --- | --- |
| Command without session ID | Automatic publish-then-destroy workspace session |
| Command with session ID | Runs inside the named explicit session |
| File edit or write with session ID | Mutates that session’s private workspace |
| File edit or write without session ID | Publishes an operation-owned layer directly |

### Follow one workspace from base to publication

Carry Agent C’s failed test run forward:

```text
Agent C → request Q91 → session S17 → base R42
        → test process + port 3000 → changeset C8
        → publication rejected against R43
```

This trace introduces the five objects that carry the contract:

- **Base R42** is the recorded project state from which work begins.
- **Workspace session S17** owns the private execution period.
- **Private delta** is everything S17 changed before publication.
- **Changeset C8** is the captured candidate derived from that delta.
- **Publication** resolves C8 against current shared history, now at R43.

**LayerStack** is the immutable shared history that records those bases and accepted results. The **sandbox** is the execution environment hosting S17. Artifacts such as logs or build outputs can be retained as evidence without silently becoming project history.

![Shared project history feeds three private workspace sessions whose deltas pass through a publication gate to either a new revision or rejection.](../assets/diagrams/part-1/10-01-workspace-contract.png)

*Figure 10.1 — Agents share recorded history, not one mutable working directory.*

### Automatic and explicit sessions

The normal case is a workspace session per tool call. When `exec_command` arrives without a `workspace_session_id`, Ephemeral Sandbox creates an automatic workspace session with a publish-then-destroy finalization policy. The caller receives a private execution boundary without manually managing every short-lived workspace.

The automatic session carries its LayerStack base, private writable view, execution identity, network profile, and finalization policy.

![A command creates a workspace session, executes inside it, publishes or rejects the result, retains the changeset and evidence, and destroys the temporary workspace.](../assets/diagrams/part-1/10-02-automatic-session-lifecycle.png)

*Figure 10.2 — Each independent tool call gets a temporary workspace; accepted work and retained evidence are durable.*

For a multi-step task, the orchestrator creates an **explicit session** and passes its ID across edits, commands, inspection, and retries. Successful publication closes the session. Destruction discards unpublished state. A rejected pre-commit publication can leave the workspace available for diagnosis or repair.

That retained state is useful. An agent can inspect the conflict, re-read the active project head, adjust its private work, rerun validation, and try again. Rejection becomes a visible branch in the lifecycle rather than a reason to reconstruct the failed workspace from logs.

There is also a narrower command-execution session—the PTY, streams, timeout, and process group for one command. Closing it does not imply that the longer workspace is ready to publish.

#### Why each tool call gets a workspace

A tool call already has a request identity, inputs, a start time, a terminal result, and a caller waiting for an answer. Giving it a workspace session turns those familiar fields into a bounded state transition.

The boundary is small enough for attribution: a command’s processes, files, and evidence belong to one request. It is also composable. An orchestrator can use several automatic calls for independent work, or explicitly place related calls inside one longer session.

If the command times out, publication conflicts, or cleanup retries, the runtime knows which private state and lifecycle record are involved. Several automatic calls can remain independent, while related calls can explicitly join one longer session.

### Private delta, changeset, and publication

Inside a session, the agent sees a normal writable tree. The runtime keeps its stable base separate from a private copy-on-write delta.

That delta may mix desired edits with generated output, caches, logs, deletions, and partial results. **Capture** converts mutable state into a candidate changeset. It answers “What changed from this base?” Publication answers the separate question “Can this candidate enter current shared history?”

This separation prevents an ordinary file write from silently becoming shared truth. It also gives the runtime a place to apply path policy, exclude runtime-owned state, preserve deletion semantics, and describe the candidate before integration.

Shared history may have advanced. Ephemeral Sandbox resolves the complete candidate path by path. Eligible text files can use line-level three-way merging. Disjoint or identical edits may combine; overlapping different edits conflict. Binary and oversized files can reject.

The result is all-or-reject: one accepted immutable layer or no shared change.

All-or-reject matters when a changeset touches ten paths and only one conflicts. Publishing the other nine would create a result the agent never validated as a unit. Rejection preserves the candidate’s integrity and lets the orchestrator decide whether to rebase, repair, retry, or abandon it.

Private execution may be speculative, but shared history receives one complete result or none of it. Conflict becomes normal control flow rather than filesystem damage.

### Ownership should follow the session

A session ID joins evidence that may live in different stores: process samples, command transcripts, filesystem changes, publication events, and diagnostics. Return to Agent C’s trace:

```text
request Q91 → session S17 → base R42
    → test process + port 3000
    → changeset C8 modifies auth/client.ts
    → publication result against R43
    → file blame records workspace_session:S17
```

For published files, Ephemeral Sandbox can record structural line origins such as `workspace_session:<id>`, `operation:<id>`, original content, or unknown origin. This identifies the unit of work that introduced bytes into shared history, even when a formatter or generator produced them.

#### Git blame and file blame answer different questions

The official [`git blame` documentation](https://git-scm.com/docs/git-blame) describes it as annotating each line with the revision and author that last modified it. That is source-control history.

Agent auditing begins earlier. A tool call chose a base, created a workspace, ran processes, changed files, produced evidence, and submitted a changeset. Several agent outputs may later be squashed into one commit or published under one service identity. Git faithfully records that commit history; it cannot reconstruct runtime ownership that the commit never encoded.

| Question | Git blame | Ephemeral Sandbox file blame |
| --- | --- | --- |
| Primary identity | Revision and recorded author | Workspace session, operation, original, or unknown origin |
| History | Git commit ancestry | Published LayerStack ancestry |
| Main use | Which revision last changed this line? | Which runtime unit introduced this line? |
| Execution evidence | Requires a separate mapping | Joins to session, changeset, event, and trace records |
| Squashed or service-authored publication | Several tasks may appear as one identity | Runtime origins remain structurally distinct |

Git blame is the publication stamp: which edition changed the sentence and who signed it. File blame is the workshop ticket: which agent session delivered it to publication.

The difference becomes especially visible when an orchestrator publishes many tasks under a bot account. Git blame may correctly name the bot and integration commit for every affected line. That is enough to navigate repository history, but too coarse to answer which agent task, base revision, tests, or runtime events produced a particular line.

Both are useful. A complete audit can follow:

```text
published line
    → workspace-session owner
    → base + changeset + execution evidence
    → LayerStack revision
    → Git commit or export, when created
```

A Git commit records source history; a workspace session records agent work. A useful audit trail preserves the link between them.

Resource ownership should use the same session identity. Current v1 observability includes sandbox-level CPU, memory, block-I/O, disk, execution activity, and process diagnostics at supported scopes. Authoritative per-session CPU and memory accounting, budgets, and occupied-port inventory remain broader contract goals.

The eventual operator view should connect a code change to the resources that produced and validated it: which process tree ran, which port exposed the preview, whether memory pressure affected the tests, and how much private disk state the task created. Measurement, policy, and cleanup all become simpler when they share the workspace-session key.

### Three questions for a workspace runtime

A reader can test the contract with three questions:

1. Can the runtime name the session’s project base?
2. Can it distinguish private runtime state from the candidate changeset?
3. Can it publish or reject the complete candidate while retaining attribution?

Failures should preserve those answers. A timeout must not erase ownership. A holder exit must not make cleanup appear successful. A stale base must not produce a partial publication. The runtime may retry internally, but its final state should remain inspectable to the orchestrator.

Chapter 11 shows how Ephemeral Sandbox uses that contract to raise the concurrency ceiling.

---

## Chapter 11 — Ephemeral Sandbox: Raise the Concurrency Ceiling for Multi-Agent Programming

Agents need private execution over shared project history. Their work needs an identity, a reviewable changeset, a publication result, and durable evidence.

> **Ephemeral Sandbox is an agent workspace runtime that gives concurrent coding tasks private execution state over shared project history, then turns completed work into reviewable, conflict-aware publication.**

Its default concurrency primitive is a workspace session per independent command tool call. The runtime does not merely launch another process inside a shared checkout: it gives the call a stable project base, private writable state, attributable execution, and an explicit publish-or-reject ending. Related tool calls share a workspace only when the caller deliberately joins them to an explicit session.

Think of it as a versioned workshop. Each agent receives a private workbench built from a cataloged project state. It may edit, build, test, and make a mess there. When ready, it submits a parts list and inspection record to the publication counter. Accepted design history survives after the workbench is cleared.

The workbench is an execution environment; the catalog and counter are a state system. Ephemeral Sandbox connects them through the workspace session.

Linux processes, namespaces, mounts, and filesystems remain the execution mechanisms. LayerStack, workspace sessions, changesets, and publication add the agent-facing semantics needed to use those mechanisms at higher coding concurrency.

### Ephemeral Sandbox in one view

LayerStack records shared project history. Private workspace sessions combine a copy-on-write project view with command execution and a selected network profile. Capture turns private work into a changeset; the publication gate accepts the complete candidate or rejects it. Events, traces, snapshots, resource data, diagnostics, and file provenance preserve the evidence.

![An agent or orchestrator enters Ephemeral Sandbox, where shared LayerStack history feeds private workspace sessions, a publication gate controls shared updates, and observability records runtime evidence.](../assets/diagrams/part-1/11-01-ephemeral-sandbox-overview.png)

*Figure 11.1 — Ephemeral Sandbox connects shared history, private execution, publication, and evidence.*

### Three agent-facing surfaces

| Surface | Responsibility |
| --- | --- |
| Management | Create, inspect, and destroy sandbox instances |
| Runtime | Create sessions, execute commands, edit files, capture, publish, and destroy |
| Observability | Read events, traces, snapshots, resources, activity, diagnostics, and provenance |

CLI and MCP expose these groups to humans and agents. The separation lets an inspector use read-only observability, a worker receive runtime operations, and an infrastructure service own management.

For an external orchestrator, these surfaces make the sandbox a service: the agent remains outside and calls runtime operations through RPC or MCP. An embedded agent can run inside the environment while its controller still uses the same management and observability boundaries. In both modes, the workspace session remains the unit of private work.

### From the product model to the workspace

Part I began with tool-call side effects, found the multi-agent concurrency ceiling, and introduced the session and publication boundary that make work attributable.

Ephemeral Sandbox is the runtime built around that model. Part II follows the
next tool call into its workspace-session boundary and shared history:

```text
tool call → workspace session → LayerStack lease
```

It explains automatic and explicit session lifecycles, then shows how many
temporary workspaces can share stable LayerStack history. Part III constructs
their private COW views and follows them through capture and publication.

---

## References

1. Arpandeep Khatua et al., [“CooperBench: Why Coding Agents Cannot Be Your Teammates Yet”](https://arxiv.org/abs/2601.13295), arXiv:2601.13295, 2026.
2. Agent Infra Foundation, [“The Concurrency Ceiling of Coding Agents”](https://agent-infra-foundation.org/blog/2026/07/the-concurrency-ceiling-of-coding-agents/), 2026.
3. The Git Project, [`git-blame` documentation](https://git-scm.com/docs/git-blame).
4. Ephemeral Sandbox, [“Architecture”](https://ephemeral-sandbox.com/architecture).
5. Ephemeral Sandbox, [“Multi-Agent Coding Workspaces”](https://ephemeral-sandbox.com/multi-agent-coding-workspaces).
6. Ephemeral AI Lab, [`ephemeral-sandbox` source repository](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox).
