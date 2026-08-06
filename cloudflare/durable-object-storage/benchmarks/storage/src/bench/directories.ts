import { withEngine } from "../lib/harness";
import { measure, summarize } from "../lib/statistics";
import type { BenchmarkEngine, DirectoryResult } from "../lib/types";
import type { ProfileConfiguration } from "./profile";

const engines: BenchmarkEngine[] = ["raw-sqlite", "computer-workspace"];

async function runDirectoryCase(
  engine: BenchmarkEngine,
  entryCount: number,
): Promise<DirectoryResult> {
  return withEngine(engine, async (adapter) => {
    await adapter.prepareDirectory("/directory");
    const createSamples: number[] = [];
    for (let i = 0; i < entryCount; i++) {
      const measured = await measure(() =>
        adapter.write(`/directory/file-${i.toString().padStart(6, "0")}.bin`, new Uint8Array()),
      );
      createSamples.push(measured.durationMs);
    }
    const storageAfterCreate = adapter.snapshot();

    const listed = await measure(() => adapter.list("/directory/"));
    const middlePath = `/directory/file-${Math.floor(entryCount / 2)
      .toString()
      .padStart(6, "0")}.bin`;
    const stated = await measure(() => adapter.stat(middlePath));

    const deleteStarted = performance.now();
    for (let i = 0; i < entryCount; i++) {
      await adapter.remove(`/directory/file-${i.toString().padStart(6, "0")}.bin`);
    }
    const deleteTotalMs = performance.now() - deleteStarted;
    const storageAfterDelete = adapter.snapshot();

    return {
      engine,
      entryCount,
      createTotalMs: Number(createSamples.reduce((sum, value) => sum + value, 0).toFixed(6)),
      createMedianMs: summarize(createSamples).medianMs,
      listMs: listed.durationMs,
      statMs: stated.durationMs,
      deleteTotalMs: Number(deleteTotalMs.toFixed(6)),
      listedEntries: listed.value.length,
      storageAfterCreate,
      storageAfterDelete,
      correctnessPassed:
        listed.value.length === entryCount && stated.value === 0 && storageAfterDelete.fileCount === 0,
    };
  });
}

export async function runDirectoryCases(
  config: ProfileConfiguration,
): Promise<DirectoryResult[]> {
  const results: DirectoryResult[] = [];
  for (const entryCount of config.directoryCounts) {
    for (const engine of engines) {
      results.push(await runDirectoryCase(engine, entryCount));
    }
  }
  return results;
}

