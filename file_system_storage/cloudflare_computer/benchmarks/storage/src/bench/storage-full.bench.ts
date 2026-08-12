import { it } from "vitest";
import { assertReport } from "./assert-report";
import { runBenchmark } from "./suite";

it("Durable Object storage benchmark - full", async () => {
  const report = await runBenchmark("full");
  assertReport(report);
  console.log(`BENCHMARK_JSON:${JSON.stringify(report)}`);
});
