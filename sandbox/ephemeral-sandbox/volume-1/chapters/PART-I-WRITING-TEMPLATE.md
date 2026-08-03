# Part I Editorial Blueprint: The Concurrency Ceiling of Parallel Coding Agents

## Purpose of Part I

Part I should show why native OS and filesystem primitives become a coordination
bottleneck for parallel coding agents, then give readers a mental model for why
agent workspaces exist before explaining how Ephemeral Sandbox is built.

The four chapters form one argument:

```text
native OS and filesystem primitives expose processes, paths, and ports
        ->
human developers normally provide task ownership and serialization
        ->
parallel agents interfere or lose verifiable context
        ->
safe cooperation needs an explicit workspace contract
        ->
Ephemeral Sandbox assembles that contract into one workspace runtime
```

Part I is successful when readers can describe the problem and the required
contract without referring to a particular product architecture.

## Reader Starting Point

Assume the reader:

- has used a terminal and Git, but may never have built a container or sandbox;
- thinks of an agent primarily as a chat interface;
- may use "branch," "workspace," "container," and "sandbox" interchangeably;
- does not yet know namespaces, overlay filesystems, cgroups, content-addressed
  storage, or three-way merge internals;
- wants to understand why the infrastructure exists before reading its code.

Part I therefore starts with visible effects and familiar developer problems.
It should not begin with Linux primitives, crate names, or an architecture map.
Each technical term is introduced only after the reader has encountered the
problem that the term solves.

## What We Learn from Hello Agents—Without Copying Its Formula

The reference chapter uses a useful explanatory sequence:

1. Welcome the reader with concrete questions and a simple overview figure.
2. Give a concise definition before introducing implementation detail.
3. Build concepts progressively, with each new idea answering a limitation in
   the previous idea.
4. Compare categories along explicit dimensions instead of presenting a flat
   list of products or terms.
5. Reuse one running example across definitions, diagrams, and mechanisms.
6. Explain the operating loop before showing implementation detail.
7. Follow the implementation with an annotated trace of a successful run.
8. Close by synthesizing the main ideas and pointing forward.

We should use those teaching principles, not duplicate its section order. Our
subject needs a different shape: it is an infrastructure argument spread over
four chapters, not a general introduction followed by one large programming
tutorial.

Our Part I should therefore use this reader journey:

```text
observe -> name -> compare -> model -> qualify the claim
```

- **Observe:** Show a concrete agent action or failure.
- **Name:** Introduce the smallest amount of vocabulary needed to explain it.
- **Compare:** Contrast plausible solutions along one clear dimension.
- **Model:** Give the reader a diagram or invariant they can reuse.
- **Qualify the claim:** State the trust assumptions and limits.

These are learning moves, not mandatory heading names. The chapters below use
different sections because they answer different kinds of questions.

## Part I Opening

Open with one short question: what happens when an agent stops producing text
and starts operating a computer? Reveal the four state surfaces—files,
processes, network, and resources—without adding a separate opening diagram.

Include one plain-language promise in the early prose:

> A sandbox is a set of boundaries around what a program can see, change, use,
> and publish. Different sandboxes draw different boundaries.

This gives beginners a working definition without pretending that all sandbox
products provide the same guarantees.

## The Running Scenario

Use one scenario throughout Part I:

> A maintainer delegates one repository to three coding agents. Agent A updates
> a dependency, Agent B edits a shared module, and Agent C runs an integration
> server. They begin from the same revision and are expected to return three
> reviewable results.

Increase the pressure one chapter at a time:

| Chapter | Scenario state | Question created for the next chapter |
| --- | --- | --- |
| 8 | One agent edits files, starts processes, opens ports, and consumes resources. | What changes when several agents do this at once? |
| 9 | Shared agents interfere directly; isolated A2A agents lose verifiable intermediate context and integrate late. | What must a workspace promise to prevent ambiguity? |
| 10 | The workflow gains an immutable base, private sessions, deltas, changesets, and publication. | Which of these promises does Ephemeral Sandbox v1 actually enforce? |
| 11 | The contract becomes one Ephemeral Sandbox product model. | How does a request travel through the implementation? |

Do not reset the story at the start of every chapter. Each opening should begin
from the consequence left by the previous chapter.

## Part I Chapter Map

### Chapter 8: Agents Are Processes with Side Effects

**Reader question:** What does a coding agent actually do to a computer?

**Opening incident:** An agent completes a small dependency upgrade, but leaves
behind modified files, a package cache, a server process, a bound port, and a
large test log.

**Core definition:** A coding agent uses a runtime whose tool calls become real
operating-system operations. Their effects can outlive individual model turns.

**Progression:**

```text
chat response -> tool call -> process -> side effect -> persistent runtime state
```

**Sections:**

1. **The Moment an Agent Touches a Computer** — begin with a familiar coding
   task and follow its first tool call.
2. **An Agent Is More Than a Chat Window** — separate the model's decision loop
   from the operating-system processes that perform work.
3. **Four Surfaces an Agent Changes** — introduce filesystem, process, network,
   and resource state with one example each.
4. **What Persists After the Answer** — distinguish transient output from
   durable or leaked state.
5. **The Smallest Useful Meaning of Sandbox** — define a boundary by the
   question it answers, not by a product category.
6. **One Agent Run, Fully Explained** — narrate one execution from request to
   cleanup, annotating every state change.
7. **What We Can Now Ask of a Runtime** — derive initial requirements and lead
   into concurrency.

**Figure to produce:**

- **Figure 8.1 — One Tool Call Creates Machine State:** agent -> tool -> files,
  processes, network, and resources.

**Tables to produce:**

- **Table 8.1 — Actions and Their Effects:** action, OS-level effect, who can
  observe it, how long it persists, and how it is cleaned up.
- **Table 8.2 — Boundary Questions in Plain English:** "Can it read this?",
  "Can it change this?", "Can it consume all of this?", and "Can it make this
  shared?" mapped to filesystem, process, network, resource, and publication
  boundaries.

**Repository connection:** Introduce only the runtime surfaces that can be
verified in Ephemeral Sandbox. Do not explain the full request path yet.

**Worked trace:** Follow a harmless command sequence and inventory every
observable side effect, including those a normal shell transcript misses.

**Exit question:** If one agent has this many effects, what happens when three
agents share the same environment?

### Chapter 9: Why Coding Agents Hit a Concurrency Ceiling

**Reader question:** Why can adding more coding agents reduce the probability
that the project finishes correctly?

**Opening incident:** Continue the running scenario. Show three agents making
reasonable decisions in one shared checkout while files, tests, a server, and a
port change underneath one another.

**Core definition:** The concurrency ceiling is the point at which additional
agents create more interference, coordination, integration, and diagnosis work
than useful progress.

**Two failure modes:**

| Layout | Immediate benefit | Characteristic failure |
| --- | --- | --- |
| Shared mutable workspace | Every agent sees current state | Direct interference across files and runtime resources |
| Isolated workspaces with A2A messages | Agents cannot overwrite one another while working | Partial observability, unverifiable claims, and late integration |

**Sections:**

1. **Two Ways Parallel Agents Go Wrong** — introduce both failure modes before
   recommending a workspace design.
2. **Shared Workspace: Every Action Is Somebody Else's Input** — follow the
   three-agent collision timeline.
3. **Isolated A2A Teams and CooperBench** — explain how isolation defers the
   collision, using CooperBench as evidence without treating A2A as useless.
4. **A Clean Merge Can Still Be Broken** — separate textual merging from system
   correctness.
5. **Four Challenges of Running Coding Agents in Parallel** — explicitly name
   private execution and publication, file and line auditability, resource
   ownership, and lifecycle/recovery before Chapter 10 presents the contract.

**Figure to produce:**

- **Figure 9.1 — Two Routes to the Concurrency Ceiling:** shared workspace to
  interference on the left; isolated A2A workspaces to late integration on the
  right. Both meet at the same ceiling.

**Tables to produce:**

- **CooperBench Observations and Infrastructure Lessons.**
- **Workspace Options:** branch, worktree, directory copy, container, and
  private workspace session.

**Evidence rule:** State that the main CooperBench setup uses separate
Docker-based environments and delayed patch integration. Qualify its 46-task
team-scaling experiment as small. Do not claim the paper proves that A2A never
works or that shared mutable state is the cure.

**Exit question:** What exact objects and invariants would make the result
unambiguous?

### Chapter 10: The Workspace Session Contract:  Workspace Session per Tool Call Execution

**Reader question:** What must an agent-facing workspace promise?

**Opening incident:** Ask the reader to assign ownership for every state change
in the failed three-agent run. The ambiguous nouns reveal the missing contract.

**Core definition:** A workspace contract specifies the starting state, private
mutable state, execution boundary, capture result, and publication transition
for one attributable session. State the default invariant prominently: one
independent command tool call receives one private workspace session. Multi-step
work may explicitly join several related calls to one longer-lived session.

**Running trace:** Introduce the five central objects through one concrete
history:

```text
Agent C -> request Q91 -> session S17 -> base R42
        -> test process + port 3000 -> changeset C8
        -> publication rejected against R43
```

Use the trace to define base, workspace session, private delta, changeset, and
publication. Introduce LayerStack, sandbox, and artifacts afterward as supporting
objects rather than equal entries in a glossary.

**Core figure:** State transitions from immutable base to private work to
accepted shared history.

**Sections:**

1. **Follow One Workspace from Base to Publication** — state current v1 behavior
   first, then use Q91/S17/R42/C8 to define the contract.
2. **Automatic and Explicit Sessions** — contrast one-command finalization with
   a session carried across edits, commands, inspection, and retry.
3. **Private Delta, Changeset, and Publication** — separate mutable work,
   capture, and all-or-reject publication.
4. **Ownership Should Follow the Session** — connect files, lines, processes,
   ports, resources, evidence, and publication to one identity; compare Git
   blame with LayerStack file blame.
5. **Three Questions for a Workspace Runtime** — close with base identity,
   private-versus-candidate state, and complete attributable publication.

**Figures to produce:**

- **Figure 10.1 — Shared Base, Private Sessions, Publication Gate:** a stable
  base feeding three sessions whose candidate changes converge on one gate.
- **Figure 10.2 — One Tool Call, One Workspace Session:** tool call, create
  workspace session, execute, publish or reject, destroy, with durable evidence
  retained.

**Tables to produce:**

- **v1 Operation Behavior:** command and file operations with and without a
  workspace session ID.
- **Git Blame vs File Blame:** owner identity, history model, runtime context,
  squash behavior, and connection to execution evidence.

**Accuracy rule:** Automatic tool-scoped sessions are implemented for command
execution without a `workspace_session_id`. Explicit sessions support multi-call
work. Direct file edits without a session currently publish operation-owned
layers, so universal one-tool-call, one-session semantics must be labeled
**Proposed** rather than described as v1 behavior.

**Worked trace:** Label every object, owner, transition, and invalid state in a
short multi-agent history.

**Exit question:** How does Ephemeral Sandbox assemble these objects into one
agent-facing workspace runtime?

### Chapter 11: Ephemeral Sandbox: Raise the Concurrency Ceiling for Multi-Agent Programming

**Reader question:** How does Ephemeral Sandbox combine the workspace-contract
objects into one agent-facing runtime?

**Opening:** Restate the needs established by Chapters 8–10, then give the
one-sentence product definition immediately.

**Core definition:** Ephemeral Sandbox is an agent workspace runtime that gives
concurrent coding tasks private execution state over shared project history,
then turns completed work into reviewable, conflict-aware publication.
Emphasize that the default concurrency primitive is a private workspace session
per independent command tool call; explicit sessions deliberately group related
calls.

**Sections:**

1. **Ephemeral Sandbox in One View** — connect LayerStack, private sessions,
   publication, and evidence in one product diagram.
2. **Three Agent-Facing Surfaces** — introduce management, runtime, and
   observability before the Part II request-path tour.
3. **From the Product Model to the System** — hand the reader directly to the
   request path.

**Figure to produce:**

- **Figure 11.1 — Ephemeral Sandbox in One View:** an agent or orchestrator
  enters one runtime containing Shared LayerStack, Private Workspace Sessions,
  Publish Gate, and Observability.

**Table to produce:**

- **Agent-Facing Surfaces:** management, runtime, and observability.

**Exit transition:** Now that the supported contract is clear, Part II can
trace how a request travels through the system that implements it.

## Common Reader Rhythm, Not a Fixed Formula

The exact section plans above take priority. Use this small shell to preserve a
consistent reader experience, not to force every chapter into identical
headings. A concept chapter, failure-analysis chapter, contract chapter, and
product-model chapter should not feel mechanically interchangeable.

```markdown
# Chapter N: Title

> Status: Draft
> Evidence baseline: repository revision or release

[Opening incident: 300-500 words. Show an agent task and an observable
consequence before naming the abstraction.]

## The Question

[State the chapter's central question in one short paragraph and explain why it
matters to an agent runtime.]

## [First section required by the chapter plan]

[Give the shortest useful definition. Define bold terms immediately. Include
one overview figure that the rest of the chapter will unpack.]

[Follow the chapter-specific section and visual plan. Move from concrete
observation to vocabulary and then to a reusable model.]

## A Worked Scenario

[Narrate a complete incident, state transition, execution trace, or deployment
decision. Annotate what changed, why it changed, who owned it, and what the
result means. This is explanatory evidence, not a reader exercise.]

## Failure Modes, Limits, and Misconceptions

- Failure mode: trigger, symptom, diagnosis, and safe response.
- Limitation: what the mechanism does not guarantee.
- Misconception: the tempting but incorrect interpretation.

## The Point

- Answer the opening question directly.
- Restate the invariant introduced by the chapter.
- End with the unresolved question that motivates the next chapter.

## Sources

- Primary repository source.
- Primary external documentation or paper.
```

## Beginner Comprehension Devices

Use four recurring callouts throughout Part I:

| Callout | Purpose | Typical length |
| --- | --- | --- |
| **Plain language** | Restate a new systems term without losing its essential meaning. | 1-3 sentences |
| **Common confusion** | Contrast terms readers are likely to merge, such as branch versus workspace. | 2-4 sentences |
| **Follow the state** | Pause and list what changed, who owns it, and who can observe it. | Small table |
| **Boundary check** | State what a mechanism does not isolate or secure. | 1 short paragraph |

For important concepts, use a three-part definition:

1. **Plain-English idea** — an analogy or familiar developer action.
2. **Precise meaning** — the definition used by this book.
3. **Example and non-example** — one of each to prevent category errors.

Each chapter should also include a one-paragraph **The point** conclusion and
optional **Go deeper** notes for namespaces, overlays, cgroups, and merge
algorithms, linking forward to the chapters that explain them fully.

## Diagram Language for Part I

Use the same visual grammar across every figure:

- blue, solid shapes: immutable shared state;
- green, solid shapes: one session's private mutable state;
- orange shapes: running processes and resource use;
- purple arrows: explicit capture or publication transitions;
- red dashed arrows: interference, rejected transitions, or crossed trust
  boundaries;
- gray background: host or infrastructure not yet explained.

Every diagram needs a sentence-style caption that states its conclusion. For
example, prefer "Git separates histories but can leave processes and ports
shared" over "Git worktree architecture." Include a legend on the first figure
of each chapter and never encode meaning by color alone.

Avoid showing the full Ephemeral Sandbox component architecture in Part I.
Readers should first understand state, ownership, and boundaries. Part II can
then attach service names to that mental model.

## Editorial Constraints for Part I

- Target 450-1,750 words per chapter and 4,500-5,100 words for the complete
  part; prefer a shorter chapter with one clear model over an exhaustive survey.
- Use the same names for the workspace-contract objects everywhere.
- Introduce no internal crate or service unless the reader needs it to explain
  an externally visible behavior. The full implementation tour belongs in
  Part II.
- Use one primary diagram and at most two supporting diagrams per chapter.
- Place product comparisons after the conceptual model, so products illustrate
  categories rather than define them.
- Treat rejection, cleanup, timeout, and conflict as normal runtime paths, not
  footnotes.
- Use the precise terms filesystem, process, network, resource, workspace, and
  publication when one of those specific concepts is intended.
- When commands or traces appear, annotate their meaning and resulting state;
  do not turn them into step-by-step reader assignments.

## Author Review Checklist

- [ ] A reader can explain why an agent is more than a chat response.
- [ ] The running scenario gains complexity consistently across four chapters.
- [ ] Source-control isolation is distinguished from runtime isolation.
- [ ] Every workspace-contract object has identity, ownership, mutability, and
      failure semantics.
- [ ] v1 claims are grounded in the current repository evidence baseline.
- [ ] Chapter 11 creates a clean handoff to the request-path material in Part II.
- [ ] The manuscript contains no exercises, labs, quizzes, or reader homework.
- [ ] The manuscript ends with references for research claims, product behavior,
      official tool semantics, and the implementation evidence baseline.

## Reference Used for the Teaching Pattern

- Datawhale, *Hello Agents*, Chapter 1, "Introduction to Agents":
  <https://github.com/datawhalechina/hello-agents/blob/main/docs/chapter1/Chapter1-Introduction-to-Agents.md>

## Supporting Reference for Chapter 9

- Agent Infra Foundation, "The Concurrency Ceiling of Coding Agents":
  <https://agent-infra-foundation.org/blog/2026/07/the-concurrency-ceiling-of-coding-agents/>

Use this article as evidence for the practical concurrency limit. Do not copy
its structure or turn Chapter 9 into a summary of the article.
