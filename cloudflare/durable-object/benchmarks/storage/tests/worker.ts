import { DurableObject } from "cloudflare:workers";

export interface TestBindings {
  BenchmarkStorage: DurableObjectNamespace;
}

// The benchmark reaches this object through runInDurableObject() so it can use
// the actual workerd Durable Object SqlStorage. No benchmark implementation is
// hidden in this class.
export class BenchmarkStorage extends DurableObject<TestBindings> {}

export default {
  async fetch(): Promise<Response> {
    return new Response("storage benchmark worker", { status: 200 });
  },
} satisfies ExportedHandler<TestBindings>;

