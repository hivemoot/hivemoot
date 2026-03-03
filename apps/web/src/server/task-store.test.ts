import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  checkTaskCreateRateLimit,
  completeTask,
  createTask,
  DEFAULT_TASK_TIMEOUT_SECONDS,
  MAX_CONCURRENT_TASKS,
  markTaskRunning,
  setTaskProgress,
  failTask,
  getTask,
  listRecentTasks,
  TASK_CREATE_RATE_LIMIT_PER_MINUTE,
  validateCreateTaskRequest,
  COMPLETED_TASK_TTL_SECONDS,
  FAILED_TASK_TTL_SECONDS,
} from "./task-store";

type SetOpts = { nx?: boolean; ex?: number };
type ZAddEntry = { score: number; member: string };

function makeMockRedis() {
  const kv = new Map<string, unknown>();
  const ttl = new Map<string, number>();
  const zsets = new Map<string, Map<string, number>>();
  const counters = new Map<string, number>();

  let multiOps: Array<() => Promise<unknown>> = [];

  const client = {
    set: vi.fn(async (key: string, value: unknown, opts?: SetOpts) => {
      if (opts?.nx && kv.has(key)) return null;
      kv.set(key, value);
      if (typeof opts?.ex === "number") ttl.set(key, opts.ex);
      return "OK";
    }),
    get: vi.fn(async (key: string) => kv.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (kv.delete(key)) removed += 1;
        ttl.delete(key);
      }
      return removed;
    }),
    zadd: vi.fn(async (key: string, entry: ZAddEntry) => {
      if (!zsets.has(key)) zsets.set(key, new Map());
      zsets.get(key)!.set(entry.member, entry.score);
      return 1;
    }),
    zrange: vi.fn(async (key: string, start: number, stop: number, opts?: { rev?: boolean }) => {
      const zset = zsets.get(key);
      if (!zset) return [];

      const entries = [...zset.entries()].sort((a, b) =>
        opts?.rev ? b[1] - a[1] : a[1] - b[1],
      );

      const resolvedStop = stop < 0 ? entries.length - 1 : stop;
      return entries.slice(start, resolvedStop + 1).map(([member]) => member);
    }),
    zrem: vi.fn(async (key: string, ...members: string[]) => {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const member of members) {
        if (zset.delete(member)) removed += 1;
      }
      return removed;
    }),
    zcard: vi.fn(async (key: string) => {
      const zset = zsets.get(key);
      return zset ? zset.size : 0;
    }),
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttl.set(key, seconds);
      return 1;
    }),
    multi: vi.fn(() => {
      multiOps = [];
      return pipeline;
    }),

    _kv: kv,
    _ttl: ttl,
    _zsets: zsets,
  };

  const pipeline = {
    set: vi.fn((...args: Parameters<typeof client.set>) => {
      multiOps.push(() => client.set(...args));
      return pipeline;
    }),
    del: vi.fn((...args: Parameters<typeof client.del>) => {
      multiOps.push(() => client.del(...args));
      return pipeline;
    }),
    zadd: vi.fn((...args: Parameters<typeof client.zadd>) => {
      multiOps.push(() => client.zadd(...args));
      return pipeline;
    }),
    zrem: vi.fn((...args: Parameters<typeof client.zrem>) => {
      multiOps.push(() => client.zrem(...args));
      return pipeline;
    }),
    exec: vi.fn(async () => {
      const results: unknown[] = [];
      for (const op of multiOps) {
        results.push(await op());
      }
      return results;
    }),
  };

  return client as unknown as Redis & {
    _kv: Map<string, unknown>;
    _ttl: Map<string, number>;
    _zsets: Map<string, Map<string, number>>;
  };
}

describe("validateCreateTaskRequest", () => {
  it("accepts a valid create request", () => {
    const result = validateCreateTaskRequest({
      prompt: "Investigate auth failures",
      repos: ["hivemoot/hivemoot", "hivemoot/hivemoot-agent"],
      engine: "codex",
      timeout_secs: 420,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.timeout_secs).toBe(420);
      expect(result.request.repos).toHaveLength(2);
    }
  });

  it("applies defaults when optional fields are omitted", () => {
    const result = validateCreateTaskRequest({
      prompt: "Investigate",
      repos: ["hivemoot/hivemoot"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.engine).toBe("codex");
      expect(result.request.timeout_secs).toBe(DEFAULT_TASK_TIMEOUT_SECONDS);
    }
  });

  it("rejects invalid repo format", () => {
    const result = validateCreateTaskRequest({
      prompt: "Investigate",
      repos: ["invalid-repo"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("invalid repo format");
    }
  });

  it("rejects timeout above max", () => {
    const result = validateCreateTaskRequest({
      prompt: "Investigate",
      repos: ["hivemoot/hivemoot"],
      timeout_secs: 9999,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("timeout_secs");
    }
  });
});

describe("task lifecycle", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("creates, starts, progresses, and completes a task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Deep analysis",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const running = await markTaskRunning("inst-1", created.task.task_id, redis);
    expect(running.ok).toBe(true);

    const progressed = await setTaskProgress(
      "inst-1",
      created.task.task_id,
      "Scanning repository",
      redis,
    );
    expect(progressed.ok).toBe(true);

    const completed = await completeTask(
      "inst-1",
      created.task.task_id,
      "# Result\nDone",
      redis,
    );
    expect(completed.ok).toBe(true);

    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched?.status).toBe("completed");
    expect(fetched?.result).toContain("Result");
  });

  it("enforces max concurrent active tasks", async () => {
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i += 1) {
      const result = await createTask(
        "inst-1",
        "queen",
        {
          engine: "codex",
          prompt: `Task ${i}`,
          repos: ["hivemoot/hivemoot"],
          timeout_secs: 300,
        },
        redis,
      );
      expect(result.ok).toBe(true);
    }

    const blocked = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Overflow",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(blocked).toEqual({ ok: false, reason: "concurrency_limited" });
  });

  it("stores 7-day TTL on completed tasks and 1-day TTL on failed tasks", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Task",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await completeTask("inst-1", created.task.task_id, "done", redis);

    expect(
      redis._ttl.get(`task:inst-1:${created.task.task_id}`),
    ).toBe(COMPLETED_TASK_TTL_SECONDS);

    const second = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Task2",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;

    await markTaskRunning("inst-1", second.task.task_id, redis);
    await failTask("inst-1", second.task.task_id, "boom", redis);

    expect(
      redis._ttl.get(`task:inst-1:${second.task.task_id}`),
    ).toBe(FAILED_TASK_TTL_SECONDS);
  });

  it("auto-transitions stale running tasks to timed_out on read", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Task",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 1,
      },
      redis,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);

    const taskKey = `task:inst-1:${created.task.task_id}`;
    const stored = redis._kv.get(taskKey) as {
      started_at?: string;
      timeout_secs: number;
    };

    redis._kv.set(taskKey, {
      ...stored,
      started_at: "2020-01-01T00:00:00.000Z",
    });

    const timedOut = await getTask("inst-1", created.task.task_id, redis);
    expect(timedOut?.status).toBe("timed_out");
  });

  it("lists recent tasks", async () => {
    const first = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "A",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    const second = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "B",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const tasks = await listRecentTasks("inst-1", 10, redis);
    expect(tasks.length).toBe(2);
  });
});

describe("checkTaskCreateRateLimit", () => {
  it("allows first N requests and rejects overflow", async () => {
    const redis = makeMockRedis();

    let lastAllowed = true;
    for (let i = 0; i < TASK_CREATE_RATE_LIMIT_PER_MINUTE; i += 1) {
      const result = await checkTaskCreateRateLimit("inst-1", 1, redis);
      lastAllowed = result.allowed;
    }

    expect(lastAllowed).toBe(true);

    const blocked = await checkTaskCreateRateLimit("inst-1", 1, redis);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
  });
});
