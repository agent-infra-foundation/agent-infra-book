# Part I Editorial Blueprint: The Problem

## Purpose of Part I

Part I should give readers a mental model for why agent workspaces exist before
it explains how Ephemeral Sandbox is built.

The four chapters form one argument:

```text
one agent changes its environment
        ->
many agents interfere with one another
        ->
safe cooperation needs an explicit workspace contract
        ->
Ephemeral Sandbox implements that contract within a defined trust boundary
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

## Part I Opening Spread

Before Chapter 8, use a two-page visual opening titled **One Task, Three Agents,
One Machine**.

Page one shows the apparently simple request: three agents work on three issues
in one repository. Page two reveals everything they actually share: files,
processes, ports, CPU, memory, disk, caches, credentials, and publication state.

Include one plain-language promise:

> A sandbox is a set of boundaries around what a program can see, change, use,
> and publish. Different sandboxes draw different boundaries.

This spread gives beginners a working definition without pretending that all
sandbox products provide the same guarantees.

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
| 9 | Three agents share a checkout and interfere through files, processes, ports, and test state. | What must a workspace promise to prevent ambiguity? |
| 10 | The workflow gains an immutable base, private sessions, deltas, changesets, and publication. | Which of these promises does Ephemeral Sandbox v1 actually enforce? |
| 11 | The v1 boundary is evaluated against cooperative and hostile workloads. | How does the implementation realize the supported contract? |

Do not reset the story at the start of every chapter. Each opening should begin
from the consequence left by the previous chapter.

## Part I Chapter Map

### Chapter 8: Agents Are Processes with Side Effects

**Reader question:** What does a coding agent actually do to a computer?

**Opening incident:** An agent completes a small dependency upgrade, but leaves
behind modified files, a package cache, a server process, a bound port, and a
large test log.

**Core definition:** A coding agent is a decision loop whose actions are
real operating-system operations. Its effects outlive individual model turns.

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

**Figures to produce:**

- **Figure 8.1 — From Prompt to Side Effects:** prompt -> model decision -> tool
  call -> process tree -> four environmental surfaces.
- **Figure 8.2 — Before and After the Agent Run:** a side-by-side machine state
  snapshot showing changed files, one child process, one port, and resource use.

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

### Chapter 9: Why Parallel Coding Agents Collide

**Reader question:** Why are branches or prompts alone insufficient isolation?

**Opening incident:** Continue the running scenario. Show a timeline in which
the agents individually make reasonable decisions but collectively produce an
unreliable result.

**Core definition:** A collision is unplanned coupling through mutable state or
scarce runtime resources.

**Progression:** Organize collisions by shared surface rather than by anecdote:

| Surface | Example | Visible symptom | Hidden ambiguity |
| --- | --- | --- | --- |
| Filesystem | Agent A changes a lockfile while Agent B tests. | Flaky or stale test result. | Which dependency graph did the test validate? |
| Process | One agent kills or replaces another agent's process. | Interrupted command. | Who owns cleanup and retry? |
| Network | Two dev servers request the same port. | Bind failure or wrong service. | Which session does the endpoint represent? |
| Resource | Concurrent builds exhaust memory or disk. | Timeout or OOM. | Which workload exceeded its budget? |
| Publication | Two plausible edits target the same source. | Merge conflict or silent overwrite. | Which result should become shared history? |

**Core figure:** A time-ordered collision trace, not a generic architecture
diagram.

**Sections:**

1. **One Agent Works; Three Agents Interfere** — continue the exact state left
   by Chapter 8.
2. **A Collision Timeline** — show individually valid actions whose ordering
   creates an invalid result.
3. **Five Places Agents Collide** — files, processes, network, resources, and
   publication.
4. **Why Git Branches Solve Only Part of the Problem** — explain source history
   versus live runtime state without assuming Git internals.
5. **The Isolation Ladder** — shared checkout, worktree, copied directory,
   container, VM or microVM, and agent workspace session.
6. **What Correct Parallel Work Requires** — derive privacy, attribution,
   reproducibility, and explicit publication.
7. **Incident Analysis: One Collision from Start to Finish** — show the initial
   state, event ordering, symptom, hidden ambiguity, and required boundary.

**Figures to produce:**

- **Figure 9.1 — Three-Agent Collision Timeline:** swimlanes for Agents A, B, and
  C plus shared filesystem, process, and port state.
- **Figure 9.2 — Source Isolation Is Not Runtime Isolation:** two overlapping
  maps showing what a Git worktree separates and what remains shared.
- **Figure 9.3 — The Isolation Ladder:** increasingly strong boundaries, with
  cost and trust assumptions visibly increasing rather than a simplistic
  "better" arrow.

**Tables to produce:**

- **Table 9.1 — Collision Taxonomy:** surface, trigger, visible symptom, hidden
  ambiguity, and required boundary.
- **Table 9.2 — Workspace Options:** shared checkout, worktree, copy, container,
  microVM, and agent workspace compared by filesystem, process, network,
  resource, publication, startup, and storage behavior.

**Comparison:** Evaluate a shared checkout, Git branches/worktrees, copied
directories, containers, and private workspace sessions. Separate source
versioning from runtime isolation.

**Worked incident:** Explain one deterministic two-session collision and point
out the missing boundary and ownership record.

**Exit question:** What exact objects and invariants would make the result
unambiguous?

### Chapter 10: The Workspace Contract

**Reader question:** What must an agent-facing workspace promise?

**Opening incident:** Ask the reader to assign ownership for every state change
in the failed three-agent run. The ambiguous nouns reveal the missing contract.

**Core definition:** A workspace contract specifies the starting state, private
mutable state, execution boundary, capture result, and publication transition
for one agent session.

**Concept ladder:** Introduce one object only when the running scenario needs
it:

```text
project base
  -> LayerStack
  -> sandbox
  -> workspace session
  -> private delta
  -> changeset
  -> publication
  -> artifact
```

For every object, use the same five-field definition card:

| Field | Prompt |
| --- | --- |
| Meaning | What is it in one sentence? |
| Identity | How is one instance distinguished from another? |
| Owner | Which component or actor controls its lifecycle? |
| Mutability | Can it change, and at what transition? |
| Failure rule | What must happen if creation, capture, or publication fails? |

**Core figure:** State transitions from immutable base to private work to
accepted shared history.

**Sections:**

1. **Turn the Failure Story into Requirements** — convert each Chapter 9
   collision into a promise the runtime must make.
2. **Before Work: Shared Truth** — explain project base, LayerStack, and sandbox
   in plain language.
3. **During Work: A Private Session** — explain workspace session and private
   delta.
4. **After Work: Capture Is Not Publication** — explain changeset,
   publication, and artifact.
5. **The Workspace Lifecycle** — create, execute, inspect, capture, publish or
   reject, and destroy.
6. **Six Invariants That Make Results Reviewable** — make the contract precise
   without implementation detail.
7. **Failure Is a State Transition** — show conflict, rejection, timeout, and
   cleanup as expected paths.
8. **A Complete Workspace Journey** — annotate one session from base selection
   through private work, capture, publication or rejection, and teardown.

**Figures to produce:**

- **Figure 10.1 — Shared History, Private Work:** a stable base feeding three
  private sessions, each with its own delta.
- **Figure 10.2 — Workspace Lifecycle State Machine:** create -> running ->
  captured -> published/rejected -> destroyed, including failure paths.
- **Figure 10.3 — Ownership Map:** user or orchestrator, workspace runtime,
  session, and shared history, each connected to the state it owns.

**Tables to produce:**

- **Table 10.1 — Contract Object Dictionary:** plain-English analogy, precise
  meaning, identity, owner, mutability, and one non-example for all eight terms.
- **Table 10.2 — Contract Invariants:** invariant, why it matters, how a reader
  would notice a violation, and expected response.
- **Table 10.3 — Lifecycle Operations:** operation, precondition, state change,
  success result, and failure result.

**Invariants:** State these before implementation details. At minimum:

- a session begins from an explicit base;
- uncommitted state is private to its session;
- execution has an attributable owner;
- capture does not silently publish;
- publication is explicit and all-or-reject;
- artifacts are outputs, not implicit shared workspace state.

**Worked trace:** Label every object, owner, transition, and invalid state in a
short multi-agent history.

**Exit question:** Which parts of this contract are delivered by the current
repository, and which require a stronger sandbox boundary?

### Chapter 11: What Ephemeral Sandbox Is—and Is Not

**Reader question:** What security and reliability claims can v1 honestly make?

**Opening incident:** Run the same contract through two threat models: trusted
cooperating coding agents and mutually hostile tenants.

**Core definition:** Ephemeral Sandbox v1 is an agent workspace and
coordination runtime. It should not be described as a hardened hostile-tenant
security boundary.

**Classification dimensions:**

| Dimension | Question |
| --- | --- |
| Workspace isolation | Can sessions see one another's private file changes? |
| Process isolation | How are commands attributed, controlled, and cleaned up? |
| Network isolation | Which network state is shared or session-specific? |
| Resource isolation | Which limits and accounting mechanisms are available? |
| Publication safety | How are conflicts detected and rejected? |
| Tenant security | Is the boundary designed for actively malicious workloads? |

**Evidence table:** Every important claim receives one status label:

- **Implemented** — verified in repository code, tests, or documented runtime.
- **Experimental** — present but incomplete, unstable, or narrowly scoped.
- **Compared** — behavior belonging to another system.
- **Proposed** — future design, not v1 behavior.

**Core figure:** Two nested boundaries: the v1 workspace contract inside a
larger hostile-tenant runtime boundary that remains out of scope.

**Sections:**

1. **Why "Sandbox" Is an Overloaded Word** — revisit the Part 0 zoo using the
   boundary vocabulary readers now understand.
2. **Two Different Threat Models** — cooperating agents that may make mistakes
   versus workloads that actively try to escape or attack.
3. **The v1 Promise** — list the workspace, execution, publication, provenance,
   and observability behavior supported by evidence.
4. **The v1 Non-Promise** — explain hostile tenancy, credential brokering,
   fleet scheduling, durable checkpoints, and browser state in approachable
   language.
5. **How to Read an Infrastructure Claim** — teach readers to ask for boundary,
   threat model, lifecycle, evidence, and failure behavior.
6. **Where v1 Fits** — supported deployments, conditional deployments, and
   unsuitable deployments.
7. **Deployment Scenarios** — explain where v1 fits, where additional controls
   are required, and where a different runtime boundary is necessary.

**Figures to produce:**

- **Figure 11.1 — Nested Runtime Boundaries:** workspace isolation inside the
  larger security and fleet controls required for hostile tenants.
- **Figure 11.2 — Deployment Decision Tree:** trusted collaborators or hostile
  code, local or remote execution, credential exposure, and required boundary.

**Tables to produce:**

- **Table 11.1 — v1 Claim Matrix:** capability, current status, evidence, trust
  assumption, and important limitation.
- **Table 11.2 — Mistake Model vs Threat Model:** accidental conflict, runaway
  process, malicious filesystem access, credential theft, and kernel escape.
- **Table 11.3 — Deployment Fit:** local cooperative team, CI worker, internal
  shared service, public arbitrary-code service, and multi-tenant cloud.

**Scenario analysis:** Classify representative deployments as supported,
conditionally supported, or out of scope, with the relevant contract or
missing control stated explicitly.

**Exit transition:** Now that the supported contract is clear, Part II can
trace how a request travels through the system that implements it.

## Common Reader Rhythm, Not a Fixed Formula

The exact section plans above take priority. Use this small shell to preserve a
consistent reader experience, not to force every chapter into identical
headings. A concept chapter, failure-analysis chapter, contract chapter, and
scope chapter should not feel mechanically interchangeable.

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

- Target 3,000-5,000 words per chapter; prefer a shorter chapter with one clear
  model over an exhaustive survey.
- Use the same names for the eight workspace-contract objects everywhere.
- Introduce no internal crate or service unless the reader needs it to explain
  an externally visible behavior. The full implementation tour belongs in
  Part II.
- Use one primary diagram and at most two supporting diagrams per chapter.
- Place product comparisons after the conceptual model, so products illustrate
  categories rather than define them.
- Treat rejection, cleanup, timeout, and conflict as normal runtime paths, not
  footnotes.
- Do not use "sandbox" alone when the intended boundary is filesystem,
  process, network, resource, workspace, or hostile-tenant isolation.
- When commands or traces appear, annotate their meaning and resulting state;
  do not turn them into step-by-step reader assignments.

## Author Review Checklist

- [ ] A reader can explain why an agent is more than a chat response.
- [ ] The running scenario gains complexity consistently across four chapters.
- [ ] Source-control isolation is distinguished from runtime isolation.
- [ ] Every workspace-contract object has identity, ownership, mutability, and
      failure semantics.
- [ ] v1 claims are grounded in the current repository evidence baseline.
- [ ] Cooperative-agent isolation is not presented as hostile-tenant security.
- [ ] Chapter 11 creates a clean handoff to the request-path material in Part II.
- [ ] The manuscript contains no exercises, labs, quizzes, or reader homework.

## Reference Used for the Teaching Pattern

- Datawhale, *Hello Agents*, Chapter 1, "Introduction to Agents":
  <https://github.com/datawhalechina/hello-agents/blob/main/docs/chapter1/Chapter1-Introduction-to-Agents.md>
