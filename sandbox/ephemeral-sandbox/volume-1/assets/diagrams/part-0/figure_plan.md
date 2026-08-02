# Part 0 Figure Revision Plan

## Figure 4.1 — MCTS Rollouts over Checkpointed Sandboxes

- **Class:** concept/method diagram
- **Role:** method detail
- **Message:** one bootstrapped sandbox state can fan out into parallel MCTS
  rollouts when checkpoints are cheap to fork and restore.
- **Core conclusion:** the sandbox substrate makes bootstrap, parallel fan-out,
  and rewind cheap; the external MCTS controller still owns selection,
  evaluation, and backpropagation.
- **Entities:** external MCTS controller, bootstrapped root checkpoint, selected
  ancestor, parallel private rollout branches, verifier, CubeSandbox, and
  DeltaBox.
- **Relationships:** bootstrap creates a clean root; selection restores an
  ancestor; expansion forks several private sandbox branches; tool actions
  advance each rollout; evaluation scores leaves; rewards are backpropagated
  through the logical tree.
- **Layout:** one central search tree with a four-step control loop above it and
  a substrate boundary below it.
- **Backend:** deterministic SVG. Exact labels and tree topology matter, and the
  existing manuscript publishes editable SVG assets.
- **Source:** `04-rl-environment-stack.svg`.
- **Evidence status:** illustrative only; no latency or benchmark values.
- **Caption takeaway:** checkpoint, restore, and fork accelerate state reuse,
  but they do not provide MCTS policy or reward semantics.
- **Reviewer risk:** readers may mistake every generic MCTS node for a mandatory
  full-system checkpoint. The caption and prose therefore scope this to
  stateful agent rollouts that materialize selected nodes.

## Figure 6.1 — A Meta-Agent Manipulates a Reversible Worker Trace

- **Class:** concept/method diagram
- **Role:** method detail
- **Message:** a meta-agent can create and observe a worker, intercept a bad
  action, then revert or fork the execution trace before work continues.
- **Core conclusion:** supervision acts on a durable execution trace that can be
  observed, intercepted, reverted, and forked.
- **Entities:** meta-agent, worker trace, model calls, proposed tool action,
  failed branch, and patched branch.
- **Relationships:** create and observe follow the main trace; intercept stops a
  proposed action; revert returns to a prior event; fork creates a patched
  branch.
- **Layout:** meta-agent operation timeline above a branching worker trace.
- **Backend:** supplied source image, used directly at the author's request.
- **Source:** `../../illustrations/part-0/06-shepherd-meta-agent.png`; reference:
  <https://shepherd-agents.ai/>.
- **Evidence status:** illustrative only; no performance values.
- **Caption takeaway:** create, observe, intercept, revert, and fork are
  meta-agent operations over a reversible worker trace.
- **Reviewer risk:** the source figure does not show lifecycle control or fleet
  placement. The surrounding prose must keep those separate roles explicit.
