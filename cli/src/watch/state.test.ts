import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  loadState,
  saveState,
  addProcessedId,
  addReviewRequestId,
  buildLatestReviewRequestByThread,
  mergeAckJournal,
  appendAck,
  type WatchState,
} from "./state.js";

let tmpDir: string;
let stateFile: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "hivemoot-watch-test-"));
  stateFile = join(tmpDir, "watch-state.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("loadState()", () => {
  it("returns default state when file does not exist", async () => {
    const state = await loadState(stateFile);

    expect(state.processedThreadIds).toEqual([]);
    // lastChecked should be roughly 1 hour ago
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const loaded = new Date(state.lastChecked).getTime();
    expect(Math.abs(loaded - oneHourAgo)).toBeLessThan(5000);
  });

  it("loads valid state from disk", async () => {
    const saved: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["100", "200", "300"],
      reviewRequestIds: ["500:9001"],
      notificationsPollState: {
        "owner/repo": {
          lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
          pollInterval: 120,
        },
      },
    };
    writeFileSync(stateFile, JSON.stringify(saved));

    const state = await loadState(stateFile);
    expect(state.lastChecked).toBe("2026-01-15T10:00:00Z");
    expect(state.processedThreadIds).toEqual(["100", "200", "300"]);
    expect(state.reviewRequestIds).toEqual(["500:9001"]);
    expect(state.notificationsPollState).toEqual({
      "owner/repo": {
        lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
        pollInterval: 120,
      },
    });
  });

  it("returns default state on corrupted JSON", async () => {
    writeFileSync(stateFile, "not valid json{{{");

    const state = await loadState(stateFile);
    expect(state.processedThreadIds).toEqual([]);
    expect(state.lastChecked).toBeDefined();
  });

  it("returns default state when lastChecked is missing", async () => {
    writeFileSync(stateFile, JSON.stringify({ processedThreadIds: ["1"] }));

    const state = await loadState(stateFile);
    expect(state.processedThreadIds).toEqual([]);
  });

  it("filters non-string entries from processedThreadIds", async () => {
    writeFileSync(stateFile, JSON.stringify({
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["100", 42, null, "200"],
      reviewRequestIds: ["500:9001", 123, null],
    }));

    const state = await loadState(stateFile);
    expect(state.processedThreadIds).toEqual(["100", "200"]);
    expect(state.reviewRequestIds).toEqual(["500:9001"]);
  });

  it("rejects state paths that traverse symlink directories", async () => {
    if (process.platform === "win32") return;

    const realDir = join(tmpDir, "real");
    const linkDir = join(tmpDir, "symlink");
    await mkdir(realDir);
    await symlink(realDir, linkDir);

    await expect(loadState(join(linkDir, "watch-state.json"))).rejects.toThrow(/symbolic links/i);
  });

  it("does not inherit pollInterval or lastModified via __proto__ in notificationsPollState", async () => {
    // JSON.parse treats "__proto__" as a regular own property, so a hostile state file
    // could attempt prototype pollution via the notificationsPollState parser.
    writeFileSync(stateFile, JSON.stringify({
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: [],
      notificationsPollState: {
        "__proto__": { pollInterval: 9999, lastModified: "Mon, 01 Jan 2026 00:00:00 GMT" },
      },
    }));

    const state = await loadState(stateFile);

    // The result object must not have inherited pollInterval or lastModified
    const plainObj = {};
    // @ts-expect-error - intentional prototype-pollution check
    expect(plainObj.pollInterval).toBeUndefined();
    // @ts-expect-error - intentional prototype-pollution check
    expect(plainObj.lastModified).toBeUndefined();

    // notificationsPollState is optional; a single __proto__ entry may produce
    // an entry or nothing — either is acceptable as long as it is not undefined
    // due to a mutation of Object.prototype
    expect(state.lastChecked).toBe("2026-01-15T10:00:00Z");
  });
});

describe("saveState()", () => {
  it("saves state to disk as formatted JSON", async () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: ["abc", "def"],
      reviewRequestIds: ["500:9001"],
      notificationsPollState: {
        "owner/repo": {
          lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
          pollInterval: 60,
        },
      },
    };

    await saveState(stateFile, state);

    const raw = await readFile(stateFile, "utf-8");
    const loaded = JSON.parse(raw);
    expect(loaded.lastChecked).toBe("2026-01-15T12:00:00Z");
    expect(loaded.processedThreadIds).toEqual(["abc", "def"]);
    expect(loaded.reviewRequestIds).toEqual(["500:9001"]);
    expect(loaded.notificationsPollState).toEqual({
      "owner/repo": {
        lastModified: "Mon, 01 Jan 2026 00:00:00 GMT",
        pollInterval: 60,
      },
    });
  });

  it("trims processedThreadIds to 200 entries (keeping most recent)", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `thread-${i}`);
    const state: WatchState = {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: ids,
      reviewRequestIds: Array.from({ length: 300 }, (_, i) => `thread-${i}:request-${i}`),
    };

    await saveState(stateFile, state);

    const raw = await readFile(stateFile, "utf-8");
    const loaded = JSON.parse(raw) as WatchState;
    expect(loaded.processedThreadIds.length).toBe(200);
    expect(loaded.reviewRequestIds?.length).toBe(200);
    // Should keep the last 200 (thread-100 through thread-299)
    expect(loaded.processedThreadIds[0]).toBe("thread-100");
    expect(loaded.processedThreadIds[199]).toBe("thread-299");
    expect(loaded.reviewRequestIds?.[0]).toBe("thread-100:request-100");
    expect(loaded.reviewRequestIds?.[199]).toBe("thread-299:request-299");
  });

  it("overwrites existing state file atomically", async () => {
    await saveState(stateFile, {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["old"],
    });

    await saveState(stateFile, {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: ["new"],
    });

    const raw = await readFile(stateFile, "utf-8");
    const loaded = JSON.parse(raw) as WatchState;
    expect(loaded.processedThreadIds).toEqual(["new"]);
  });

  it("creates parent directories for nested state-file paths", async () => {
    const nestedStateFile = join(tmpDir, "nested", "dir", "watch-state.json");

    await saveState(nestedStateFile, {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: ["nested"],
    });

    expect(existsSync(nestedStateFile)).toBe(true);
  });

  it("rejects nested state-file paths that traverse symlink directories", async () => {
    if (process.platform === "win32") return;

    const realDir = join(tmpDir, "real-parent");
    const linkDir = join(tmpDir, "link-parent");
    await mkdir(realDir);
    await symlink(realDir, linkDir);

    await expect(saveState(join(linkDir, "watch-state.json"), {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: [],
    })).rejects.toThrow(/symbolic links/i);
  });

  it("fails when the state-file parent directory is not writable", async () => {
    if (process.platform === "win32") return;

    const lockedDir = join(tmpDir, "locked");
    await mkdir(lockedDir, { mode: 0o500 });

    try {
      await expect(saveState(join(lockedDir, "watch-state.json"), {
        lastChecked: "2026-01-15T12:00:00Z",
        processedThreadIds: [],
      })).rejects.toThrow(/readable\/writable/i);
    } finally {
      await chmod(lockedDir, 0o700);
    }
  });
});

describe("addProcessedId()", () => {
  it("adds a new thread ID to the list", () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["a", "b"],
    };

    const updated = addProcessedId(state, "c");
    expect(updated.processedThreadIds).toEqual(["a", "b", "c"]);
  });

  it("does not duplicate an existing ID", () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["a", "b"],
    };

    const updated = addProcessedId(state, "b");
    expect(updated.processedThreadIds).toEqual(["a", "b"]);
  });

  it("trims to 200 entries when exceeding limit", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `t-${i}`);
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ids,
    };

    const updated = addProcessedId(state, "new-one");
    expect(updated.processedThreadIds.length).toBe(200);
    expect(updated.processedThreadIds[0]).toBe("t-1"); // oldest dropped
    expect(updated.processedThreadIds[199]).toBe("new-one");
  });

  it("does not mutate the original state", () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["a"],
    };

    const updated = addProcessedId(state, "b");
    expect(state.processedThreadIds).toEqual(["a"]);
    expect(updated.processedThreadIds).toEqual(["a", "b"]);
  });
});

describe("addReviewRequestId()", () => {
  it("records the latest request id for a thread", () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: [],
    };

    const updated = addReviewRequestId(state, "1001", "7001");
    expect(updated.reviewRequestIds).toEqual(["1001:7001"]);
  });

  it("replaces the prior request id for the same thread", () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: [],
      reviewRequestIds: ["1001:7001", "2002:8002"],
    };

    const updated = addReviewRequestId(state, "1001", "7003");
    expect(updated.reviewRequestIds).toEqual(["2002:8002", "1001:7003"]);
  });

  it("does not duplicate an existing thread/request pair", () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: [],
      reviewRequestIds: ["1001:7001"],
    };

    const updated = addReviewRequestId(state, "1001", "7001");
    expect(updated.reviewRequestIds).toEqual(["1001:7001"]);
  });
});

describe("buildLatestReviewRequestByThread()", () => {
  it("returns the latest request id for each thread", () => {
    const result = buildLatestReviewRequestByThread([
      "1001:7001",
      "2002:8002",
      "1001:7003",
    ]);

    expect(result.get("1001")).toBe("7003");
    expect(result.get("2002")).toBe("8002");
  });
});

describe("mergeAckJournal()", () => {
  it("reads journal, merges keys into state, and deletes file", async () => {
    const journalPath = `${stateFile}.acks`;
    await writeFile(journalPath, "1001:2026-02-01T10:00:00Z\n1002:2026-02-01T11:00:00Z\n");

    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["existing-key"],
    };

    const merged = await mergeAckJournal(stateFile, state);

    expect(merged.processedThreadIds).toContain("existing-key");
    expect(merged.processedThreadIds).toContain("1001:2026-02-01T10:00:00Z");
    expect(merged.processedThreadIds).toContain("1002:2026-02-01T11:00:00Z");

    // Journal and processing files should be cleaned up
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(`${stateFile}.acks.processing`)).toBe(false);
  });

  it("returns unchanged state when no journal file exists", async () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["a"],
    };

    const merged = await mergeAckJournal(stateFile, state);

    expect(merged).toEqual(state);
  });

  it("handles empty journal file gracefully", async () => {
    const journalPath = `${stateFile}.acks`;
    await writeFile(journalPath, "");

    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["a"],
    };

    const merged = await mergeAckJournal(stateFile, state);

    expect(merged.processedThreadIds).toEqual(["a"]);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("does not duplicate keys already in processedThreadIds", async () => {
    const journalPath = `${stateFile}.acks`;
    await writeFile(journalPath, "existing-key\nnew-key\n");

    const state: WatchState = {
      lastChecked: "2026-01-15T10:00:00Z",
      processedThreadIds: ["existing-key"],
    };

    const merged = await mergeAckJournal(stateFile, state);

    const count = merged.processedThreadIds.filter((k) => k === "existing-key").length;
    expect(count).toBe(1);
    expect(merged.processedThreadIds).toContain("new-key");
  });
});

describe("appendAck()", () => {
  it("creates journal file if missing and appends key", async () => {
    const journalPath = `${stateFile}.acks`;

    await appendAck(stateFile, "1001:2026-02-01T10:00:00Z");

    const content = await readFile(journalPath, "utf-8");
    expect(content).toBe("1001:2026-02-01T10:00:00Z\n");
  });

  it("appends to existing journal file", async () => {
    const journalPath = `${stateFile}.acks`;
    await writeFile(journalPath, "first-key\n");

    await appendAck(stateFile, "second-key");

    const content = await readFile(journalPath, "utf-8");
    expect(content).toBe("first-key\nsecond-key\n");
  });

  it("handles multiple sequential appends", async () => {
    const journalPath = `${stateFile}.acks`;

    await appendAck(stateFile, "key-1");
    await appendAck(stateFile, "key-2");
    await appendAck(stateFile, "key-3");

    const content = await readFile(journalPath, "utf-8");
    expect(content).toBe("key-1\nkey-2\nkey-3\n");
  });

  it("creates parent directories for nested state-file paths", async () => {
    const nestedStateFile = join(tmpDir, "nested", "ack", "watch-state.json");
    const nestedJournalPath = `${nestedStateFile}.acks`;

    await appendAck(nestedStateFile, "key-1");

    const content = await readFile(nestedJournalPath, "utf-8");
    expect(content).toBe("key-1\n");
  });

  it("rejects ack paths that traverse symlink directories", async () => {
    if (process.platform === "win32") return;

    const realDir = join(tmpDir, "ack-real");
    const linkDir = join(tmpDir, "ack-link");
    await mkdir(realDir);
    await symlink(realDir, linkDir);

    await expect(appendAck(join(linkDir, "watch-state.json"), "key-1")).rejects.toThrow(/symbolic links/i);
  });
});
