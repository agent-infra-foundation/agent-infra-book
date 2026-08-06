import type { DistributionSummary } from "./types";

function round(value: number): number {
  return Number(value.toFixed(6));
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) throw new Error("cannot summarize an empty sample set");
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)];
}

export function summarize(samplesMs: readonly number[], bytes?: number): DistributionSummary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const median = nearestRank(sorted, 0.5);
  const result: DistributionSummary = {
    minimumMs: round(sorted[0]),
    medianMs: round(median),
    p95Ms: round(nearestRank(sorted, 0.95)),
    p99Ms: round(nearestRank(sorted, 0.99)),
    maximumMs: round(sorted[sorted.length - 1]),
  };
  if (bytes !== undefined && bytes > 0 && median > 0) {
    result.throughputMiBPerSecond = round(bytes / (1024 * 1024) / (median / 1000));
  }
  return result;
}

export async function measure<T>(
  operation: () => T | Promise<T>,
): Promise<{ value: T; durationMs: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, durationMs: round(performance.now() - started) };
}

export async function measureBatch(
  operationCount: number,
  operation: (index: number) => void | Promise<void>,
): Promise<number> {
  if (!Number.isInteger(operationCount) || operationCount < 1) {
    throw new Error(`operationCount must be a positive integer, received ${operationCount}`);
  }
  const started = performance.now();
  for (let index = 0; index < operationCount; index++) {
    await operation(index);
  }
  return round((performance.now() - started) / operationCount);
}
