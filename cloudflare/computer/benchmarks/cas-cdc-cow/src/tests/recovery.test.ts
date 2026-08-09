import { describe, expect, it } from "vitest";
import { createEngine } from "../engines/factory";
import type { BranchWorkspaceStorageEngine } from "../engines/types";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("publication recovery and retry", () => {
  it("returns the same durable result after response loss and engine recreation", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, storage }) => {
      await engine.seedFile("/file.txt", encoder.encode("base\n"));
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.txt", 0, 4, encoder.encode("next"));

      const first = await engine.publish("agent-a", "publish-agent-a-1");
      const restarted = createEngine("cas-cdc-cow", storage);
      restarted.initialize();
      const retry = await restarted.publish("agent-a", "publish-agent-a-1");
      expect(first).toEqual(retry);
      expect(first.outcome).toBe("merged");
      expect(decoder.decode(await restarted.readFile(null, "/file.txt"))).toBe("next\n");
    });
  });

  it("rolls back a failed publication and permits retry after engine recreation", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql, storage }) => {
      const base = encoder.encode("base\n");
      await engine.seedFile("/file.txt", base);
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.txt", 0, 4, encoder.encode("next"));
      sql.exec(`
        CREATE TRIGGER fail_publish BEFORE INSERT ON ccdc_versions
        WHEN NEW.path = '/file.txt' AND NEW.commit_id > 1
        BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END
      `);

      await expect(engine.publish("agent-a", "publish-after-crash")).rejects.toThrow(
        "injected publication failure",
      );
      expect(bytesEqual(await engine.readFile(null, "/file.txt"), base)).toBe(true);
      expect(sql.exec<{ state: string }>(
        "SELECT state FROM ccdc_branches WHERE branch_id = 'agent-a'",
      ).toArray()[0]?.state).toBe("active");

      sql.exec("DROP TRIGGER fail_publish");
      const restarted = createEngine("cas-cdc-cow", storage);
      restarted.initialize();
      const retry = await restarted.publish("agent-a", "publish-after-crash");
      expect(retry.outcome).toBe("merged");
      expect(decoder.decode(await restarted.readFile(null, "/file.txt"))).toBe("next\n");
    });
  });

  it("keeps operation ids bound to one branch", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      await engine.seedFile("/file.txt", encoder.encode("base\n"));
      engine.createBranch("agent-a");
      engine.createBranch("agent-b");
      await engine.editFile("agent-a", "/file.txt", 0, 1, encoder.encode("A"));
      await engine.publish("agent-a", "shared-operation-id");
      await expect(engine.publish("agent-b", "shared-operation-id")).rejects.toThrow(
        "belongs to agent-a",
      );
    });
  });

  it("replays a recorded conflict after engine recreation", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, storage }) => {
      await engine.seedFile("/file.txt", encoder.encode("base\n"));
      engine.createBranch("agent-a");
      engine.createBranch("agent-b");
      await engine.editFile("agent-a", "/file.txt", 0, 1, encoder.encode("A"));
      await engine.editFile("agent-b", "/file.txt", 0, 1, encoder.encode("B"));
      expect((await engine.publish("agent-a", "publish-winner")).outcome).toBe("merged");

      const conflict = await engine.publish("agent-b", "publish-stale");
      expect(conflict.outcome).toBe("conflict");
      const restarted = createEngine("cas-cdc-cow", storage);
      restarted.initialize();
      expect(await restarted.publish("agent-b", "publish-stale")).toEqual(conflict);
      expect(decoder.decode(await restarted.readFile(null, "/file.txt"))).toBe("Aase\n");
    });
  });
});

describe("branch lifecycle and namespace recovery", () => {
  it("collects unrelated orphans while preserving an abandoned active branch", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      let expected = fixtureBytes(2 * 1024 * 1024, 91);
      await engine.seedFile("/file.bin", expected);
      for (let index = 0; index < 3; index++) {
        const branchId = `checkpoint-${index}`;
        const value = new Uint8Array([0xa0 + index]);
        engine.createBranch(branchId);
        await engine.editFile(branchId, "/file.bin", 100_000 + index, 1, value);
        expected = new Uint8Array(expected);
        expected[100_000 + index] = value[0];
        await engine.publish(branchId);
      }
      engine.createBranch("abandoned-agent");
      await engine.editFile(
        "abandoned-agent",
        "/file.bin",
        200_000,
        1,
        new Uint8Array([0xee]),
      );
      const privateBefore = await engine.readFile("abandoned-agent", "/file.bin");
      const before = engine.snapshot(1);

      const gc = engine.gc(1);
      const after = engine.snapshot(1);
      expect(before.orphanPayloadBytes).toBeGreaterThan(0);
      expect(gc.payloadBytesReclaimed).toBeGreaterThan(0);
      expect(after.orphanPayloadBytes).toBe(0);
      expect(bytesEqual(await engine.readFile("abandoned-agent", "/file.bin"), privateBefore)).toBe(true);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });

  it("collects branch-only CAS data after an abandoned branch is discarded", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      branch.createBranch("abandoned-agent");
      await branch.writeBranchFile(
        "abandoned-agent",
        "/scratch.bin",
        fixtureBytes(512 * 1024, 95),
      );
      const active = branch.snapshot(1);
      expect(active.branchStorage.exclusiveObjectBytes).toBeGreaterThan(0);

      branch.discardBranch("abandoned-agent");
      const discarded = branch.snapshot(1);
      expect(discarded.branchStorage.totalExclusivePayloadBytes).toBe(0);
      expect(discarded.orphanPayloadBytes).toBeGreaterThan(0);
      const gc = branch.gc(1);
      expect(gc.payloadBytesReclaimed).toBeGreaterThan(0);
      expect(branch.snapshot(1).orphanPayloadBytes).toBe(0);
      await expect(branch.readFile(null, "/scratch.bin")).rejects.toThrow();
    });
  });

  it("publishes an explicit truncate", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const base = fixtureBytes(1024 * 1024, 92);
      const truncatedSize = 300_123;
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      await engine.editFile(
        "agent-a",
        "/file.bin",
        truncatedSize,
        base.byteLength - truncatedSize,
        new Uint8Array(),
      );
      expect((await engine.publish("agent-a")).outcome).toBe("merged");
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), base.slice(0, truncatedSize))).toBe(true);
    });
  });

  it("rolls back both sides of an interrupted rename preparation", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      await branch.seedFile("/workspace/old.txt", encoder.encode("rename me\n"));
      branch.createBranch("agent-a");
      sql.exec(`
        CREATE TRIGGER fail_rename BEFORE INSERT ON ccdc_branch_files
        WHEN NEW.path = '/workspace/new.txt'
        BEGIN SELECT RAISE(ABORT, 'injected rename failure'); END
      `);

      await expect(
        branch.renameBranchFile("agent-a", "/workspace/old.txt", "/workspace/new.txt"),
      ).rejects.toThrow("injected rename failure");
      expect(branch.listFiles("agent-a")).toEqual(["/workspace/old.txt"]);
      expect(decoder.decode(await branch.readFile("agent-a", "/workspace/old.txt"))).toBe(
        "rename me\n",
      );
      await expect(branch.readFile("agent-a", "/workspace/new.txt")).rejects.toThrow();

      sql.exec("DROP TRIGGER fail_rename");
      await branch.renameBranchFile("agent-a", "/workspace/old.txt", "/workspace/new.txt");
      expect(branch.listFiles("agent-a")).toEqual(["/workspace/new.txt"]);
      expect((await branch.publish("agent-a")).outcome).toBe("merged");
      expect(branch.listFiles(null)).toEqual(["/workspace/new.txt"]);
    });
  });
});

describe("complete branch-exclusive accounting", () => {
  it("separates COW-page payload from total branch-exclusive payload", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      await branch.seedFile("/workspace/base.bin", fixtureBytes(1024 * 1024, 93));
      branch.createBranch("agent-a");
      await branch.editFile(
        "agent-a",
        "/workspace/base.bin",
        500_000,
        1,
        new Uint8Array([0xfe]),
      );
      await branch.writeBranchFile(
        "agent-a",
        "/workspace/new.bin",
        fixtureBytes(128 * 1024, 94),
      );

      const snapshot = branch.snapshot(1);
      expect(snapshot.branchStorage.cowPageBytes).toBe(4 * 1024);
      expect(snapshot.branchStorage.exclusiveObjectBytes).toBeGreaterThanOrEqual(128 * 1024);
      expect(snapshot.branchStorage.exclusiveManifestBytes).toBeGreaterThan(0);
      expect(snapshot.branchStorage.totalExclusivePayloadBytes).toBeGreaterThan(
        snapshot.branchStorage.cowPageBytes,
      );
    });
  });
});
