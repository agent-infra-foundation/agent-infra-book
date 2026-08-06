import { expect } from "vitest";
import type { BenchmarkReport } from "../lib/types";

export function assertReport(report: BenchmarkReport): void {
  for (const result of report.latency) {
    expect(result.correctness.passed, `${result.engine} ${result.operation} ${result.sizeBytes}`).toBe(
      true,
    );
    expect(result.samplesMs.length).toBe(result.iterations);
    if (result.engine === "computer-workspace" && result.operation === "write-new") {
      const expectedFiles = (result.warmups + result.iterations) * result.operationsPerSample;
      expect(result.storageAfter.fileCount).toBe(expectedFiles);
      expect(result.storageAfter.uniqueBlobBytes).toBeLessThanOrEqual(
        result.storageAfter.logicalBytes,
      );
      if (result.sizeBytes > 0) {
        // Whole payloads are unique, even when a short final chunk happens to
        // match another file and is correctly deduplicated by the chunk CAS.
        expect(result.storageAfter.manifestCount).toBe(expectedFiles);
      }
    }
  }
  for (const result of report.editTransitions) {
    expect(result.correctness.passed, `${result.engine} ${result.variant}`).toBe(true);
    expect(result.steps).toHaveLength(6);
  }
  for (const result of report.deduplication) {
    expect(result.correctnessPassed, `${result.engine} ${result.dataset}`).toBe(true);
  }
  for (const result of report.directories) {
    expect(result.correctnessPassed, `${result.engine} directory ${result.entryCount}`).toBe(true);
  }

  const identical = report.deduplication.find(
    (result) => result.engine === "computer-workspace" && result.dataset === "identical",
  );
  expect(identical).toBeDefined();
  expect(identical?.storageAfterWrite.logicalBytes).toBe(
    (identical?.fileCount ?? 0) * (identical?.fileSizeBytes ?? 0),
  );
  expect(identical?.storageAfterWrite.uniqueBlobBytes).toBe(identical?.fileSizeBytes);

  const halfShared = report.deduplication.find(
    (result) => result.engine === "computer-workspace" && result.dataset === "half-shared",
  );
  expect(halfShared).toBeDefined();
  expect(halfShared?.storageAfterWrite.uniqueBlobBytes).toBe(
    ((halfShared?.fileCount ?? 0) + 1) * ((halfShared?.fileSizeBytes ?? 0) / 2),
  );

  const unique = report.deduplication.find(
    (result) => result.engine === "computer-workspace" && result.dataset === "unique",
  );
  expect(unique).toBeDefined();
  expect(unique?.storageAfterWrite.uniqueBlobBytes).toBe(unique?.storageAfterWrite.logicalBytes);

  for (const result of report.deduplication.filter(
    (entry) => entry.engine === "computer-workspace",
  )) {
    expect(result.storageAfterDelete.reachableBlobBytes).toBe(0);
    expect(result.storageAfterDelete.orphanedBlobBytes).toBe(
      result.storageAfterWrite.uniqueBlobBytes,
    );
  }

  const sameChunk = report.editTransitions.find(
    (result) => result.engine === "computer-workspace" && result.variant === "same-chunk",
  );
  expect(sameChunk?.steps.at(-1)?.storage.orphanedBlobBytes).toBe(5 * 512 * 1024);

  const identicalEdits = report.editTransitions.find(
    (result) => result.engine === "computer-workspace" && result.variant === "identical",
  );
  expect(identicalEdits?.steps.at(-1)?.storage.databaseBytes).toBe(
    identicalEdits?.steps[0].storage.databaseBytes,
  );
}
