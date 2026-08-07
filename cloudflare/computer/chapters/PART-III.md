# Part III — Giving State Hands

> Status: manuscript shell. Verify Computer runtime configuration and Code Mode
> behavior independently before drafting comparisons.

Part III attaches temporary execution to the durable workspace. It progresses
from narrow capabilities to full Linux and ends with an explicit runtime policy.

## Chapter 11 — One Workspace, Three Computers

Define the comparison dimensions: compatibility, authority, startup cost,
memory, filesystem path, network, process model, and persistence.

## Chapter 12 — Code Mode: Programs Instead of Tool Calls

Explain typed capability APIs, JavaScript composition, reduced round trips,
structured results, and credential isolation.

## Chapter 13 — Isolate JavaScript over Durable Files

Use a fresh Dynamic Worker, structured input and results, durable imports,
Workspace-backed `node:fs/promises`, configured modules, and trusted capabilities.

## Chapter 14 — `just-bash`: A Shell Without Linux

Explain Bash syntax implemented in TypeScript, JavaScript command
implementations, direct Workspace RPC, disposable shell state, and the absence
of arbitrary native execution.

## Chapter 15 — Containers When You Need an Operating System

Use Linux for Node, `npm install`, builds, native tools, processes, networking,
and development servers. Keep the durable Workspace—not the container—the
source of truth.

## Chapter 16 — The Durable Agent Computer

Integrate object identity, SQLite state, files, recovery, execution policy,
credentials, network authority, observability, and generated outputs. Return to
the prologue and show why the finished system no longer requires an always-on
machine per agent.
