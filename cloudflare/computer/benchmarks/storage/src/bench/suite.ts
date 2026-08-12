import type { BenchmarkProfile, BenchmarkReport } from "../lib/types";
import { runDeduplicationCases } from "./deduplication";
import { runDirectoryCases } from "./directories";
import { runEditTransitions } from "./edits";
import { runLatencyCases } from "./latency";
import { profileConfiguration } from "./profile";

export const COMPUTER_COMMIT = "76d9e75c5688713b656bce85540d9e0071cece8b";
export const COMPUTER_PACKAGE_VERSION = "0.1.0-alpha.1";
export const COMPUTER_CHUNK_SIZE = 512 * 1024;

export async function runBenchmark(profile: BenchmarkProfile): Promise<BenchmarkReport> {
  const config = profileConfiguration(profile);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    runtime: "workerd-durable-object-sqlstorage",
    source: {
      computerCommit: COMPUTER_COMMIT,
      computerPackageVersion: COMPUTER_PACKAGE_VERSION,
      computerChunkSizeBytes: COMPUTER_CHUNK_SIZE,
      harnessReference: "packages/dofs/src/bench/fs-ops.bench.ts",
    },
    methodology: {
      includesContainers: false,
      usesSQLiteTestStorage: false,
      rawBaseline: "fixed-512-kib-chunks-without-hashing-or-deduplication",
      timing: "batch-amortized-to-workerd-clock-resolution",
      readConsumesStream: true,
      verificationOutsideTimer: true,
      percentileMethod: "nearest-rank",
    },
    latency: await runLatencyCases(config),
    editTransitions: await runEditTransitions(config),
    deduplication: await runDeduplicationCases(config),
    directories: await runDirectoryCases(config),
  };
}
