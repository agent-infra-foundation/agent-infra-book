import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorageLike } from "@cloudflare/dofs";
import {
  type BackendHandle,
  Workspace,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
interface Env {
  COMPUTERD_URL: string;
}

class LocalComputerdBackend implements WorkspaceBackend {
  readonly id = "local-computerd";
  readonly type = "local-computerd";

  constructor(private readonly url: string) {}

  async connect(): Promise<BackendHandle> {
    const client = createWorkspaceClient({ url: this.url });
    return {
      rpc: client,
      sync: "remote",
      close: () => client.close(),
    };
  }
}

export class ComputerIn48Lines extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
    });
  }

  override async fetch(): Promise<Response> {
    using run = await this.#workspace.runtime.exec(
      "LC_ALL=C ls -lR --time-style=+%s . >/dev/null",
      { backend: "local-computerd", encoding: "utf8" },
    );
    const result = await run.result();
    return Response.json(result);
  }
}
