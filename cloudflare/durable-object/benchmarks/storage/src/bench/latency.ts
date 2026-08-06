import { withEngine } from "../lib/harness";
import { generatePayload } from "../lib/payload";
import { measureBatch, summarize } from "../lib/statistics";
import type {
  BenchmarkEngine,
  LatencyCaseResult,
  LatencyOperation,
} from "../lib/types";
import { compareBytes } from "./correctness";
import type { ProfileConfiguration } from "./profile";

const engines: BenchmarkEngine[] = ["raw-sqlite", "computer-workspace"];
const operations: LatencyOperation[] = ["write-new", "read-full", "rewrite-identical"];
const MiB = 1024 * 1024;
const TIMED_BYTES_PER_SAMPLE = 4 * MiB;

function operationsPerSample(sizeBytes: number): number {
  // workerd intentionally exposes a coarse clock. Amortize small operations
  // over about 4 MiB of work, capped to keep tiny/empty-file cases bounded.
  return Math.max(
    1,
    Math.min(256, Math.ceil(TIMED_BYTES_PER_SAMPLE / Math.max(sizeBytes, 4096))),
  );
}

async function runCase(
  engine: BenchmarkEngine,
  operation: LatencyOperation,
  sizeBytes: number,
  config: ProfileConfiguration,
): Promise<LatencyCaseResult> {
  return withEngine(engine, async (adapter) => {
    await adapter.prepareDirectory("/latency");
    const baseSeed = 0x51a7 + sizeBytes;
    const payload = generatePayload(sizeBytes, baseSeed, "random");
    const batchSize = operationsPerSample(sizeBytes);
    const samplesMs: number[] = [];
    let verificationPath = "/latency/value.bin";
    let verificationPayload = payload;

    if (operation === "write-new") {
      for (let sample = 0; sample < config.warmups; sample++) {
        for (let item = 0; item < batchSize; item++) {
          const unique = sample * batchSize + item;
          const warmPayload = generatePayload(sizeBytes, baseSeed + unique + 1, "random");
          await adapter.write(`/latency/warm-${sample}-${item}.bin`, warmPayload);
        }
      }
      const measuredSeedOffset = config.warmups * batchSize + 1;
      for (let sample = 0; sample < config.iterations; sample++) {
        const payloads = Array.from({ length: batchSize }, (_, item) =>
          generatePayload(
            sizeBytes,
            baseSeed + measuredSeedOffset + sample * batchSize + item,
            "random",
          ),
        );
        samplesMs.push(
          await measureBatch(batchSize, async (item) => {
            verificationPath = `/latency/measured-${sample}-${item}.bin`;
            verificationPayload = payloads[item];
            await adapter.write(verificationPath, verificationPayload);
          }),
        );
      }
    } else {
      await adapter.write(verificationPath, payload);
      if (operation === "read-full") {
        for (let sample = 0; sample < config.warmups; sample++) {
          for (let item = 0; item < batchSize; item++) await adapter.read(verificationPath);
        }
        for (let sample = 0; sample < config.iterations; sample++) {
          samplesMs.push(
            await measureBatch(batchSize, async () => {
              await adapter.read(verificationPath);
            }),
          );
        }
      } else {
        for (let sample = 0; sample < config.warmups; sample++) {
          for (let item = 0; item < batchSize; item++) {
            await adapter.write(verificationPath, payload);
          }
        }
        for (let sample = 0; sample < config.iterations; sample++) {
          samplesMs.push(
            await measureBatch(batchSize, async () => {
              await adapter.write(verificationPath, payload);
            }),
          );
        }
      }
    }

    const actual = await adapter.read(verificationPath);
    return {
      engine,
      operation,
      sizeBytes,
      operationsPerSample: batchSize,
      warmups: config.warmups,
      iterations: config.iterations,
      samplesMs,
      summary: summarize(samplesMs, sizeBytes),
      correctness: await compareBytes(verificationPayload, actual),
      storageAfter: adapter.snapshot(),
    };
  });
}

export async function runLatencyCases(
  config: ProfileConfiguration,
): Promise<LatencyCaseResult[]> {
  const results: LatencyCaseResult[] = [];
  for (const size of config.sizes) {
    for (const operation of operations) {
      for (const engine of engines) {
        results.push(await runCase(engine, operation, size, config));
      }
    }
  }
  return results;
}
