export type BenchmarkEngine = "raw-sqlite" | "computer-workspace";
export type BenchmarkProfile = "smoke" | "full";
export type LatencyOperation = "write-new" | "read-full" | "rewrite-identical";
export type EditVariant =
  | "same-chunk"
  | "different-chunks"
  | "head-insertion"
  | "identical";
export type DedupDataset = "identical" | "half-shared" | "unique";

export interface DistributionSummary {
  minimumMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maximumMs: number;
  throughputMiBPerSecond?: number;
}

export interface StorageSnapshot {
  databaseBytes: number;
  logicalBytes: number;
  fileCount: number;
  nodeCount?: number;
  chunkReferenceCount?: number;
  uniqueBlobCount?: number;
  uniqueBlobBytes?: number;
  reachableBlobBytes?: number;
  orphanedBlobBytes?: number;
  manifestCount?: number;
  manifestBytes?: number;
}

export interface CorrectnessResult {
  passed: boolean;
  expectedBytes: number;
  actualBytes: number;
  expectedSha256: string;
  actualSha256: string;
}

export interface LatencyCaseResult {
  engine: BenchmarkEngine;
  operation: LatencyOperation;
  sizeBytes: number;
  operationsPerSample: number;
  warmups: number;
  iterations: number;
  samplesMs: number[];
  summary: DistributionSummary;
  correctness: CorrectnessResult;
  storageAfter: StorageSnapshot;
}

export interface StorageStep {
  step: number;
  operation: "initial-write" | "edit";
  durationMs: number;
  modifiedUserBytes: number;
  storage: StorageSnapshot;
}

export interface EditTransitionResult {
  engine: BenchmarkEngine;
  variant: EditVariant;
  initialSizeBytes: number;
  steps: StorageStep[];
  correctness: CorrectnessResult;
}

export interface DeduplicationResult {
  engine: BenchmarkEngine;
  dataset: DedupDataset;
  fileCount: number;
  fileSizeBytes: number;
  samplesMs: number[];
  summary: DistributionSummary;
  storageBefore: StorageSnapshot;
  storageAfterWrite: StorageSnapshot;
  storageAfterDelete: StorageSnapshot;
  correctnessPassed: boolean;
}

export interface DirectoryResult {
  engine: BenchmarkEngine;
  entryCount: number;
  createTotalMs: number;
  createMedianMs: number;
  listMs: number;
  statMs: number;
  deleteTotalMs: number;
  listedEntries: number;
  storageAfterCreate: StorageSnapshot;
  storageAfterDelete: StorageSnapshot;
  correctnessPassed: boolean;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  profile: BenchmarkProfile;
  runtime: "workerd-durable-object-sqlstorage";
  source: {
    computerCommit: string;
    computerPackageVersion: string;
    computerChunkSizeBytes: number;
    harnessReference: string;
  };
  methodology: {
    includesContainers: false;
    usesSQLiteTestStorage: false;
    rawBaseline: "fixed-512-kib-chunks-without-hashing-or-deduplication";
    timing: "batch-amortized-to-workerd-clock-resolution";
    readConsumesStream: true;
    verificationOutsideTimer: true;
    percentileMethod: "nearest-rank";
  };
  latency: LatencyCaseResult[];
  editTransitions: EditTransitionResult[];
  deduplication: DeduplicationResult[];
  directories: DirectoryResult[];
}
