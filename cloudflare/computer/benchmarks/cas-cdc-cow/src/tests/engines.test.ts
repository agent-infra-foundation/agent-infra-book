import { describe, expect, it } from "vitest";
import { prepareFullManifest } from "../engines/compact-manifest";
import { applyEdit } from "../engines/util";
import type { BranchWorkspaceStorageEngine, EngineName } from "../engines/types";
import { bytesEqual, fixtureBytes } from "../lib/fixtures";
import { withEngine } from "../lib/harness";

const engines: EngineName[] = ["naive", "cas-cdc-cow"];

describe.each(engines)("%s engine", (name) => {
  it("edits a private branch and publishes the result", async () => {
    await withEngine(name, async ({ engine }) => {
      const base = fixtureBytes(1024 * 1024, 11);
      const insert = new Uint8Array([1, 2, 3, 4, 5]);
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.bin", 12345, 5, insert);
      const expected = applyEdit(base, 12345, 5, insert);
      expect(bytesEqual(await engine.readFile("agent-a", "/file.bin"), expected)).toBe(true);
      expect((await engine.publish("agent-a")).outcome).toBe("merged");
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });
});

describe("multi-writer merge boundary", () => {
  it("CAS + CDC + COW merges disjoint files", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const baseA = fixtureBytes(256 * 1024, 21);
      const baseB = fixtureBytes(256 * 1024, 22);
      await engine.seedFile("/a.bin", baseA);
      await engine.seedFile("/b.bin", baseB);
      engine.createBranch("agent-a");
      engine.createBranch("agent-b");
      await engine.editFile("agent-a", "/a.bin", 100, 1, new Uint8Array([0xaa]));
      await engine.editFile("agent-b", "/b.bin", 100, 1, new Uint8Array([0xbb]));
      expect((await engine.publish("agent-a")).outcome).toBe("merged");
      expect((await engine.publish("agent-b")).outcome).toBe("merged");
      expect((await engine.readFile(null, "/a.bin"))[100]).toBe(0xaa);
      expect((await engine.readFile(null, "/b.bin"))[100]).toBe(0xbb);
    });
  });

  it("CAS + CDC + COW rejects a stale same-file writer", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const base = fixtureBytes(256 * 1024, 23);
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      engine.createBranch("agent-b");
      await engine.editFile("agent-a", "/file.bin", 100, 1, new Uint8Array([0xaa]));
      await engine.editFile("agent-b", "/file.bin", 100, 1, new Uint8Array([0xbb]));
      expect((await engine.publish("agent-a")).outcome).toBe("merged");
      const second = await engine.publish("agent-b");
      expect(second.outcome).toBe("conflict");
      expect(second.conflicts).toEqual(["/file.bin"]);
      expect((await engine.readFile(null, "/file.bin"))[100]).toBe(0xaa);
      expect((await engine.readFile("agent-b", "/file.bin"))[100]).toBe(0xbb);
    });
  });
});

describe("branch namespace merge boundary", () => {
  it("publishes branch-created files without copying the main namespace", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      const bytes = new TextEncoder().encode("created by agent-a\n");
      branch.createBranch("agent-a");
      await branch.writeBranchFile("agent-a", "/workspace/new.txt", bytes);

      expect(branch.listFiles(null)).toEqual([]);
      expect(branch.listFiles("agent-a")).toEqual(["/workspace/new.txt"]);
      await expect(branch.readFile(null, "/workspace/new.txt")).rejects.toThrow("no such file");
      expect(bytesEqual(await branch.readFile("agent-a", "/workspace/new.txt"), bytes)).toBe(true);

      expect((await branch.publish("agent-a")).outcome).toBe("merged");
      expect(branch.listFiles(null)).toEqual(["/workspace/new.txt"]);
      expect(bytesEqual(await branch.readFile(null, "/workspace/new.txt"), bytes)).toBe(true);
    });
  });

  it("rejects two branches that create the same path", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      branch.createBranch("agent-a");
      branch.createBranch("agent-b");
      await branch.writeBranchFile(
        "agent-a",
        "/workspace/collision.txt",
        new TextEncoder().encode("agent-a\n"),
      );
      await branch.writeBranchFile(
        "agent-b",
        "/workspace/collision.txt",
        new TextEncoder().encode("agent-b\n"),
      );

      expect((await branch.publish("agent-a")).outcome).toBe("merged");
      const second = await branch.publish("agent-b");
      expect(second).toEqual({
        outcome: "conflict",
        commit: null,
        conflicts: ["/workspace/collision.txt"],
      });
      expect(new TextDecoder().decode(
        await branch.readFile(null, "/workspace/collision.txt"),
      )).toBe("agent-a\n");
    });
  });

  it("detects delete-versus-edit without losing the private edit", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      await branch.seedFile(
        "/workspace/shared.txt",
        new TextEncoder().encode("base\n"),
      );
      branch.createBranch("agent-a");
      branch.createBranch("agent-b");
      branch.deleteBranchFile("agent-a", "/workspace/shared.txt");
      await branch.writeBranchFile(
        "agent-b",
        "/workspace/shared.txt",
        new TextEncoder().encode("edited by agent-b\n"),
      );

      expect((await branch.publish("agent-a")).outcome).toBe("merged");
      const second = await branch.publish("agent-b");
      expect(second.outcome).toBe("conflict");
      expect(second.conflicts).toEqual(["/workspace/shared.txt"]);
      expect(branch.listFiles(null)).toEqual([]);
      expect(new TextDecoder().decode(
        await branch.readFile("agent-b", "/workspace/shared.txt"),
      )).toBe("edited by agent-b\n");
    });
  });

  it("treats rename as conflict-checked create plus delete", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      await branch.seedFile(
        "/workspace/old.txt",
        new TextEncoder().encode("base\n"),
      );
      branch.createBranch("agent-a");
      branch.createBranch("agent-b");
      await branch.renameBranchFile(
        "agent-a",
        "/workspace/old.txt",
        "/workspace/new.txt",
      );
      await branch.writeBranchFile(
        "agent-b",
        "/workspace/old.txt",
        new TextEncoder().encode("edited by agent-b\n"),
      );

      expect((await branch.publish("agent-a")).outcome).toBe("merged");
      const second = await branch.publish("agent-b");
      expect(second.outcome).toBe("conflict");
      expect(second.conflicts).toEqual(["/workspace/old.txt"]);
      expect(branch.listFiles(null)).toEqual(["/workspace/new.txt"]);
      expect(new TextDecoder().decode(
        await branch.readFile(null, "/workspace/new.txt"),
      )).toBe("base\n");
    });
  });

  it("garbage-collects histories containing delete tombstones", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const branch = engine as BranchWorkspaceStorageEngine;
      await branch.seedFile("/workspace/deleted.txt", fixtureBytes(256 * 1024, 41));
      branch.createBranch("agent-a");
      branch.deleteBranchFile("agent-a", "/workspace/deleted.txt");
      expect((await branch.publish("agent-a")).outcome).toBe("merged");
      expect(() => branch.gc(1)).not.toThrow();
      expect(branch.listFiles(null)).toEqual([]);
    });
  });
});

describe("page-keyed copy on write", () => {
  it("coalesces repeated edits to the same 4 KiB page", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(1024 * 1024, 24);
      let expected = base;
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      engine.resetCounters();

      for (let index = 0; index < 5; index++) {
        const insert = new Uint8Array(10).fill(0xc0 + index);
        await engine.editFile("agent-a", "/file.bin", 12_345, 10, insert);
        expected = applyEdit(expected, 12_345, 10, insert);
      }

      const rows = sql.exec<{ count: number; bytes: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(length(bytes)), 0) AS bytes
           FROM ccdc_branch_pages
          WHERE branch_id = 'agent-a' AND path = '/file.bin'`,
      ).toArray()[0];
      expect(rows).toEqual({ count: 1, bytes: 4 * 1024 });
      expect(engine.snapshot().branchPayloadBytes).toBe(4 * 1024);
      expect(engine.counters.sqlitePayloadBytes).toBe(5 * 4 * 1024);
      expect(bytesEqual(await engine.readFile("agent-a", "/file.bin"), expected)).toBe(true);
      expect((await engine.publish("agent-a")).outcome).toBe("merged");
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });

  it("reads and writes only the two pages crossed by an edit", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(1024 * 1024, 25);
      const insert = new Uint8Array(32).fill(0xdd);
      const offset = 4 * 1024 - 16;
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.bin", offset, insert.byteLength, insert);

      const rows = sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ccdc_branch_pages
          WHERE branch_id = 'agent-a' AND path = '/file.bin'`,
      ).toArray()[0];
      expect(rows?.count).toBe(2);
      expect(engine.snapshot().branchPayloadBytes).toBe(8 * 1024);
      expect(bytesEqual(
        await engine.readFile("agent-a", "/file.bin"),
        applyEdit(base, offset, insert.byteLength, insert),
      )).toBe(true);
    });
  });

  it("preserves ordering when structural patches follow page writes", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(1024 * 1024, 26);
      const overwriteA = new Uint8Array(10).fill(0xa1);
      const prepend = new Uint8Array(7).fill(0xb2);
      const overwriteB = new Uint8Array(10).fill(0xc3);
      let expected = base;
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");

      await engine.editFile("agent-a", "/file.bin", 20_000, 10, overwriteA);
      expected = applyEdit(expected, 20_000, 10, overwriteA);
      await engine.editFile("agent-a", "/file.bin", 0, 0, prepend);
      expected = applyEdit(expected, 0, 0, prepend);
      await engine.editFile("agent-a", "/file.bin", 20_007, 10, overwriteB);
      expected = applyEdit(expected, 20_007, 10, overwriteB);

      expect(bytesEqual(await engine.readFile("agent-a", "/file.bin"), expected)).toBe(true);
      expect((await engine.publish("agent-a")).outcome).toBe("merged");
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
      expect(sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/file.bin'",
      ).toArray()[0]?.manifest_hash).toBe((await prepareFullManifest(expected)).hash);
    });
  });

  it("discards private pages without changing the durable file", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(1024 * 1024, 30);
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.bin", 12_345, 1, new Uint8Array([0xfe]));
      expect(engine.snapshot().branchPayloadBytes).toBe(4 * 1024);
      engine.discardBranch("agent-a");
      expect(engine.snapshot().branchPayloadBytes).toBe(0);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), base)).toBe(true);
      expect(sql.exec<{ state: string }>(
        "SELECT state FROM ccdc_branches WHERE branch_id = 'agent-a'",
      ).toArray()[0]?.state).toBe("discarded");
    });
  });
});

describe("local CDC publication", () => {
  it("produces the canonical full-file manifest for sparse page edits", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(4 * 1024 * 1024, 27);
      let expected = base;
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      for (const [offset, value] of [
        [123_456, 0xd1],
        [2_345_678, 0xd2],
        [base.byteLength - 17, 0xd3],
      ] as const) {
        const insert = new Uint8Array(10).fill(value);
        await engine.editFile("agent-a", "/file.bin", offset, 10, insert);
        expected = applyEdit(expected, offset, 10, insert);
      }
      expect((await engine.publish("agent-a")).outcome).toBe("merged");

      const canonical = await prepareFullManifest(expected);
      const current = sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/file.bin'",
      ).toArray()[0];
      expect(current?.manifest_hash).toBe(canonical.hash);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
      expect(sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM ccdc_manifest_chunks",
      ).toArray()[0]?.count).toBe(0);
    });
  });

  it("resynchronizes after a front insertion", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(4 * 1024 * 1024, 28);
      const insert = new Uint8Array(10).fill(0xe1);
      const expected = applyEdit(base, 0, 0, insert);
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.bin", 0, 0, insert);
      expect((await engine.publish("agent-a")).outcome).toBe("merged");

      const canonical = await prepareFullManifest(expected);
      const current = sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/file.bin'",
      ).toArray()[0];
      expect(current?.manifest_hash).toBe(canonical.hash);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });

  it("resynchronizes after a small middle deletion", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      const base = fixtureBytes(4 * 1024 * 1024, 29);
      const offset = 1_234_567;
      const expected = applyEdit(base, offset, 31, new Uint8Array());
      await engine.seedFile("/file.bin", base);
      engine.createBranch("agent-a");
      await engine.editFile("agent-a", "/file.bin", offset, 31, new Uint8Array());
      expect((await engine.publish("agent-a")).outcome).toBe("merged");

      const canonical = await prepareFullManifest(expected);
      const current = sql.exec<{ manifest_hash: string }>(
        "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/file.bin'",
      ).toArray()[0];
      expect(current?.manifest_hash).toBe(canonical.hash);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });

  it("matches canonical CDC across mixed durable checkpoints", async () => {
    await withEngine("cas-cdc-cow", async ({ engine, sql }) => {
      let expected = fixtureBytes(2 * 1024 * 1024, 32);
      await engine.seedFile("/file.bin", expected);
      for (let index = 0; index < 18; index++) {
        const branch = `agent-${index}`;
        engine.createBranch(branch);
        if (index % 3 === 0) {
          const offset = (123_457 * (index + 1)) % (expected.byteLength - 10);
          const insert = new Uint8Array(10).fill(0x40 + index);
          await engine.editFile(branch, "/file.bin", offset, 10, insert);
          expected = applyEdit(expected, offset, 10, insert);
        } else if (index % 3 === 1) {
          const insert = new Uint8Array(5).fill(0x60 + index);
          await engine.editFile(branch, "/file.bin", 0, 0, insert);
          expected = applyEdit(expected, 0, 0, insert);
        } else {
          const offset = Math.floor(expected.byteLength / 2);
          await engine.editFile(branch, "/file.bin", offset, 7, new Uint8Array());
          expected = applyEdit(expected, offset, 7, new Uint8Array());
        }
        expect((await engine.publish(branch)).outcome).toBe("merged");
        const canonical = await prepareFullManifest(expected);
        expect(sql.exec<{ manifest_hash: string }>(
          "SELECT manifest_hash FROM ccdc_main_files WHERE path = '/file.bin'",
        ).toArray()[0]?.manifest_hash).toBe(canonical.hash);
      }
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
      expect(engine.gc(1).payloadBytesReclaimed).toBeGreaterThan(0);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });
});

describe("garbage collection", () => {
  it("reclaims unreachable CAS objects without changing current content", async () => {
    await withEngine("cas-cdc-cow", async ({ engine }) => {
      const base = fixtureBytes(2 * 1024 * 1024, 31);
      await engine.seedFile("/file.bin", base);
      let expected = base;
      for (let index = 0; index < 3; index++) {
        const branch = `agent-${index}`;
        const insert = new Uint8Array(10).fill(0x80 + index);
        engine.createBranch(branch);
        await engine.editFile(branch, "/file.bin", 300_000 + index * 100_000, 10, insert);
        expected = applyEdit(expected, 300_000 + index * 100_000, 10, insert);
        await engine.publish(branch);
      }
      const before = engine.snapshot(1);
      const result = engine.gc(1);
      const after = engine.snapshot(1);
      expect(before.orphanPayloadBytes).toBeGreaterThan(0);
      expect(result.payloadBytesReclaimed).toBeGreaterThan(0);
      expect(after.orphanPayloadBytes).toBe(0);
      expect(bytesEqual(await engine.readFile(null, "/file.bin"), expected)).toBe(true);
    });
  });
});
