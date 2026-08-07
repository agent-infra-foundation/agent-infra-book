# Cloudflare Computer: How to Cut AI Agent Sandboxing Costs by 80%

**An agent needs a workspace that persists. It does not need a Linux machine
that runs continuously.**

This article is part of [Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book),
an open-source systems book about the infrastructure behind coding agents,
sandboxes, durable workspaces, and agent execution.

AI agents regularly read files, search code, edit configuration, and sometimes
run commands such as `npm install` or a production build.

The conventional approach gives every agent a complete container. That model is
easy to understand, but it also means:

> **We may still be paying for Linux while the agent is only reading, thinking,
> or waiting for a model response.**

[Cloudflare Computer](https://github.com/cloudflare/computer) proposes a
different division of labor:

- Keep ordinary file operations in an isolate
- Store project state in a Durable Object
- Start a container only when a native tool actually needs Linux

The central idea fits in one sentence:

> **Keep state available; make the complete operating system appear on demand.**

---

## One workspace, two execution modes

<p align="center">
  <img src="../assets/part-ii/one-workspace-two-modes.png" alt="One Durable Workspace connects a lightweight isolate to an on-demand Linux container." width="40%" />
</p>

The source of truth for the project is the SQLite VFS inside a Workspace
Durable Object.

Ordinary operations can run directly in an isolate:

- Read and write files with `workspace.fs`
- Search text and traverse directories with `just-bash`
- Transform data with JavaScript
- Wait for an LLM response without keeping a container alive

The workflow switches to a container only when it needs real Linux
capabilities:

- `npm install`
- `npm run build`
- Native binaries
- System dependencies
- Long-lived processes that require a real operating system

These are not two unrelated workspaces. The physical model is:

> **One authoritative durable copy plus an execution-side materialization
> created only when needed.**

When the container starts, Computer `push`es the required files into the
`computerd` VFS. Linux programs see an ordinary `/workspace` directory through
FUSE.

After the command finishes, Computer `pull`s the changes back into the
Workspace Durable Object.

**Durable state → push → Linux execution → pull → durable state.**

---

## Build one website in two modes

<p align="center">
  <img src="../assets/part-ii/build-website-two-modes.png" alt="A website is authored and inspected in an isolate, built in a container, and verified from the isolate." width="40%" />
</p>

To test the model, we built a small Vite website with Cloudflare Computer.

The workflow contains only four steps:

1. Author source files in the isolate
2. Inspect the project in the isolate
3. Install dependencies and build in a Linux container
4. Return to the isolate and verify the durable output

The complete path is:

> **isolate authoring → isolate inspection → container build → isolate verification**

Only the native build phase requires Linux.

---

## Keep ordinary operations in the isolate

The first command explicitly selects `worker-shell`:

```ts
using inspection = await workspace.runtime.exec(
  "find . -type f | sort",
  {
    backend: "worker-shell",
    cwd: "/workspace/site",
  },
);
```

This looks like shell syntax, but it is not a native Bash process.

`WorkerShellBackend` runs `just-bash` in a Worker isolate and reaches the
Workspace filesystem directly through RPC. There is no second filesystem, so
there is nothing to push or pull.

File reads, code searches, and small edits can all remain on this lightweight
path.

---

## Escalate only native operations to the container

Dependency installation and the Vite build require real Node.js, npm, and
Linux, so the application explicitly changes the execution backend:

```ts
using build = await workspace.runtime.exec(
  "npm install && npm run build",
  {
    backend: "container",
    cwd: "/workspace/site",
  },
);
```

The important question is not what the command is called. It is which
capabilities the operation requires.

Computer does not automatically send every shell expression into a container.
The application chooses a backend according to its tool, lifecycle, and
security requirements.

The complete registration code includes `Workspace`, `WorkspaceServiceProxy`,
`WorkspaceProxy`, and the container WebSocket route. To keep this article easy
to read on a phone, the larger implementation lives in an immutable Git
snapshot:

> [Open the complete Workspace and dual-backend wiring](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/src/index.ts)

---

## A successful command is not necessarily durable

This is the easiest Cloudflare Computer boundary to miss.

A command in the container may return `exitCode = 0`. That proves the process
succeeded, but it does not necessarily prove that its output reached the
Durable Object.

The application must also inspect the synchronization result:

```ts
const result = await build.result();

if (result.exitCode !== 0 || result.sync.status !== "complete") {
  throw new Error("Build or synchronization failed");
}
```

The build output crosses the durability boundary only after the post-command
pull commits successfully to the Workspace SQLite database.

Computer therefore has two success conditions:

- The process completed successfully
- Workspace synchronization completed successfully

If the command succeeds while synchronization remains `pending`, the correct
response is to retry or reconcile synchronization—not to rerun a potentially
non-idempotent command blindly.

---

## Why not persist all of `node_modules`?

Computer ignores container-side `node_modules` by default.

One `npm install` can create tens of thousands of small files. They are useful
to the current build, but synchronizing them would increase both latency and
durable storage consumption.

More importantly, `node_modules` is normally reconstructible from
`package-lock.json`.

That creates a clear boundary:

- Source, configuration, lockfiles, and build output are durable
- Execution caches such as `node_modules` remain disposable

This is not data loss. It is a deliberate separation between **project state**
and **rebuildable cache**.

The complete container configuration is also preserved as a Git snapshot:

> [Open the pinned Dockerfile](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/Dockerfile)

---

## Where does the 80% reduction come from?

The 80% figure is not a guaranteed Cloudflare discount. It is the result of an
explicit cost model.

We compare two scenarios:

1. One `standard-1` Cloudflare Container remains active for 720 hours per month
2. The same container is active for only 72 hours, or 10% of the month

Workers, isolates, and one Workspace Durable Object handle the ordinary work.

Under the CPU, memory, disk, and plan-allowance assumptions in the model:

- Always active: approximately **$36.83/month**
- Active 10% of the time: approximately **$7.53/month**
- Estimated monthly saving: **$29.30**
- Estimated reduction: **79.6%**

The complete bill does not fall to exactly 10% because the $5 Workers Paid
monthly minimum remains.

The most important variable is the container duty cycle:

- Active 5%: approximately $6.09/month
- Active 10%: approximately $7.53/month
- Active 25%: approximately $12.41/month
- Active 50%: approximately $20.55/month
- Active 100%: approximately $36.83/month

The right question is therefore not:

> “Will Cloudflare Computer always save 80%?”

It is:

> **“How much of my workflow actually needs Linux?”**

The [complete cost model and calculation](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/chapters/PART-II.md)
are preserved in the full chapter for line-by-line verification.

---

## Which agents fit this architecture?

Dual mode is a strong fit for workloads with:

- Many reads, searches, and small edits
- Long waits between tool calls
- Occasional dependency installation or builds
- Reconstructible caches such as `node_modules`
- Source and final artifacts that must remain durable
- Bursty agent sessions

It is a weaker fit when:

- Every operation requires a native binary
- A development server must run continuously
- The container can rarely sleep
- A large workspace changes constantly
- Multiple writers mutate the same Workspace concurrently

As the container duty cycle approaches 100%, the economic advantage of dual
mode approaches zero.

---

## What does Cloudflare Computer actually change?

Cloudflare Computer does not eliminate the container.

It changes the container's role in the system:

> **The container is no longer the agent's permanent home. It is a tool that
> appears when the workflow needs Linux compatibility.**

The Durable Object owns long-lived state.

The isolate handles the low-cost common path.

The container handles operations that really require an operating system.

Computer coordinates push, execution, and pull between them.

The resulting design principle is simple:

> **Pay for a complete operating system when the operation requires one—not
> merely because the agent has a workspace.**

---

## Code and reproduction

- [Complete runnable project](https://github.com/agent-infra-foundation/agent-infra-book/tree/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder)
- [Complete Worker implementation](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/src/index.ts)
- [Container Dockerfile](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/Dockerfile)
- [Local development instructions](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/examples/dual-mode-website-builder/README.md)
- [Complete English tutorial and cost calculation](https://github.com/agent-infra-foundation/agent-infra-book/blob/7f6dec92c07ae1aa55d98f5c1823bc00917b7fdb/cloudflare/durable-object-storage/chapters/PART-II.md)

---

## Continue with Agent Infra Book

This experiment is one part of the open-source
[Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book).
The repository connects architecture analysis with runnable implementations and
measured evidence for agent infrastructure.

- [Star and follow Agent Infra Book](https://github.com/agent-infra-foundation/agent-infra-book)
- [Read the complete Cloudflare Durable Objects section](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/durable-object-storage)
- [Run the dual-mode website builder](https://github.com/agent-infra-foundation/agent-infra-book/tree/main/cloudflare/durable-object-storage/examples/dual-mode-website-builder)

> **If you are building coding agents, sandboxes, or durable workspaces, the
> repository is designed to be read, reproduced, and improved in public.**

Cloudflare Computer is still preview software. APIs, limits, runtime behavior,
and pricing may change. Recheck Cloudflare's current documentation and prices
before using this model for a production budget.
