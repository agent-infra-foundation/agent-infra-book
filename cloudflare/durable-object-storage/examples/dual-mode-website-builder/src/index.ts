import {
  type DurableObjectStorageLike,
  Workspace,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { DurableObject } from "cloudflare:workers";

// The container uses WorkspaceProxy to dial home over capnweb. The Dynamic
// Worker uses WorkspaceServiceProxy to reach the same authoritative Workspace.
export { WorkspaceProxy, WorkspaceServiceProxy };

const SITE_ROOT = "/workspace/site";
const REPORT_PATH = "/workspace/build-report.json";

interface SiteSpec {
  title: string;
  description: string;
  accent: string;
}

interface ExecutionStep {
  phase: "author" | "inspect" | "build" | "verify";
  backend: "durable-isolate" | "worker-shell" | "container";
  operation: string;
  durationMs: number;
  exitCode?: number;
  pushed?: number;
  pulled?: number;
  syncStatus?: "complete" | "pending";
  output?: string;
}

interface BuildReport {
  project: string;
  builtAt: string;
  success: boolean;
  previewPath: string;
  steps: ExecutionStep[];
}

interface AssetResult {
  bytes: Uint8Array;
  contentType: string;
}

interface SiteBuilderRpc {
  buildSite(project: string, input: SiteSpec): Promise<BuildReport>;
  latestReport(): Promise<BuildReport | null>;
  readAsset(relativePath: string): Promise<AssetResult | null>;
}

function workspaceRef(ctx: DurableObjectState) {
  return { binding: "SiteBuilder", id: ctx.id.toString() };
}

class SiteBuilderBase extends withWorkspaceContainer(class extends DurableObject<Env> {}) {}

/** One durable project workspace with two execution backends. */
export class SiteBuilder extends SiteBuilderBase {
  readonly #containerBackend = new CloudflareContainerBackend({
    id: "container",
    container: () => this,
    workspace: workspaceRef(this.ctx),
  });

  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerShellBackend({
        id: "worker-shell",
        loader: this.env.LOADER,
        workspace: workspaceRef(this.ctx),
        ctx: this.ctx,
      }),
      this.#containerBackend,
    ],
  });

  /** Container egress returns through this fetch path. */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ws") {
      return this.#containerBackend.handleFetch(request);
    }
    return new Response("not found", { status: 404 });
  }

  /** Dynamic Worker loopback used by WorkerShellBackend. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  /**
   * Build a Vite site while making every placement decision explicit:
   *
   * 1. Author files directly in the Durable Object isolate.
   * 2. Inspect them with just-bash in a Dynamic Worker.
   * 3. Escalate npm install + Vite to the Linux container.
   * 4. Verify the durable build output back in the Dynamic Worker.
   */
  async buildSite(project: string, input: SiteSpec): Promise<BuildReport> {
    const spec = normaliseSpec(input);
    const steps: ExecutionStep[] = [];

    const authorStarted = Date.now();
    await this.workspace.fs.rm(SITE_ROOT, { recursive: true, force: true });
    await this.workspace.fs.mkdir(`${SITE_ROOT}/src`, { recursive: true });
    const files = siteFiles(spec);
    await Promise.all(
      Object.entries(files).map(([relativePath, contents]) =>
        this.workspace.fs.writeFile(`${SITE_ROOT}/${relativePath}`, contents),
      ),
    );
    steps.push({
      phase: "author",
      backend: "durable-isolate",
      operation: `workspace.fs wrote ${Object.keys(files).length} source files`,
      durationMs: Date.now() - authorStarted,
    });

    const inspect = await this.runCommand(
      "inspect",
      "worker-shell",
      "find . -type f | sort",
      SITE_ROOT,
    );
    steps.push(inspect);

    const build = await this.runCommand(
      "build",
      "container",
      "npm install --no-audit --no-fund && npm run build",
      SITE_ROOT,
    );
    steps.push(build);

    if (build.exitCode === 0 && build.syncStatus === "complete") {
      steps.push(
        await this.runCommand(
          "verify",
          "worker-shell",
          "find dist -type f | sort && grep -R \"Dual-mode build\" dist",
          SITE_ROOT,
        ),
      );
    }

    const report: BuildReport = {
      project,
      builtAt: new Date().toISOString(),
      success:
        steps.at(-1)?.phase === "verify" &&
        steps
          .filter((step) => step.backend !== "durable-isolate")
          .every((step) => step.exitCode === 0 && step.syncStatus === "complete"),
      previewPath: `/projects/${encodeURIComponent(project)}/preview/`,
      steps,
    };

    await this.workspace.fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    return report;
  }

  async latestReport(): Promise<BuildReport | null> {
    try {
      const value = await this.workspace.fs.readFile(REPORT_PATH, "utf8");
      return JSON.parse(value) as BuildReport;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  async readAsset(relativePath: string): Promise<AssetResult | null> {
    const safePath = normaliseAssetPath(relativePath);
    if (safePath === null) return null;

    try {
      const stream = await this.workspace.fs.readFile(`${SITE_ROOT}/dist/${safePath}`, {});
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      return { bytes, contentType: contentTypeFor(safePath) };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  async #run(
    backend: "worker-shell" | "container",
    command: string,
    cwd: string,
  ) {
    using run = await this.workspace.runtime.exec(command, {
      backend,
      cwd,
      encoding: "utf8",
    });
    // Await inside this scope so `using` does not dispose the remote handle
    // before the command has emitted its exit event and completed post-pull.
    return await run.result();
  }

  async runCommand(
    phase: "inspect" | "build" | "verify",
    backend: "worker-shell" | "container",
    command: string,
    cwd: string,
  ): Promise<ExecutionStep> {
    const started = Date.now();
    const result = await this.#run(backend, command, cwd);
    return {
      phase,
      backend,
      operation: command,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      pushed: result.pushed,
      pulled: result.pulled,
      syncStatus: result.sync.status,
      output: clipOutput(`${asText(result.stdout)}${asText(result.stderr)}`),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(controlPage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const buildMatch = url.pathname.match(/^\/projects\/([^/]+)\/build\/?$/);
    if (buildMatch) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const project = parseProject(buildMatch[1]);
      if (project === null) return json({ error: "invalid project name" }, 400);

      try {
        const body = (await request.json()) as Partial<SiteSpec>;
        const stub = siteBuilderStub(env, project);
        const report = await stub.buildSite(project, {
          title: body.title ?? "A dual-mode website",
          description:
            body.description ??
            "Authored in a Durable Object isolate and built in a Linux container.",
          accent: body.accent ?? "#f6821f",
        });
        return json(report, report.success ? 200 : 500);
      } catch (error) {
        return json({ error: errorMessage(error) }, 500);
      }
    }

    const reportMatch = url.pathname.match(/^\/projects\/([^/]+)\/report\/?$/);
    if (reportMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const project = parseProject(reportMatch[1]);
      if (project === null) return json({ error: "invalid project name" }, 400);
      const report = await siteBuilderStub(env, project).latestReport();
      return report === null ? json({ error: "no build yet" }, 404) : json(report);
    }

    const previewMatch = url.pathname.match(/^\/projects\/([^/]+)\/preview\/?(.*)$/);
    if (previewMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const project = parseProject(previewMatch[1]);
      if (project === null) return new Response("invalid project name", { status: 400 });
      const relativePath = decodeURIComponent(previewMatch[2] || "index.html");
      const asset = await siteBuilderStub(env, project).readAsset(relativePath);
      if (asset === null) return new Response("site not built", { status: 404 });
      return new Response(asset.bytes, {
        headers: {
          "content-type": asset.contentType,
          "cache-control": "no-store",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function normaliseSpec(input: SiteSpec): SiteSpec {
  const title = input.title.trim().slice(0, 80) || "A dual-mode website";
  const description =
    input.description.trim().slice(0, 240) ||
    "Authored in a Durable Object isolate and built in a Linux container.";
  const accent = /^#[0-9a-fA-F]{6}$/.test(input.accent) ? input.accent : "#f6821f";
  return { title, description, accent };
}

function siteFiles(spec: SiteSpec): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name: "dual-mode-site",
        private: true,
        type: "module",
        scripts: { build: "vite build --base=./" },
        devDependencies: { vite: "^7.1.0" },
      },
      null,
      2,
    ),
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="${spec.accent}" />
    <title>${escapeHtml(spec.title)}</title>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    "src/main.js": `import "./style.css";

const site = ${JSON.stringify(spec)};

document.documentElement.style.setProperty("--accent", site.accent);
document.querySelector("#app").innerHTML = \`
  <nav><strong>Cloudflare Computer</strong><span>Dual-mode build</span></nav>
  <section class="hero">
    <p class="eyebrow">ISOLATE FIRST · CONTAINER ON DEMAND</p>
    <h1>\${escapeMarkup(site.title)}</h1>
    <p class="lede">\${escapeMarkup(site.description)}</p>
    <a href="#architecture">See how it was built</a>
  </section>
  <section id="architecture" class="grid">
    <article><span>01</span><h2>Author</h2><p>Durable Object SQLite owns the source files.</p></article>
    <article><span>02</span><h2>Inspect</h2><p>just-bash checks the project in a Dynamic Worker.</p></article>
    <article><span>03</span><h2>Build</h2><p>A Linux container runs real npm and Vite.</p></article>
    <article><span>04</span><h2>Return</h2><p>The build output synchronizes back and survives.</p></article>
  </section>
\`;

function escapeMarkup(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}
`,
    "src/style.css": `@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap");

:root { --accent: ${spec.accent}; font-family: "DM Sans", sans-serif; color: #17202a; background: #fffaf4; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 80% 10%, color-mix(in srgb, var(--accent) 20%, transparent), transparent 32%), #fffaf4; }
nav { display: flex; justify-content: space-between; align-items: center; padding: 1.4rem clamp(1.5rem, 6vw, 6rem); border-bottom: 1px solid #17202a22; }
nav span { color: var(--accent); font-weight: 700; }
.hero { max-width: 980px; padding: clamp(5rem, 11vw, 9rem) clamp(1.5rem, 6vw, 6rem); }
.eyebrow { color: var(--accent); font-weight: 700; letter-spacing: .14em; }
h1 { max-width: 900px; margin: .5rem 0 1.25rem; font-size: clamp(3.2rem, 9vw, 7.5rem); line-height: .92; letter-spacing: -.06em; }
.lede { max-width: 700px; font-size: clamp(1.1rem, 2.2vw, 1.5rem); line-height: 1.6; color: #34495e; }
.hero a { display: inline-block; margin-top: 1.5rem; padding: .9rem 1.2rem; border-radius: 999px; color: white; background: var(--accent); text-decoration: none; font-weight: 700; }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #17202a22; border-top: 1px solid #17202a22; }
article { min-height: 240px; padding: 2rem; background: #fffaf4; }
article span { color: var(--accent); font-weight: 700; }
article h2 { margin: 2rem 0 .5rem; font-size: 1.6rem; }
article p { line-height: 1.55; color: #52616b; }
@media (max-width: 780px) { .grid { grid-template-columns: 1fr 1fr; } nav span { display: none; } }
@media (max-width: 480px) { .grid { grid-template-columns: 1fr; } }
`,
  };
}

function parseProject(encoded: string): string | null {
  const value = decodeURIComponent(encoded).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : null;
}

function siteBuilderStub(env: Env, project: string): SiteBuilderRpc {
  // Wrangler cannot infer methods added to a container-enabled DO class, so
  // keep the cast at this one Worker -> Durable Object RPC boundary.
  return env.SiteBuilder.getByName(project) as unknown as SiteBuilderRpc;
}

function normaliseAssetPath(value: string): string | null {
  const path = value.replace(/^\/+/, "") || "index.html";
  if (path.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return path;
}

function contentTypeFor(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "text/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      ico: "image/x-icon",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function clipOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 2_000 ? trimmed : `${trimmed.slice(0, 2_000)}\n… output clipped`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[
        character
      ] ?? character,
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", { status: 405, headers: { allow } });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function controlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dual-mode website builder</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, sans-serif; color: #1f2933; background: #f7f8fa; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 1180px; margin: auto; padding: 3rem 1.25rem 5rem; }
    header { margin-bottom: 2rem; }
    h1 { margin: 0 0 .7rem; font-size: clamp(2.4rem, 6vw, 4.5rem); letter-spacing: -.05em; }
    header p { max-width: 760px; color: #52616b; font-size: 1.1rem; line-height: 1.6; }
    .layout { display: grid; grid-template-columns: 360px 1fr; gap: 1.25rem; }
    .panel { padding: 1.25rem; border: 1px solid #d8dee4; border-radius: 18px; background: white; box-shadow: 0 16px 50px #18212a0d; }
    label { display: grid; gap: .4rem; margin-bottom: 1rem; font-weight: 700; }
    input, textarea, button { width: 100%; font: inherit; }
    input, textarea { border: 1px solid #c9d1d9; border-radius: 10px; padding: .75rem; }
    textarea { min-height: 110px; resize: vertical; }
    button { border: 0; border-radius: 999px; padding: .85rem 1rem; color: white; background: #f6821f; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    iframe { width: 100%; min-height: 620px; border: 0; border-radius: 12px; background: #fffaf4; }
    #trace { display: grid; gap: .65rem; margin-top: 1rem; }
    .step { display: grid; grid-template-columns: 110px 1fr auto; gap: .8rem; padding: .8rem; border-radius: 10px; background: #f6f8fa; font-size: .9rem; }
    .step strong { color: #d96500; }
    .status { min-height: 1.5rem; margin: .8rem 0; color: #52616b; }
    @media (max-width: 850px) { .layout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p><strong>Cloudflare Computer · Part II example</strong></p>
      <h1>Build once, execute twice.</h1>
      <p>Ordinary authoring and inspection stay in isolates. Only npm and Vite escalate to the attached Linux container. The finished site synchronizes back to Durable Object SQLite.</p>
    </header>
    <section class="layout">
      <form id="builder" class="panel">
        <label>Project <input name="project" value="dual-mode-demo" pattern="[a-z0-9][a-z0-9-]{0,62}" /></label>
        <label>Title <input name="title" value="A website built in two modes" /></label>
        <label>Description <textarea name="description">Source files stay durable in an isolate. Native package installation and bundling happen only when a Linux container is required.</textarea></label>
        <label>Accent <input name="accent" type="color" value="#f6821f" /></label>
        <button>Build website</button>
        <p id="status" class="status">Ready.</p>
        <div id="trace"></div>
      </form>
      <div class="panel"><iframe id="preview" title="Generated website preview"></iframe></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#builder");
    const status = document.querySelector("#status");
    const trace = document.querySelector("#trace");
    const preview = document.querySelector("#preview");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const project = String(data.get("project"));
      const button = form.querySelector("button");
      button.disabled = true;
      status.textContent = "Authoring in the isolate, then starting the container…";
      trace.replaceChildren();
      try {
        const response = await fetch("/projects/" + encodeURIComponent(project) + "/build", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: data.get("title"),
            description: data.get("description"),
            accent: data.get("accent"),
          }),
        });
        const report = await response.json();
        for (const step of report.steps || []) {
          const row = document.createElement("div");
          row.className = "step";
          const backend = document.createElement("strong");
          backend.textContent = step.backend;
          const operation = document.createElement("span");
          operation.textContent = step.operation;
          const duration = document.createElement("span");
          const sync = step.pushed === undefined
            ? ""
            : " · push " + step.pushed + " / pull " + step.pulled;
          duration.textContent = String(step.durationMs) + " ms" + sync;
          row.append(backend, operation, duration);
          trace.append(row);
        }
        if (!response.ok) throw new Error(report.error || "build failed; inspect the trace above");
        status.textContent = "Build complete. The preview is now served from durable Workspace files.";
        preview.src = report.previewPath + "?t=" + Date.now();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
