import { withEngine } from "../lib/harness";
import { combineHalves, generatePayload, sha256Hex } from "../lib/payload";
import { measure, summarize } from "../lib/statistics";
import type {
  BenchmarkEngine,
  DedupDataset,
  DeduplicationResult,
} from "../lib/types";
import type { ProfileConfiguration } from "./profile";

const engines: BenchmarkEngine[] = ["raw-sqlite", "computer-workspace"];
const datasets: DedupDataset[] = ["identical", "half-shared", "unique"];

function payloadFor(
  dataset: DedupDataset,
  index: number,
  size: number,
  shared: Uint8Array,
): Uint8Array {
  if (dataset === "identical") return generatePayload(size, 0xded0, "random");
  if (dataset === "unique") return generatePayload(size, 0xded0 + index * 101, "random");
  const unique = generatePayload(size - shared.byteLength, 0xbeef + index * 101, "random");
  return combineHalves(shared, unique);
}

async function runDataset(
  engine: BenchmarkEngine,
  dataset: DedupDataset,
  config: ProfileConfiguration,
): Promise<DeduplicationResult> {
  return withEngine(engine, async (adapter) => {
    await adapter.prepareDirectory("/dedup");
    const shared = generatePayload(Math.floor(config.dedupFileSize / 2), 0x5a4e, "random");
    const samplesMs: number[] = [];
    const storageBefore = adapter.snapshot();

    for (let i = 0; i < config.dedupFileCount; i++) {
      const payload = payloadFor(dataset, i, config.dedupFileSize, shared);
      const measured = await measure(() => adapter.write(`/dedup/file-${i}.bin`, payload));
      samplesMs.push(measured.durationMs);
    }
    const storageAfterWrite = adapter.snapshot();

    let correctnessPassed = true;
    for (let i = 0; i < config.dedupFileCount; i++) {
      const expected = payloadFor(dataset, i, config.dedupFileSize, shared);
      const actual = await adapter.read(`/dedup/file-${i}.bin`);
      const [expectedHash, actualHash] = await Promise.all([
        sha256Hex(expected),
        sha256Hex(actual),
      ]);
      correctnessPassed &&=
        expected.byteLength === actual.byteLength && expectedHash === actualHash;
    }

    for (let i = 0; i < config.dedupFileCount; i++) {
      await adapter.remove(`/dedup/file-${i}.bin`);
    }
    const storageAfterDelete = adapter.snapshot();

    return {
      engine,
      dataset,
      fileCount: config.dedupFileCount,
      fileSizeBytes: config.dedupFileSize,
      samplesMs,
      summary: summarize(samplesMs, config.dedupFileSize),
      storageBefore,
      storageAfterWrite,
      storageAfterDelete,
      correctnessPassed,
    };
  });
}

export async function runDeduplicationCases(
  config: ProfileConfiguration,
): Promise<DeduplicationResult[]> {
  const results: DeduplicationResult[] = [];
  for (const dataset of datasets) {
    for (const engine of engines) {
      results.push(await runDataset(engine, dataset, config));
    }
  }
  return results;
}

