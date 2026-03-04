import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  appendTaskMessage,
  checkTaskCreateRateLimit,
  claimNextPendingTask,
  completeTask,
  createTask,
  DEFAULT_TASK_TIMEOUT_SECONDS,
  deleteTask,
  getTaskMessages,
  MAX_CONCURRENT_TASKS,
  markTaskRunning,
  requestFollowUp,
  resumeTaskWithFollowUp,
  retryTask,
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
  const lists = new Map<string, string[]>();

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
    eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
      if (script.includes('redis.call("get", KEYS[1]) == ARGV[1]')) {
        const lockKey = keys[0];
        const lockOwnerToken = args[0];
        if (kv.get(lockKey) === lockOwnerToken) {
          kv.delete(lockKey);
          ttl.delete(lockKey);
          return 1;
        }
        return 0;
      }
      return 0;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttl.set(key, seconds);
      return 1;
    }),
    rpush: vi.fn(async (key: string, ...values: string[]) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(...values);
      return lists.get(key)!.length;
    }),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key);
      if (!list) return [];
      const end = stop < 0 ? list.length : stop + 1;
      return list.slice(start, end);
    }),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key);
      if (!list) return "OK";
      const end = stop < 0 ? list.length + stop + 1 : stop + 1;
      const trimmed = list.slice(start < 0 ? list.length + start : start, end);
      lists.set(key, trimmed);
      return "OK";
    }),
    multi: vi.fn(() => {
      multiOps = [];
      return pipeline;
    }),

    _kv: kv,
    _ttl: ttl,
    _zsets: zsets,
    _lists: lists,
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
    _lists: Map<string, string[]>;
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

  it("enforces max active tasks under parallel create attempts", async () => {
    const attempts = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_TASKS + 4 }, (_, index) =>
        createTask(
          "inst-1",
          "queen",
          {
            engine: "codex",
            prompt: `parallel-${index}`,
            repos: ["hivemoot/hivemoot"],
            timeout_secs: 300,
          },
          redis,
        )
      ),
    );

    const created = attempts.filter((result) => result.ok);
    expect(created).toHaveLength(MAX_CONCURRENT_TASKS);

    const pendingCount = redis._zsets.get("tasks:pending:inst-1")?.size ?? 0;
    const runningCount = redis._zsets.get("tasks:running:inst-1")?.size ?? 0;
    expect(pendingCount + runningCount).toBeLessThanOrEqual(MAX_CONCURRENT_TASKS);
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

  it("claims the next pending task and marks it running", async () => {
    const first = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "first",
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
        prompt: "second",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const claimed = await claimNextPendingTask("inst-1", redis);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("running");
    expect(claimed?.task_id).toBe(first.task.task_id);
  });

  it("does not allow two parallel claimers to claim the same task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "single",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [firstClaim, secondClaim] = await Promise.all([
      claimNextPendingTask("inst-1", redis),
      claimNextPendingTask("inst-1", redis),
    ]);

    const successfulClaims = [firstClaim, secondClaim].filter((task) => task !== null);
    expect(successfulClaims).toHaveLength(1);
    expect(successfulClaims[0]?.task_id).toBe(created.task.task_id);
  });

  it("returns null when there are no pending tasks to claim", async () => {
    const claimed = await claimNextPendingTask("inst-1", redis);
    expect(claimed).toBeNull();
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

describe("follow-up workflow", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  async function createAndStartTask() {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Investigate auth flow",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Task creation failed");

    const running = await markTaskRunning("inst-1", created.task.task_id, redis);
    expect(running.ok).toBe(true);

    return created.task;
  }

  it("transitions running → needs_follow_up → pending → running", async () => {
    const task = await createAndStartTask();

    // Executor requests follow-up.
    const followUp = await requestFollowUp(
      "inst-1",
      task.task_id,
      "I need the API key for the external service.",
      redis,
    );
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    expect(followUp.task.status).toBe("needs_follow_up");

    // Verify task is not in the running set anymore.
    const fetchedPaused = await getTask("inst-1", task.task_id, redis);
    expect(fetchedPaused?.status).toBe("needs_follow_up");

    // User posts follow-up.
    const resumed = await resumeTaskWithFollowUp(
      "inst-1",
      task.task_id,
      "Here is the API key: sk-abc123",
      redis,
    );
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.task.status).toBe("pending");

    // Executor claims task again.
    const claimed = await claimNextPendingTask("inst-1", redis);
    expect(claimed).not.toBeNull();
    expect(claimed?.task_id).toBe(task.task_id);
    expect(claimed?.status).toBe("running");
  });

  it("rejects follow-up request from non-running task", async () => {
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

    // Task is pending, not running — follow-up should fail.
    const result = await requestFollowUp(
      "inst-1",
      created.task.task_id,
      "Need info",
      redis,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
    }
  });

  it("rejects user follow-up when task is not in needs_follow_up state", async () => {
    const task = await createAndStartTask();

    // Task is running, not needs_follow_up — user follow-up should fail.
    const result = await resumeTaskWithFollowUp(
      "inst-1",
      task.task_id,
      "Here is more info",
      redis,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
    }
  });

  it("rejects follow-up after terminal state", async () => {
    const task = await createAndStartTask();
    await completeTask("inst-1", task.task_id, "Done", redis);

    const result = await requestFollowUp(
      "inst-1",
      task.task_id,
      "More work needed",
      redis,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
    }
  });

  it("rejects user follow-up after terminal state", async () => {
    const task = await createAndStartTask();
    const followUp = await requestFollowUp(
      "inst-1",
      task.task_id,
      "Need info",
      redis,
    );
    expect(followUp.ok).toBe(true);

    // Complete the task (should fail since it's needs_follow_up, not running).
    // First resume, then complete.
    await resumeTaskWithFollowUp("inst-1", task.task_id, "Info provided", redis);
    const claimed = await claimNextPendingTask("inst-1", redis);
    expect(claimed).not.toBeNull();
    await completeTask("inst-1", task.task_id, "Done", redis);

    // Now try follow-up on completed task.
    const result = await resumeTaskWithFollowUp(
      "inst-1",
      task.task_id,
      "Even more info",
      redis,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
    }
  });

  it("does not auto-timeout needs_follow_up tasks", async () => {
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
    await requestFollowUp("inst-1", created.task.task_id, "Need info", redis);

    // Backdate the task to simulate timeout window passing.
    const taskKey = `task:inst-1:${created.task.task_id}`;
    const stored = redis._kv.get(taskKey) as Record<string, unknown>;
    redis._kv.set(taskKey, {
      ...stored,
      started_at: "2020-01-01T00:00:00.000Z",
      created_at: "2020-01-01T00:00:00.000Z",
    });

    // getTask should NOT auto-timeout a needs_follow_up task.
    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched?.status).toBe("needs_follow_up");
  });

  it("needs_follow_up tasks do not count against max concurrent limit", async () => {
    // Create and start MAX tasks, then move one to needs_follow_up.
    const tasks = [];
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i += 1) {
      const created = await createTask(
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
      expect(created.ok).toBe(true);
      if (created.ok) tasks.push(created.task);
    }

    // Start and pause one task.
    await markTaskRunning("inst-1", tasks[0].task_id, redis);
    await requestFollowUp("inst-1", tasks[0].task_id, "Need info", redis);

    // Should now be able to create another task since the paused one doesn't count.
    const extra = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Extra task",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(extra.ok).toBe(true);
  });
});

describe("task messages", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("stores initial prompt as first message on task creation", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Analyze the codebase",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const messages = await getTaskMessages("inst-1", created.task.task_id, redis);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Analyze the codebase");
  });

  it("appends messages and retrieves them in order", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Do work",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await appendTaskMessage("inst-1", created.task.task_id, "agent", "Working on it...", redis);
    await appendTaskMessage("inst-1", created.task.task_id, "system", "Task running", redis);

    const messages = await getTaskMessages("inst-1", created.task.task_id, redis);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("agent");
    expect(messages[2].role).toBe("system");
  });

  it("records follow-up messages in the timeline", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Investigate",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await requestFollowUp("inst-1", created.task.task_id, "Need more context", redis);
    await resumeTaskWithFollowUp("inst-1", created.task.task_id, "Here is the context", redis);

    const messages = await getTaskMessages("inst-1", created.task.task_id, redis);
    // 1: initial prompt, 2: agent follow-up request, 3: system paused,
    // 4: user follow-up, 5: system re-queued
    expect(messages).toHaveLength(5);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("agent");
    expect(messages[1].content).toBe("Need more context");
    expect(messages[2].role).toBe("system");
    expect(messages[3].role).toBe("user");
    expect(messages[3].content).toBe("Here is the context");
    expect(messages[4].role).toBe("system");
  });

  it("returns empty array when no messages exist", async () => {
    const messages = await getTaskMessages("inst-1", "aabbccddeeff001122334455", redis);
    expect(messages).toEqual([]);
  });
});

describe("post-transition append failure resilience", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("createTask succeeds even when timeline append fails", async () => {
    // Make rpush fail to simulate a Redis error on timeline append.
    vi.mocked(redis.rpush).mockRejectedValue(new Error("Redis write error"));

    const result = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Investigate",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("pending");

    // Task should be retrievable.
    const fetched = await getTask("inst-1", result.task.task_id, redis);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe("pending");
  });

  it("requestFollowUp succeeds even when timeline append fails", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Investigate",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);

    // Make rpush fail after the transition multi has already committed.
    vi.mocked(redis.rpush).mockRejectedValue(new Error("Redis write error"));

    const result = await requestFollowUp(
      "inst-1",
      created.task.task_id,
      "Need more info",
      redis,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("needs_follow_up");
  });

  it("resumeTaskWithFollowUp succeeds even when timeline append fails", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Investigate",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await requestFollowUp("inst-1", created.task.task_id, "Need info", redis);

    // Make rpush fail after the transition multi has already committed.
    vi.mocked(redis.rpush).mockRejectedValue(new Error("Redis write error"));

    const result = await resumeTaskWithFollowUp(
      "inst-1",
      created.task.task_id,
      "Here is the info",
      redis,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("pending");
  });

  it("completeTask succeeds even when message key expire fails", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Investigate",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);

    // Make expire fail to simulate a Redis error on message key TTL.
    vi.mocked(redis.expire).mockRejectedValue(new Error("Redis expire error"));

    const result = await completeTask(
      "inst-1",
      created.task.task_id,
      "Done",
      redis,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status).toBe("completed");
  });
});

describe("deleteTask", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("deletes a timed-out task and removes all Redis keys", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Task to delete",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await failTask("inst-1", created.task.task_id, "oops", redis);

    const result = await deleteTask("inst-1", created.task.task_id, redis);
    expect(result).toEqual({ ok: true });

    // Task should no longer exist.
    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched).toBeNull();

    // Should not appear in recent tasks list.
    const recent = await listRecentTasks("inst-1", 10, redis);
    expect(recent.find((t) => t.task_id === created.task.task_id)).toBeUndefined();
  });

  it("deletes a pending task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Pending task",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await deleteTask("inst-1", created.task.task_id, redis);
    expect(result).toEqual({ ok: true });

    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched).toBeNull();
  });

  it("rejects deletion of a running task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Running task",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);

    const result = await deleteTask("inst-1", created.task.task_id, redis);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });

    // Task should still exist.
    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched?.status).toBe("running");
  });

  it("rejects deletion of a task waiting for follow-up", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Need follow-up",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await requestFollowUp("inst-1", created.task.task_id, "Need clarification", redis);

    const result = await deleteTask("inst-1", created.task.task_id, redis);
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });

    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched?.status).toBe("needs_follow_up");
  });

  it("rejects deletion when task becomes running while delete waits on lock", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Race candidate",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let releaseDeleteExec!: () => void;
    const deleteExecGate = new Promise<void>((resolve) => {
      releaseDeleteExec = resolve;
    });

    // Delay delete's Redis transaction so legacy unlocked behavior would race.
    const multiMock = redis.multi as unknown as {
      mockImplementation: (fn: () => unknown) => void;
    };
    multiMock.mockImplementation(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const pipeline = {
        del: (...args: string[]) => {
          ops.push(() => redis.del(...args));
          return pipeline;
        },
        zrem: (key: string, ...members: string[]) => {
          ops.push(() => redis.zrem(key, ...members));
          return pipeline;
        },
        exec: async () => {
          await deleteExecGate;
          const results: unknown[] = [];
          for (const op of ops) {
            results.push(await op());
          }
          return results;
        },
      };
      return pipeline;
    });

    // External owner holds lock while transitioning pending -> running.
    await redis.set("hive:task-lock:inst-1", "external-owner", {
      nx: true,
      ex: 5,
    });

    const deletePromise = deleteTask("inst-1", created.task.task_id, redis);

    // Let deleteTask block on lock or queued transaction.
    await Promise.resolve();
    await Promise.resolve();

    const rawTaskKey = `task:inst-1:${created.task.task_id}`;
    const rawTask = redis._kv.get(rawTaskKey) as Record<string, unknown> | undefined;
    expect(rawTask?.status).toBe("pending");

    const now = new Date().toISOString();
    redis._kv.set(rawTaskKey, {
      ...rawTask,
      status: "running",
      started_at: now,
      updated_at: now,
    });

    redis._zsets.get("tasks:pending:inst-1")?.delete(created.task.task_id);
    if (!redis._zsets.has("tasks:running:inst-1")) {
      redis._zsets.set("tasks:running:inst-1", new Map());
    }
    redis._zsets.get("tasks:running:inst-1")!.set(created.task.task_id, Date.now());

    await redis.del("hive:task-lock:inst-1");
    releaseDeleteExec();

    const result = await deletePromise;
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });

    const fetched = await getTask("inst-1", created.task.task_id, redis);
    expect(fetched?.status).toBe("running");
  });

  it("returns not_found for a nonexistent task", async () => {
    const result = await deleteTask("inst-1", "aabbccddeeff001122334455", redis);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("frees a concurrency slot when a pending task is deleted", async () => {
    // Fill all slots.
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i += 1) {
      const res = await createTask(
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
      expect(res.ok).toBe(true);
    }

    // Confirm we're at capacity.
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
    expect(blocked.ok).toBe(false);

    // Delete one of the pending tasks.
    const recent = await listRecentTasks("inst-1", 10, redis);
    await deleteTask("inst-1", recent[0].task_id, redis);

    // Should now be able to create again.
    const unblocked = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Now fits",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(unblocked.ok).toBe(true);
  });
});

describe("retryTask", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("creates a new pending task from a timed-out task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Retry me",
        repos: ["hivemoot/hivemoot", "hivemoot/colony"],
        timeout_secs: 420,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await failTask("inst-1", created.task.task_id, "boom", redis);

    // Simulate timed_out by checking the failed state is retryable.
    const retried = await retryTask("inst-1", created.task.task_id, redis);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;

    // New task should have a different ID but same prompt/repos/engine.
    expect(retried.task.task_id).not.toBe(created.task.task_id);
    expect(retried.task.status).toBe("pending");
    expect(retried.task.prompt).toBe("Retry me");
    expect(retried.task.repos).toEqual(["hivemoot/hivemoot", "hivemoot/colony"]);
    expect(retried.task.engine).toBe("codex");
    expect(retried.task.timeout_secs).toBe(420);
    expect(retried.task.created_by).toBe("queen");
  });

  it("rejects retry of a running task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Running",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);

    const result = await retryTask("inst-1", created.task.task_id, redis);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
    }
  });

  it("rejects retry of a pending task", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Pending",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await retryTask("inst-1", created.task.task_id, redis);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
    }
  });

  it("respects concurrency limit on retry", async () => {
    // Fill all slots.
    for (let i = 0; i < MAX_CONCURRENT_TASKS; i += 1) {
      await createTask(
        "inst-1",
        "queen",
        {
          engine: "codex",
          prompt: `Slot ${i}`,
          repos: ["hivemoot/hivemoot"],
          timeout_secs: 300,
        },
        redis,
      );
    }

    // Fail one task to make it retryable, then refill the freed slot.
    const recent = await listRecentTasks("inst-1", 10, redis);
    const failedId = recent[0].task_id;
    await markTaskRunning("inst-1", failedId, redis);
    await failTask("inst-1", failedId, "oops", redis);

    // Refill the slot so we're back at MAX_CONCURRENT_TASKS.
    const refill = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Refill slot",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(refill.ok).toBe(true);

    // Retry should fail because all slots are occupied.
    const result = await retryTask("inst-1", failedId, redis);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("concurrency_limited");
    }
  });

  it("does not modify the original task on retry", async () => {
    const created = await createTask(
      "inst-1",
      "queen",
      {
        engine: "codex",
        prompt: "Original",
        repos: ["hivemoot/hivemoot"],
        timeout_secs: 300,
      },
      redis,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await markTaskRunning("inst-1", created.task.task_id, redis);
    await failTask("inst-1", created.task.task_id, "boom", redis);

    await retryTask("inst-1", created.task.task_id, redis);

    // Original task should still be failed.
    const original = await getTask("inst-1", created.task.task_id, redis);
    expect(original?.status).toBe("failed");
    expect(original?.error).toBe("boom");
  });

  it("returns not_found for a nonexistent task", async () => {
    const result = await retryTask("inst-1", "aabbccddeeff001122334455", redis);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
