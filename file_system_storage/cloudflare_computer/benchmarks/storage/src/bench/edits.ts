import { withEngine } from "../lib/harness";
import { generatePayload, insertHeadByte, overwriteBytes } from "../lib/payload";
import { measure } from "../lib/statistics";
import type {
  BenchmarkEngine,
  EditTransitionResult,
  EditVariant,
  StorageStep,
} from "../lib/types";
import { compareBytes } from "./correctness";
import type { ProfileConfiguration } from "./profile";

const CHUNK_SIZE = 512 * 1024;
const engines: BenchmarkEngine[] = ["raw-sqlite", "computer-workspace"];
const variants: EditVariant[] = ["same-chunk", "different-chunks", "head-insertion", "identical"];

function nextContent(
  current: Uint8Array,
  variant: EditVariant,
  iteration: number,
): { bytes: Uint8Array; modifiedUserBytes: number } {
  if (variant === "head-insertion") {
    return { bytes: insertHeadByte(current, 0x80 + iteration), modifiedUserBytes: 1 };
  }
  if (variant === "identical") {
    return { bytes: current, modifiedUserBytes: 0 };
  }

  const offset =
    variant === "same-chunk" ? 100 : iteration * CHUNK_SIZE + 100;
  return {
    bytes: overwriteBytes(current, offset, 10, 0xa0 + iteration),
    modifiedUserBytes: 10,
  };
}

async function runVariant(
  engine: BenchmarkEngine,
  variant: EditVariant,
  config: ProfileConfiguration,
): Promise<EditTransitionResult> {
  return withEngine(engine, async (adapter) => {
    await adapter.prepareDirectory("/edits");
    const path = "/edits/file.bin";
    let current = generatePayload(config.editSize, 0xe017, "random");
    const steps: StorageStep[] = [];

    const initial = await measure(() => adapter.write(path, current));
    steps.push({
      step: 0,
      operation: "initial-write",
      durationMs: initial.durationMs,
      modifiedUserBytes: current.byteLength,
      storage: adapter.snapshot(),
    });

    for (let i = 0; i < 5; i++) {
      const next = nextContent(current, variant, i);
      const measured = await measure(() => adapter.write(path, next.bytes));
      current = next.bytes;
      steps.push({
        step: i + 1,
        operation: "edit",
        durationMs: measured.durationMs,
        modifiedUserBytes: next.modifiedUserBytes,
        storage: adapter.snapshot(),
      });
    }

    return {
      engine,
      variant,
      initialSizeBytes: config.editSize,
      steps,
      correctness: await compareBytes(current, await adapter.read(path)),
    };
  });
}

export async function runEditTransitions(
  config: ProfileConfiguration,
): Promise<EditTransitionResult[]> {
  const results: EditTransitionResult[] = [];
  for (const variant of variants) {
    for (const engine of engines) {
      results.push(await runVariant(engine, variant, config));
    }
  }
  return results;
}

