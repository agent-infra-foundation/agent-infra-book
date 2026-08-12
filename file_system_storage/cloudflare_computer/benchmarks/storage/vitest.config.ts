import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Match Cloudflare Computer's own dofs benchmark configuration: execute inside
// workerd and obtain a real Durable Object SqlStorage through
// runInDurableObject(). Do not substitute SQLiteTestStorage; its Node-side
// prepared-statement cache would change the operation costs being measured.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.jsonc" },
    }),
  ],
  test: {
    globals: true,
    disableConsoleIntercept: true,
    include: ["src/bench/**/*.bench.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
