# Dual-mode website builder

This runnable Part II example demonstrates Cloudflare Computer's intended
execution policy:

> Keep ordinary work in isolates. Start a Linux container only when the task
> needs `npm`, a native binary, or another capability the isolate does not
> provide.

The example is deterministic on purpose. It proves the placement and
synchronization boundaries before a later chapter hands the same backends to a
model.

## What it builds

Open the control page, enter a title, description, and color, and click **Build
website**. The Worker creates a small Vite project, runs the production build,
and serves the resulting website from the durable Workspace.

```text
Browser
  |
  | POST /projects/<name>/build
  v
SiteBuilder Durable Object
  |
  | 1. workspace.fs writes source files
  |    execution: host isolate
  |
  | 2. find . -type f | sort
  |    execution: just-bash Dynamic Worker
  |
  | 3. npm install && npm run build
  |    execution: Linux container + computerd + FUSE
  |
  | 4. pull dist/ back to the authoritative Workspace
  |
  | 5. find + grep the durable result
  |    execution: just-bash Dynamic Worker
  v
GET /projects/<name>/preview/
  |
  `-- served directly from Durable Object SQLite
```

## Why this is genuinely dual mode

The Workspace registers two execution backends:

| Backend ID | Runtime | Work in this example |
| --- | --- | --- |
| `worker-shell` | `just-bash` in a Dynamic Worker | Inspect source files and verify `dist/` |
| `container` | Cloudflare Container running `computerd` | Run the real `npm` and Vite binaries |

The source files are written through `workspace.fs`, so they never require a
container. `runtime.exec()` connects each backend lazily. If a workflow only
reads, writes, or searches files, the container never starts.

The container backend uses the full synchronization bracket:

```text
DO SQLite --push--> container VFS --FUSE--> npm/Vite
DO SQLite <--pull-- container VFS <--------- build output
```

The Worker-shell backend reaches the authoritative Workspace directly through
Workers RPC. It has no second VFS, FUSE mount, or push/pull cycle.

Both backends therefore see one **logical durable Workspace**, but they do not
share one physical filesystem path:

```text
isolate / just-bash ----direct RPC----> authoritative DO SQLite VFS

container command ----/workspace-----> disposable computerd VFS
                                           | push before execution
                                           | pull after execution
                                           v
                                  authoritative DO SQLite VFS
```

Only synchronized paths under `/workspace` are durable. Container-only state
such as `/tmp`, installed system packages, and ignored `node_modules` remains
ephemeral.

## Run locally

Requirements:

- Node.js 22 or newer
- Docker Desktop
- A recent Wrangler authenticated for remote Cloudflare features

From this directory:

```powershell
npm install
npm run types
npm run typecheck
npm run dev
```

Open <http://127.0.0.1:8787/> and click **Build website**.

Wrangler container development is not supported from native Windows. On
Windows, run the same project through WSL after enabling Docker Desktop's WSL
integration:

```powershell
wsl --cd /mnt/c/path/to/dual-mode-website-builder `
  bash scripts/dev-wsl.sh 8793
```

Then open <http://127.0.0.1:8793/>.

The first native build is slower because Docker must build the image and the
container must start. Later native commands can reuse the warm container.

`FUSE_MOUNT=auto` uses real kernel FUSE in Cloudflare Containers. Local
`wrangler dev` does not expose `/dev/fuse`, so `computerd` reports its supported
userspace `shim` fallback while preserving the same push/execute/pull contract.

You can also call the API directly:

```powershell
$body = @{
  title = "A dual-mode launch"
  description = "Authored in an isolate and bundled in a container."
  accent = "#f6821f"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/projects/demo/build `
  -ContentType application/json `
  -Body $body
```

Then open <http://127.0.0.1:8787/projects/demo/preview/>.

## Read the trace

The build response records backend placement, duration, exit code, push/pull
counts, and synchronization status. A healthy result looks like:

```text
durable-isolate  workspace.fs wrote 4 source files
worker-shell     find . -type f | sort                  pushed=0 pulled=0
container        npm install && npm run build           pushed>0 pulled>0
worker-shell     verify dist/                           pushed=0 pulled=0
```

`node_modules` is ignored by Computer's default pull policy. The package lock,
source files, and `dist/` are durable; the dependency directory remains
container-local and disposable.

## Source alignment

This example follows the public wiring used by Cloudflare Computer's
[`examples/think`](https://github.com/cloudflare/computer/tree/main/examples/think):

- `Workspace` owns both backend registrations.
- `WorkerShellBackend` is first and is the lightweight default.
- `CloudflareContainerBackend` owns the `computerd` lifecycle.
- `WorkspaceServiceProxy` loops the Dynamic Worker back to the Workspace.
- `WorkspaceProxy` carries the container's capnweb connection back to the
  Durable Object.
- The container image runs `computerd` as PID 1 and mounts `/workspace`.

Cloudflare Computer is preview software. The package and image are pinned to
`0.1.1` so the tutorial does not silently change underneath the text.
