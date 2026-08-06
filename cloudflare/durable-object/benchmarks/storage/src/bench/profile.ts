import type { BenchmarkProfile } from "../lib/types";

export interface ProfileConfiguration {
  sizes: number[];
  warmups: number;
  iterations: number;
  editSize: number;
  dedupFileSize: number;
  dedupFileCount: number;
  directoryCounts: number[];
}

const KiB = 1024;
const MiB = 1024 * KiB;

const configurations: Record<BenchmarkProfile, ProfileConfiguration> = {
  smoke: {
    sizes: [4 * KiB, 512 * KiB, 1 * MiB],
    warmups: 1,
    iterations: 5,
    editSize: 3 * MiB,
    dedupFileSize: 1 * MiB,
    dedupFileCount: 3,
    directoryCounts: [10, 100],
  },
  full: {
    sizes: [0, 4 * KiB, 64 * KiB, 512 * KiB - 1, 512 * KiB, 512 * KiB + 1, 1 * MiB, 10 * MiB],
    warmups: 5,
    iterations: 30,
    editSize: 10 * MiB,
    dedupFileSize: 10 * MiB,
    dedupFileCount: 10,
    directoryCounts: [10, 1_000, 10_000],
  },
};

export function profileConfiguration(profile: BenchmarkProfile): ProfileConfiguration {
  return configurations[profile];
}

