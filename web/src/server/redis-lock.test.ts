import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import { withRedisLock, LockTimeoutError, LOCK_TTL_SECONDS, LOCK_MAX_WAIT_MS } from "./redis-lock";

// ---------------------------------------------------------------------------
// Minimal Redis mock
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();

  const client = {
    set: vi.fn(async (
      key: string,
      value: unknown,
      opts?: { nx?: boolean; ex?: number },
    ) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
      // RELEASE_LOCK_SCRIPT: 1 key, 1 arg (CAS delete)
      const lockKey = keys[0];
      const expectedOwner = args[0];
      if (store.get(lockKey) === expectedOwner) {
        store.delete(lockKey);
        return 1;
      }
      return 0;
    }),
    _store: store,
  };

  return client as unknown as Redis & { _store: Map<string, unknown> };
}

describe("withRedisLock()", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
    vi.clearAllMocks();
  });

  it("runs the protected function and returns its result", async () => {
    const result = await withRedisLock("test-lock", redis, async () => 42);
    expect(result).toBe(42);
  });

  it("releases the lock after the protected function completes", async () => {
    await withRedisLock("test-lock", redis, async () => "done");
    expect(redis._store.has("test-lock")).toBe(false);
  });

  it("releases the lock even if the protected function throws", async () => {
    await expect(
      withRedisLock("test-lock", redis, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    expect(redis._store.has("test-lock")).toBe(false);
  });

  it("passes LOCK_TTL_SECONDS as the lock TTL", async () => {
    await withRedisLock("test-lock", redis, async () => null);
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      "test-lock",
      expect.any(String),
      expect.objectContaining({ ex: LOCK_TTL_SECONDS }),
    );
  });

  it("uses nx: true so concurrent callers cannot both acquire the lock", async () => {
    await withRedisLock("test-lock", redis, async () => null);
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      "test-lock",
      expect.any(String),
      expect.objectContaining({ nx: true }),
    );
  });

  it("throws LockTimeoutError when lock cannot be acquired within deadline", async () => {
    // Pre-fill the lock so acquisition always fails.
    redis._store.set("test-lock", "someone-else");

    await expect(
      withRedisLock("test-lock", redis, async () => null),
    ).rejects.toThrow(LockTimeoutError);
  }, LOCK_MAX_WAIT_MS + 500);

  it("calls onReleaseError when lock release fails", async () => {
    const onReleaseError = vi.fn();
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error("redis down"));

    await withRedisLock("test-lock", redis, async () => "ok", { onReleaseError });

    expect(onReleaseError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not call onReleaseError on successful release", async () => {
    const onReleaseError = vi.fn();
    await withRedisLock("test-lock", redis, async () => null, { onReleaseError });
    expect(onReleaseError).not.toHaveBeenCalled();
  });

  it("returns the primary operation result even when release fails", async () => {
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error("redis down"));

    const result = await withRedisLock(
      "test-lock",
      redis,
      async () => "primary-result",
      { onReleaseError: () => {} },
    );

    expect(result).toBe("primary-result");
  });
});

describe("LockTimeoutError", () => {
  it("is an instance of Error", () => {
    expect(new LockTimeoutError("my-lock")).toBeInstanceOf(Error);
  });

  it("has name LockTimeoutError", () => {
    expect(new LockTimeoutError("my-lock").name).toBe("LockTimeoutError");
  });

  it("includes the lock key in the message", () => {
    expect(new LockTimeoutError("my-lock").message).toContain("my-lock");
  });
});
