import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  __resetQueenModeCacheForTests,
  getQueenModeCached,
  getQueenModeCacheTtlMs,
} from "./queen-mode.js";

// ---------------------------------------------------------------------------
// Mock Redis with hget only
// ---------------------------------------------------------------------------

function makeMockRedis(opts: { value?: string | null; throwError?: Error } = {}) {
  return {
    hget: vi.fn(async () => {
      if (opts.throwError) throw opts.throwError;
      return opts.value ?? null;
    }),
  } as unknown as Redis;
}

beforeEach(() => {
  __resetQueenModeCacheForTests();
});

describe("getQueenModeCached", () => {
  it("returns cloud when no value stored (default for new installations)", async () => {
    const redis = makeMockRedis({ value: null });
    const mode = await getQueenModeCached("42", redis);
    expect(mode).toBe("cloud");
  });

  it("returns local when stored", async () => {
    const redis = makeMockRedis({ value: "local" });
    const mode = await getQueenModeCached("42", redis);
    expect(mode).toBe("local");
  });

  it("falls back to cloud on garbage values (G7 fail-closed)", async () => {
    const redis = makeMockRedis({ value: "ditto" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mode = await getQueenModeCached("42", redis);
    expect(mode).toBe("cloud");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("falls back to cloud when Redis throws (G7 fail-closed)", async () => {
    const redis = makeMockRedis({ throwError: new Error("upstream timeout") });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mode = await getQueenModeCached("42", redis);
    expect(mode).toBe("cloud");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("caches the value across calls within the TTL window", async () => {
    const redis = makeMockRedis({ value: "local" });
    let now = 1_000_000;
    const clock = () => now;

    const a = await getQueenModeCached("42", redis, clock);
    const b = await getQueenModeCached("42", redis, clock);
    expect(a).toBe("local");
    expect(b).toBe("local");
    expect(redis.hget).toHaveBeenCalledTimes(1);

    // Advance just under TTL — still cached
    now += getQueenModeCacheTtlMs() - 1;
    const c = await getQueenModeCached("42", redis, clock);
    expect(c).toBe("local");
    expect(redis.hget).toHaveBeenCalledTimes(1);
  });

  it("refreshes from Redis after the TTL boundary", async () => {
    const redis = makeMockRedis({ value: "local" });
    let now = 1_000_000;
    const clock = () => now;

    await getQueenModeCached("42", redis, clock);
    expect(redis.hget).toHaveBeenCalledTimes(1);

    now += getQueenModeCacheTtlMs() + 1;
    await getQueenModeCached("42", redis, clock);
    expect(redis.hget).toHaveBeenCalledTimes(2);
  });

  it("uses per-installation cache keys", async () => {
    const redis = makeMockRedis({ value: "local" });
    await getQueenModeCached("42", redis);
    await getQueenModeCached("99", redis);
    // Two distinct installations, two reads
    expect(redis.hget).toHaveBeenCalledTimes(2);
  });

  it("caches the cloud fallback so a transient error doesn't keep retrying", async () => {
    const redis = makeMockRedis({ throwError: new Error("redis down") });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = 1_000_000;
    const clock = () => now;

    await getQueenModeCached("42", redis, clock);
    // Second call within TTL — same fallback, no new hget
    const second = await getQueenModeCached("42", redis, clock);
    expect(second).toBe("cloud");
    expect(redis.hget).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
