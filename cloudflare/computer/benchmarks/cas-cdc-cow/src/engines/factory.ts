import { CasCdcCowWorkspaceStore } from "./cas-cdc-cow";
import { NaiveWorkspaceStore } from "./naive";
import type { BranchWorkspaceStorageEngine, EngineName } from "./types";

export function createEngine(
  name: EngineName,
  storage: DurableObjectStorage,
): BranchWorkspaceStorageEngine {
  return name === "naive"
    ? new NaiveWorkspaceStore(storage)
    : new CasCdcCowWorkspaceStore(storage);
}
