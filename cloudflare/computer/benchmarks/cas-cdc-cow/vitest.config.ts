import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.jsonc" },
    }),
  ],
  test: {
    globals: true,
    disableConsoleIntercept: true,
    include: ["src/**/*.test.ts", "src/**/*.bench.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
