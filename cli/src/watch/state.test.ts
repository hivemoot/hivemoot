import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadState, saveState, addProcessedId, mergeAckJournal, appendAck, type WatchState } from "./state.js";

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
    };
    writeFileSync(stateFile, JSON.stringify(saved));

    const state = await loadState(stateFile);
    expect(state.lastChecked).toBe("2026-01-15T10:00:00Z");
    expect(state.processedThreadIds).toEqual(["100", "200", "300"]);
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
    }));

    const state = await loadState(stateFile);
    expect(state.processedThreadIds).toEqual(["100", "200"]);
  });
});

describe("saveState()", () => {
  it("saves state to disk as formatted JSON", async () => {
    const state: WatchState = {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: ["abc", "def"],
    };

    await saveState(stateFile, state);

    const raw = await readFile(stateFile, "utf-8");
    const loaded = JSON.parse(raw);
    expect(loaded.lastChecked).toBe("2026-01-15T12:00:00Z");
    expect(loaded.processedThreadIds).toEqual(["abc", "def"]);
  });

  it("trims processedThreadIds to 200 entries (keeping most recent)", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `thread-${i}`);
    const state: WatchState = {
      lastChecked: "2026-01-15T12:00:00Z",
      processedThreadIds: ids,
    };

    await saveState(stateFile, state);

    const raw = await readFile(stateFile, "utf-8");
    const loaded = JSON.parse(raw) as WatchState;
    expect(loaded.processedThreadIds.length).toBe(200);
    // Should keep the last 200 (thread-100 through thread-299)
    expect(loaded.processedThreadIds[0]).toBe("thread-100");
    expect(loaded.processedThreadIds[199]).toBe("thread-299");
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
});
