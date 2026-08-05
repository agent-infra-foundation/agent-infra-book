# Part II — Shared History and Workspace Sessions

*How every unit of agent work receives a private workspace over stable,
reusable project history.*

Part I showed why native process and filesystem primitives become ambiguous
when many coding agents share one codebase. Part II begins at the missing
boundary: the workspace session that owns one unit of work.

This part follows the model from the outside in:

1. what happens to an agent tool call;
2. how many sessions share stable project history; and
3. how LayerStack represents that history with layers, manifests, and leases.

Part III will take the resulting lease and construct the private copy-on-write
filesystem in which commands actually run.

---

## Chapter 12 — Workspace Session Per Tool Call

Two agents are working on the same codebase at published revision R42.

- Agent A must upgrade the authentication dependency and run its tests.
- Agent B must regenerate the API client and run the integration suite.

The orchestrator issues two independent command tool calls:

```text
Agent A / request Q91
  exec_command("cargo update -p auth-sdk && cargo test auth")

Agent B / request Q92
  exec_command("./scripts/regenerate-client && cargo test api")
```

A conventional shell needs a directory and a process. It can start both
commands in `/repo` and return two process IDs:

```text
Agent A / command C31 ─┐
                       ├── /repo   one mutable checkout
Agent B / command C32 ─┘
```

That is enough to execute the commands. It is not enough to explain their
results.

Agent A may rewrite `Cargo.lock` while Agent B is resolving dependencies. Agent
B may replace generated client files while Agent A's test workers are still
loading modules. Both commands may write to the same build directory, and both
integration suites may expect port 3000. A command can exit successfully after
observing a mixture of states that never existed as one recorded revision.

The shell still has a working directory, two process trees, and two exit codes.
What it lacks is the agent-work context that Part I identified:

| Question | Conventional shell answer | Agent workspace answer |
| --- | --- | --- |
| Which project state did this command test? | “Whatever `/repo` contained while it ran” | Recorded base R42 |
| Which filesystem changes belong to it? | One combined working-tree diff | A private delta owned by S17 or S18 |
| Which processes, ports, and resources belong to it? | Separate PIDs and machine counters | One session-scoped runtime identity |
| Can its files become shared state? | They are already visible in `/repo` | Capture, then publish or reject |
| What does completion mean? | The parent process exited | Command settled, publication resolved, cleanup recorded |

For multi-agent coding, a command must therefore be more than a process started
in a directory. It must be a bounded state transition with a stable beginning,
a private middle, an attributable result, and an explicit ending.

An independent tool call is a useful default boundary because the orchestrator
can already name it: it has a request ID, inputs, a start, and one terminal
response. An agent identity is too broad—one agent may perform many unrelated
tasks. A PID is too narrow—one command may create a process tree, files, ports,
and background workers. The workspace session wraps the complete machine event
that one independent call caused. Related calls share state only by explicitly
joining a longer-lived session.

Ephemeral Sandbox gives the two calls separate workspace sessions over the same
recorded project history:

```text
shared LayerStack revision R42
    ├── request Q91 → workspace S17 → command C31 → private delta A
    └── request Q92 → workspace S18 → command C32 → private delta B
```

Now Agent A cannot rewrite the files Agent B is currently reading. Each
command's process tree, transcript, and filesystem delta have one owner; port
and resource observations can be correlated with the same session identity.
Each test result names the base and private state it actually exercised. When a
call ends, its candidate changes cross a publication boundary instead of
leaking into the other call halfway through.

That gives an agent workspace runtime a more complete answer:

```text
tool call
    ↓
private workspace session over a stable project revision
    ↓
command execution and private filesystem changes
    ↓
publish or reject
    ↓
destroy the temporary workspace
```

That temporary workspace is the central idea of this part. Ephemeral Sandbox
creates an automatic workspace session for each independent command tool call.
When several operations intentionally belong to one task, they can target the
same explicit session instead.

Both forms begin from shared **LayerStack** history. They share accepted project
state, not unfinished writes. A lease keeps each session's starting revision
stable even if another session publishes while it is running.

Agent A's dependency update from the opening fits one independent command. Agent
B's work may grow into a sequence: regenerate the client, inspect a failed API
test, edit `src/server.rs`, and run the test again.

Those tasks need different lifecycles. Agent A's command can receive a temporary
workspace that finalizes automatically. Agent B's related operations need one
workspace that remains private between calls.

The unit of isolation is therefore not “one folder per agent.” It is one
**workspace session per bounded unit of filesystem work**.

### Automatic workspace: one independent command

When `exec_command` arrives without a `workspace_session_id`, the runtime creates
an automatic workspace session with the fixed finalization policy
`publish_then_destroy`:

```text
independent exec_command
        ↓
create private workspace S17
        ↓
run command C31
        ↓
capture and attempt publication
        ↓
destroy S17
```

The caller does not need a separate create-and-destroy sequence for one bounded
command. The runtime gives the command a stable base, private writable state,
process ownership, a transcript, and an explicit ending.

`publish_then_destroy` describes ordering, not guaranteed acceptance. The
command may succeed while publication rejects a conflict. The runtime records
that result and destroys the temporary workspace without changing shared
history.

This is the precise meaning of **workspace session per tool call** in v1: it is
the default boundary for an independent `exec_command`, not a claim that every
kind of runtime operation creates a workspace.

### Explicit workspace: one related sequence

Agent B's second test must see the edit made before the first test. Its
operations deliberately target the same explicit workspace S18:

```text
workspace S18 over leased revision R42
        ↓
file edit
        ↓
command C32
        ↓
inspect private files and output
        ↓
second edit
        ↓
command C33
        ↓
explicit finalization
```

Passing `workspace_session_id: S18` makes file and command operations use the
same mounted project view. C33 sees the work performed before C32. Other
sessions do not.

Finishing C32 does not publish or destroy S18. The workspace owner decides when
the multi-operation task is ready to finalize—or when its private state should
be discarded.

![An automatic command receives a temporary workspace that publishes or rejects before destruction, while an explicit workspace persists across an edit and two commands until deliberate finalization.](../assets/diagrams/part-2/14-01-automatic-vs-explicit-sessions.svg)

*Figure 12.1 — Independent commands use automatic sessions; related operations
deliberately reuse an explicit workspace.*

### The session ID chooses a lifecycle

The public runtime surface distinguishes calls with and without a workspace
session ID:

| Operation | Without `workspace_session_id` | With `workspace_session_id` |
| --- | --- | --- |
| `exec_command` | Creates an automatic `publish_then_destroy` workspace | Runs inside the selected workspace |
| `file_read` | Reads the latest published snapshot | Reads the selected private workspace |
| `file_write` / `file_edit` | Publishes a layer attributed to `operation:<request_id>` | Mutates the selected workspace and remains private until capture |

Adding a session ID is not cosmetic routing. It changes both the state an
operation can observe and the lifecycle of its mutations.

A sessionless read sees the latest published snapshot. A read in S18 sees its
leased base plus S18's private edits. A sessionless file write publishes one
small operation-attributed layer directly; a write in S18 remains private so
the agent can edit, test, and revise before publication.

The [operation catalog](https://ephemeral-sandbox.com/docs/reference/operations)
and [core-concepts guide](https://ephemeral-sandbox.com/docs/concepts) document
these behaviors.

> *⏳ **Tool-call boundary rule:** Give an independent command an automatic
> workspace. Give deliberately related operations the same explicit workspace.*

### Three runtime lifetimes and one shared history

Four names are enough to describe the model:

| Object | Lifetime | What it owns |
| --- | --- | --- |
| Sandbox | Managed runtime lifetime | The environment in which workspaces run |
| LayerStack | Durable project lifetime | Accepted filesystem history |
| Workspace session | Bounded task lifetime | Stable base, private files, and finalization |
| Command session | Process lifetime | One process and its transcript |

Their relationship is easier to remember as a small tree:

```text
Sandbox
  ├── LayerStack: shared published history
  ├── Workspace S17: one bounded task
  │     └── Command C31
  └── Workspace S18: one related sequence
        ├── Command C32
        └── Command C33
```

Destroying C32 does not erase S18's private files. Destroying S18 does not erase
LayerStack revision R42. Publishing S17 does not expose S18's unfinished work.
Each operation ends the lifetime it actually owns.

Explicit workspace creation and finalization are internal coordination surfaces
in v1 rather than public CLI or MCP tools. Public runtime calls can target an
existing session ID; the coordination layer owns the surrounding lifecycle.

### The task boundary is better than the agent boundary

One model process may handle several unrelated tasks. Keeping them in one
agent-owned folder lets parser output from one request influence a benchmark in
another. Separate automatic sessions remove that accidental dependency.

The reverse is also true. One repair may need an edit and several tests. Giving
every call an unrelated workspace would lose the edit between commands. An
explicit session preserves the intended dependency.

The ownership rule is:

> *A workspace session belongs to one bounded unit of filesystem work. That
> unit may be one independent command or several deliberately related
> operations.*

An orchestrator can move a task between models while retaining the same
workspace identity. A reviewer can inspect a session without becoming its
author. “Agent B's folder” becomes the more precise “workspace S18, based on
R42, for this task.”

### Process success is not workspace success

A command exit code describes a process. It does not describe the state of the
containing workspace:

```text
command status: success
workspace status: still private
publication status: not attempted
```

An automatic command can succeed while capture fails or publication rejects.
An explicit command can fail while its workspace remains available for
inspection and another attempt. These endings must remain separate and visible.

Now the unit of work is clear. The next question is what all of those temporary
sessions start from.

---

## Chapter 13 — One LayerStack, Many Stable Bases

Two coding tasks enter the same sandbox. Both need the repository, toolchain,
and accepted project state. They do not need the same writable checkout.

Ephemeral Sandbox keeps durable project history in one **LayerStack**. Each
workspace session leases one recorded revision and adds its own private delta:

```text
visible project = leased shared history + private delta
```

The shared half is reusable and immutable. The private half belongs to one
bounded task.

### Shared history is not a shared checkout

At revision R42, two sessions can begin from the same history:

```text
LayerStack at R42
    ├── workspace S17 + private delta A
    └── workspace S18 + private delta B
```

They reuse the bytes that already belong to R42. They do not copy those bytes
into two complete repositories, and they do not write back into R42. S17 records
Agent A's mutations in its own writable state. S18 does the same for Agent B.

This is not the shared mutable workspace rejected in Part I. Agents share
**published truth**, not a live directory tree. Agent B can read the same
accepted parser code as Agent A without seeing Agent A halfway through a
lockfile rewrite.

It is also more precise than copying the repository for every task. A copied
directory provides private files but does not identify the shared revision from
which they came. A workspace session binds that revision to a task, its private
state, commands, and finalization result.

### A lease keeps the starting revision stable

When S18 starts at R42, LayerStack gives it a snapshot and a **lease**. The
lease names the ordered history that forms the session's base and keeps that
history available while the session is alive.

If S17 publishes and the active head becomes R43, S18 does not change beneath a
running command. It continues to see leased R42 plus its own private delta.
When S18 later proposes a changeset, publication can compare its R42 base with
the current R43 head.

A lease is not a global project lock. It does not prevent another session from
publishing or a new session from starting at R43. It protects one reader's
stable floor and prevents cleanup from reclaiming layers that reader still
needs.

Think of checking out a specific library edition while newer editions continue
to arrive. The checkout does not close the library; it prevents page 80 from
changing while you read it. After this paragraph, call it a lease again—the
kernel does not manage books.

### Different sessions can lease different revisions

Suppose Agent A begins at R42. A publication creates R43 before Agent B begins,
and another creates R44 before Agent C begins:

```text
Agent A: lease R42 → [L42, S40, B1]             + private ΔA
Agent B: lease R43 → [L43, L42, S40, B1]        + private ΔB
Agent C: lease R44 → [L44, L43, L42, S40, B1]   + private ΔC
```

All three sessions can remain active. Each sees the complete ordered history at
its lease point plus its own private delta. None rewrites the layers below it.

![A newest-first LayerStack contains L44, L43, L42, S40, and B1. Agent C leases revision R44, Agent B leases R43, and Agent A leases R42; each receives a private workspace and private delta over its stable history.](../assets/diagrams/part-2/13-01-different-leased-revisions.svg)

*Figure 13.1 — Concurrent sessions may keep different stable LayerStack
revisions.*

### Sharing the base removes one cost, not every cost

LayerStack avoids an `N × base` repository clone when N sessions begin from the
same history. Each session still pays for its own metadata and copy-on-write
mutations.

The honest storage model is:

```text
one shared base
+ retained published history
+ sum of private deltas
+ per-session runtime metadata
```

If ten agents each rewrite a different 100 MB generated file, their private
deltas still consume that space. Processes, command transcripts, and runtime
metadata also scale with concurrency.

The useful claim is narrower: **many workspaces can reference one immutable
project history without copying or mutating that history.**

The next chapter opens LayerStack itself and explains how that history is
represented.

---

## Chapter 14 — Inside LayerStack: Layers, Manifests, and Leases

Agent A and Agent B both open `src/server.rs` at R42. Each reads the same
published file until its private workspace changes that path. This behavior
starts below the workspace, in LayerStack.

**LayerStack is an ordered manifest of immutable filesystem layers.** A layer
can contain files, directories, symlinks, and deletion metadata. The manifest
defines which layers form a published revision and the order in which paths are
resolved.

LayerStack owns filesystem history, revision identity, leases, and publication
state. It does not launch shells or isolate processes. Those belong to the
workspace runtime built over it.

### Three kinds of immutable layer

| Layer kind | Purpose | Mutable after creation? |
| --- | --- | --- |
| Base, `B*` | Initial content-addressed project state | No |
| Published, `L*` | Accepted filesystem delta | No |
| Squashed, `S*` | Equivalent compact form of older history | No |

A base layer such as `B000001-base` contains the starting project. Accepted
publication creates an `L*` layer and prepends it to the active manifest.
Squashing may later replace eligible older layers with an equivalent `S*`
layer. Squashing changes physical layout, not the visible project.

Once a layer appears in a manifest, it is history—not a shared scratchpad.

### Newest first, first visible path wins

Suppose revision R42 contains:

```text
L000042       newest published delta
S000041       compacted earlier history
B000001-base  original project payload
```

A read of `src/server.rs` searches in that order. If L42 contains the file, its
version wins. Otherwise the read falls through to S41 and then B1. A deletion
marker in a newer layer can hide a path that still exists below it.

The [LayerStack architecture](https://ephemeral-sandbox.com/architecture/layerstack)
preserves this ordering through OverlayFS: publication prepends the newest
layer, a lease copies the ordered paths, and the first lower path receives the
highest lookup priority.

Array order becomes filesystem truth.

### A revision identifies exact ordered history

The active manifest carries a version, ordered layer references, and a schema
version. Ephemeral Sandbox also computes a root hash from the ordered layer
identities and paths.

Together, manifest version, root hash, and layer count describe the base held
by a workspace:

```text
workspace session: S18
manifest version: 42
root hash: H42
lower-layer count: 3
```

The version is convenient for logs. The root hash protects the stronger fact:
exactly which ordered history produced this view. The same layers in a
different order do not represent the same filesystem.

### Leases connect history to live workspaces

A lease stores the manifest snapshot and its resolved lower-layer paths. It
serves two purposes:

1. a running workspace keeps the exact history from which it began; and
2. storage maintenance knows which layers are still in use.

This is why squashing and garbage collection must respect active leases. A
maintenance pass may compact unleased older history, but it cannot remove the
floor beneath S18 merely because R43 is now active.

Long layer chains also have a cost. Creating a workspace must construct the
ordered lower-path list, and a read may traverse layers before finding a visible
path. Squashing shortens eligible old chains; it is maintenance, not magic
compression after every command.

### The four guarantees Part II establishes

The complete model can now be stated without introducing another object:

> **History is shared.** Published layers can serve many sessions.

> **The execution base is leased.** A live workspace keeps the revision from
> which it started.

> **Mutation is private.** Unfinished writes remain outside shared history.

> **Publication is atomic.** A resolved candidate enters history as one layer,
> or none of it does.

LayerStack cannot stop a process from consuming memory, opening a port, or
producing incorrect code. Execution, resources, validation, and publication
policy handle those responsibilities in later parts.

![One immutable LayerStack feeds three separate private workspace sessions; each has a small private delta, and accepted publication returns one new layer to shared history.](../assets/diagrams/part-2/12-01-one-layerstack-many-sessions.svg)

*Figure 14.1 — One LayerStack supplies stable history to many private sessions;
only accepted work returns as a new shared layer.*

Part II has identified the unit of work and the stable history beneath it. Part
III begins at the kernel boundary: OverlayFS combines the leased lower layers
with a private `upperdir` and `workdir` to create the writable view in which the
agent works.

---

## References

1. Ephemeral Sandbox, [“Agent Sandbox for Parallel Coding Agents”](https://ephemeral-sandbox.com/).
2. Ephemeral Sandbox, [“Core Concepts”](https://ephemeral-sandbox.com/docs/concepts).
3. Ephemeral Sandbox, [“Operations Reference”](https://ephemeral-sandbox.com/docs/reference/operations).
4. Ephemeral Sandbox, [“Architecture Overview”](https://ephemeral-sandbox.com/architecture).
5. Ephemeral Sandbox, [“LayerStack Store and Copy-on-Write”](https://ephemeral-sandbox.com/architecture/layerstack).
6. Ephemeral Sandbox, [“Multi-Agent Coding Workspaces”](https://ephemeral-sandbox.com/multi-agent-coding-workspaces).
7. Ephemeral AI Lab, [`ephemeral-sandbox` source repository](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox).
8. Ephemeral AI Lab, [`exec_command` operation contract](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/blob/main/crates/sandbox-operations/catalog/src/runtime/command.rs).
9. Ephemeral AI Lab, [runtime file-operation contracts](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/blob/main/crates/sandbox-operations/catalog/src/runtime/file.rs).
10. Ephemeral AI Lab, [workspace lifecycle implementation](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/tree/main/crates/sandbox-runtime/workspace/src).
11. Ephemeral AI Lab, [LayerStack implementation](https://github.com/Ephemeral-AI-Lab/ephemeral-sandbox/tree/main/crates/sandbox-runtime/layerstack/src).
