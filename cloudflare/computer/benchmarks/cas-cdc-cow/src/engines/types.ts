export type EngineName = "naive" | "cas-cdc-cow";

export interface EngineCounters {
  /** BLOB payload bytes submitted by benchmark operations after setup. */
  sqlitePayloadBytes: number;
}

export interface StorageSnapshot {
  databaseBytes: number;
  logicalBytes: number;
  storedPayloadBytes: number;
  reachablePayloadBytes: number;
  orphanPayloadBytes: number;
  branchPayloadBytes: number;
  branchStorage: BranchStorageBreakdown;
  objectCount: number;
  versionCount: number;
}

/** Logical payload owned only by active branches, excluding shared base data. */
export interface BranchStorageBreakdown {
  cowPageBytes: number;
  patchBytes: number;
  exclusiveObjectBytes: number;
  exclusiveManifestBytes: number;
  totalExclusivePayloadBytes: number;
}

export interface PublishResult {
  outcome: "merged" | "conflict";
  commit: number | null;
  conflicts: string[];
}

export interface GcResult {
  elapsedMs: number;
  payloadBytesReclaimed: number;
  recordsDeleted: number;
}

export interface WorkspaceStorageEngine {
  readonly name: EngineName;
  readonly counters: EngineCounters;

  initialize(): void;
  resetCounters(): void;
  seedFile(path: string, bytes: Uint8Array): Promise<void>;
  createBranch(branchId: string): void;
  readFile(branchId: string | null, path: string): Promise<Uint8Array>;
  editFile(
    branchId: string,
    path: string,
    offset: number,
    deleteLength: number,
    insert: Uint8Array,
  ): Promise<void>;
  publish(branchId: string, operationId?: string): Promise<PublishResult>;
  discardBranch(branchId: string): void;
  snapshot(retainLatestCommits?: number): StorageSnapshot;
  gc(retainLatestCommits?: number): GcResult;
}

/** Namespace operations needed by the branch-aware Computer adapter. */
export interface BranchWorkspaceStorageEngine extends WorkspaceStorageEngine {
  listFiles(branchId: string | null): string[];
  writeBranchFile(branchId: string, path: string, bytes: Uint8Array): Promise<void>;
  deleteBranchFile(branchId: string, path: string): void;
  renameBranchFile(branchId: string, oldPath: string, newPath: string): Promise<void>;
}
