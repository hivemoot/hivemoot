import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  validateReport,
  checkRateLimit,
  recordHealthReport,
  type HealthReport,
} from "./agent-health-store";

// ---------------------------------------------------------------------------
// Minimal Redis mock with sorted set support + pipeline support
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const sortedSets = new Map<string, Map<string, number>>(); // member -> score

  let queuedOps: Array<() => Promise<unknown>> = [];

  const client = {
    set: vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      const set = sets.get(key)!;
      let added = 0;
      for (const m of members) {
        if (!set.has(m)) {
          set.add(m);
          added++;
        }
      }
      return added;
    }),
    zadd: vi.fn(async (key: string, entry: { score: number; member: string }) => {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      sortedSets.get(key)!.set(entry.member, entry.score);
      return 1;
    }),
    zremrangebyscore: vi.fn(async (key: string, min: string | number, max: string | number) => {
      const zset = sortedSets.get(key);
      if (!zset) return 0;
      const minScore = min === "-inf" ? -Infinity : Number(min);
      const maxScore = max === "+inf" ? Infinity : Number(max);
      let removed = 0;
      for (const [member, score] of zset) {
        if (score >= minScore && score <= maxScore) {
          zset.delete(member);
          removed++;
        }
      }
      return removed;
    }),
    multi: vi.fn(() => {
      queuedOps = [];
      return pipeline;
    }),
    _store: store,
    _sets: sets,
    _sortedSets: sortedSets,
  };

  const pipeline = {
    set: vi.fn((...args: Parameters<typeof client.set>) => {
      queuedOps.push(() => client.set(...args));
      return pipeline;
    }),
    zadd: vi.fn((...args: Parameters<typeof client.zadd>) => {
      queuedOps.push(() => client.zadd(...args));
      return pipeline;
    }),
    sadd: vi.fn((...args: Parameters<typeof client.sadd>) => {
      queuedOps.push(() => client.sadd(...args));
      return pipeline;
    }),
    zremrangebyscore: vi.fn((...args: Parameters<typeof client.zremrangebyscore>) => {
      queuedOps.push(() => client.zremrangebyscore(...args));
      return pipeline;
    }),
    exec: vi.fn(async () => {
      const results: unknown[] = [];
      for (const op of queuedOps) {
        results.push(await op());
      }
      return results;
    }),
  };

  return client as unknown as Redis & {
    _store: Map<string, unknown>;
    _sets: Map<string, Set<string>>;
    _sortedSets: Map<string, Map<string, number>>;
    multi: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Tests - validateReport
// ---------------------------------------------------------------------------

describe("validateReport", () => {
  it("accepts a valid report", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "20260224-100000-claude-bee-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.agent_id).toBe("bee-1");
      expect(result.report.repo).toBe("hivemoot/sandbox");
      expect(result.report.outcome).toBe("success");
      expect(result.report.duration_secs).toBe(42);
      expect(result.report.consecutive_failures).toBe(0);
      expect(result.report.received_at).toBeDefined();
    }
  });

  it("accepts optional error and exit_code fields", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "20260224-100001-claude-bee-1",
      outcome: "failure",
      duration_secs: 45,
      consecutive_failures: 1,
      error: "timeout",
      exit_code: 124,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.error).toBe("timeout");
      expect(result.report.exit_code).toBe(124);
    }
  });

  it("rejects non-object body", () => {
    expect(validateReport("string").ok).toBe(false);
    expect(validateReport(null).ok).toBe(false);
    expect(validateReport([]).ok).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      summary: "should be rejected",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unknown field");
  });

  it("rejects invalid agent_id", () => {
    const result = validateReport({
      agent_id: "BEE#1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("agent_id");
  });

  it("rejects invalid repo format", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "not-a-repo",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("owner/name");
  });

  it("rejects missing run_id", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("run_id");
  });

  it("rejects invalid outcome", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "idle",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("outcome");
  });

  it("rejects non-integer duration_secs", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1.5,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("duration_secs");
  });

  it("rejects negative consecutive_failures", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("consecutive_failures");
  });

  it("rejects overly long error", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "failure",
      duration_secs: 1,
      consecutive_failures: 1,
      error: "x".repeat(257),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("error");
  });

  it("rejects non-integer exit_code", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "failure",
      duration_secs: 1,
      consecutive_failures: 1,
      exit_code: 0.5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("exit_code");
  });

  it("rejects client-provided received_at as unknown field", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      received_at: "2020-01-01T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unknown field");
  });
});

// ---------------------------------------------------------------------------
// Tests - checkRateLimit
// ---------------------------------------------------------------------------

describe("checkRateLimit", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("allows the first request", async () => {
    const allowed = await checkRateLimit("inst-1", "bee-1", "repo", redis);
    expect(allowed).toBe(true);
  });

  it("blocks a second request within the window", async () => {
    await checkRateLimit("inst-1", "bee-1", "repo", redis);
    const allowed = await checkRateLimit("inst-1", "bee-1", "repo", redis);
    expect(allowed).toBe(false);
  });

  it("allows requests from different agents", async () => {
    await checkRateLimit("inst-1", "bee-1", "repo", redis);
    const allowed = await checkRateLimit("inst-1", "bee-2", "repo", redis);
    expect(allowed).toBe(true);
  });

  it("allows requests for different repos", async () => {
    await checkRateLimit("inst-1", "bee-1", "repo-a", redis);
    const allowed = await checkRateLimit("inst-1", "bee-1", "repo-b", redis);
    expect(allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests - recordHealthReport
// ---------------------------------------------------------------------------

describe("recordHealthReport", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("writes through Redis multi pipeline", async () => {
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      received_at: "2026-02-24T10:00:00Z",
    };

    await recordHealthReport("inst-1", report, redis);

    expect(redis.multi).toHaveBeenCalledTimes(1);
  });

  it("stores the latest report with TTL", async () => {
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      received_at: "2026-02-24T10:00:00Z",
    };

    await recordHealthReport("inst-1", report, redis);

    expect(redis.set).toHaveBeenCalledWith(
      "agent-health:latest:inst-1:bee-1:hivemoot/sandbox",
      report,
      { ex: 1800 },
    );
  });

  it("adds to the runs sorted set", async () => {
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "failure",
      duration_secs: 64,
      consecutive_failures: 1,
      error: "timeout",
      exit_code: 124,
      received_at: "2026-02-24T10:00:00Z",
    };

    await recordHealthReport("inst-1", report, redis);

    expect(redis.zadd).toHaveBeenCalledWith(
      "agent-health:runs:inst-1:bee-1:hivemoot/sandbox",
      {
        score: new Date("2026-02-24T10:00:00Z").getTime(),
        member: JSON.stringify(report),
      },
    );
  });

  it("adds agent:repo to the index set", async () => {
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      received_at: "2026-02-24T10:00:00Z",
    };

    await recordHealthReport("inst-1", report, redis);

    expect(redis.sadd).toHaveBeenCalledWith(
      "agent-health:index:inst-1",
      "bee-1:hivemoot/sandbox",
    );
  });

  it("trims old entries from runs", async () => {
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      received_at: "2026-02-24T10:00:00Z",
    };

    await recordHealthReport("inst-1", report, redis);

    const receivedMs = new Date("2026-02-24T10:00:00Z").getTime();
    const cutoff = receivedMs - 24 * 60 * 60 * 1000;

    expect(redis.zremrangebyscore).toHaveBeenCalledWith(
      "agent-health:runs:inst-1:bee-1:hivemoot/sandbox",
      "-inf",
      cutoff,
    );
  });
});
