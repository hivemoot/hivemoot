import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  validateReport,
  validateHeartbeat,
  reserveHealthReportIdempotency,
  commitHealthReportIdempotency,
  releaseHealthReportIdempotency,
  checkRateLimit,
  recordHealthReport,
  recordHeartbeat,
  getOverview,
  getHistory,
  type HealthReport,
  type HeartbeatPayload,
} from "./agent-health-store";

// ---------------------------------------------------------------------------
// Minimal Redis mock with sorted set support + pipeline support
// ---------------------------------------------------------------------------

function makeMockRedis() {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const sortedSets = new Map<string, Map<string, number>>(); // member -> score

  let queuedMultiOps: Array<() => Promise<unknown>> = [];
  let queuedReadOps: Array<() => Promise<unknown>> = [];

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
    ttl: vi.fn(async (key: string) => {
      return store.has(key) ? 1800 : -2;
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
    smembers: vi.fn(async (key: string) => {
      const set = sets.get(key);
      return set ? [...set] : [];
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const m of members) {
        if (set.delete(m)) removed++;
      }
      return removed;
    }),
    zadd: vi.fn(async (key: string, entry: { score: number; member: string }) => {
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      sortedSets.get(key)!.set(entry.member, entry.score);
      return 1;
    }),
    zrange: vi.fn(async (key: string, start: number, stop: number, opts?: { rev?: boolean }) => {
      const zset = sortedSets.get(key);
      if (!zset) return [];
      const entries = [...zset.entries()].sort((a, b) =>
        opts?.rev ? b[1] - a[1] : a[1] - b[1],
      );
      return entries.slice(start, stop + 1).map(([member]) => member);
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
      queuedMultiOps = [];
      return writePipeline;
    }),
    pipeline: vi.fn(() => {
      queuedReadOps = [];
      return readPipeline;
    }),
    _store: store,
    _sets: sets,
    _sortedSets: sortedSets,
  };

  const writePipeline = {
    set: vi.fn((...args: Parameters<typeof client.set>) => {
      queuedMultiOps.push(() => client.set(...args));
      return writePipeline;
    }),
    zadd: vi.fn((...args: Parameters<typeof client.zadd>) => {
      queuedMultiOps.push(() => client.zadd(...args));
      return writePipeline;
    }),
    sadd: vi.fn((...args: Parameters<typeof client.sadd>) => {
      queuedMultiOps.push(() => client.sadd(...args));
      return writePipeline;
    }),
    zremrangebyscore: vi.fn((...args: Parameters<typeof client.zremrangebyscore>) => {
      queuedMultiOps.push(() => client.zremrangebyscore(...args));
      return writePipeline;
    }),
    exec: vi.fn(async () => {
      const results: unknown[] = [];
      for (const op of queuedMultiOps) {
        results.push(await op());
      }
      return results;
    }),
  };

  const readPipeline = {
    get: vi.fn((...args: Parameters<typeof client.get>) => {
      queuedReadOps.push(() => client.get(...args));
      return readPipeline;
    }),
    ttl: vi.fn((...args: Parameters<typeof client.ttl>) => {
      queuedReadOps.push(() => client.ttl(...args));
      return readPipeline;
    }),
    exec: vi.fn(async () => {
      const results: unknown[] = [];
      for (const op of queuedReadOps) {
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
    pipeline: ReturnType<typeof vi.fn>;
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

  it("accepts optional model field for provider-native identifiers", () => {
    const validModels = [
      "openrouter/anthropic/claude-3.5-sonnet",
      "llama3.1:8b",
    ];

    for (const model of validModels) {
      const result = validateReport({
        agent_id: "bee-1",
        repo: "hivemoot/sandbox",
        run_id: "20260224-100002-model-attribution",
        outcome: "success",
        duration_secs: 12,
        consecutive_failures: 0,
        model,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.report.model).toBe(model);
    }
  });

  it("rejects invalid model field values", () => {
    const invalidModels = ["", "x".repeat(129), "bad char!", "mødel"];

    for (const model of invalidModels) {
      const result = validateReport({
        agent_id: "bee-1",
        repo: "hivemoot/sandbox",
        run_id: "20260224-100003-invalid-model",
        outcome: "success",
        duration_secs: 10,
        consecutive_failures: 0,
        model,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("model");
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

  it("rejects agent_id containing colon", () => {
    const result = validateReport({
      agent_id: "bee:1",
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

  it("accepts a valid next_run_at", () => {
    const futureIso = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      next_run_at: futureIso,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.next_run_at).toBe(futureIso);
    }
  });

  it("rejects next_run_at more than 5 minutes in the past", () => {
    const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      next_run_at: pastIso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("past");
  });

  it("rejects next_run_at more than 48 hours in the future", () => {
    const farFuture = new Date(Date.now() + 49 * 60 * 60 * 1000).toISOString();
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      next_run_at: farFuture,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("48 hours");
  });

  it("rejects invalid ISO 8601 next_run_at", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      next_run_at: "not-a-date",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ISO 8601");
  });

  it("rejects overly long next_run_at", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      next_run_at: "x".repeat(65),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("next_run_at");
  });

  it("omits next_run_at from report when not provided", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.next_run_at).toBeUndefined();
    }
  });

  it("accepts a valid trigger field", () => {
    for (const trigger of ["scheduled", "mention", "manual"] as const) {
      const result = validateReport({
        agent_id: "bee-1",
        repo: "hivemoot/sandbox",
        run_id: "run-1",
        outcome: "success",
        duration_secs: 1,
        consecutive_failures: 0,
        trigger,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.report.trigger).toBe(trigger);
    }
  });

  it("rejects an invalid trigger value", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      trigger: "cron",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("trigger");
  });

  it("omits trigger when not provided", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.trigger).toBeUndefined();
  });

  it("accepts a full token_usage object", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 540,
      consecutive_failures: 0,
      token_usage: {
        input_tokens: 139367,
        output_tokens: 20573,
        cache_read_input_tokens: 6164579,
        cache_creation_input_tokens: 74218,
        cost_usd: 4.18,
        num_turns: 93,
        model_breakdown: {
          "claude-sonnet-4-6": {
            input_tokens: 95,
            output_tokens: 17375,
            cache_read_input_tokens: 6164579,
            cache_creation_input_tokens: 74218,
            cost_usd: 3.98,
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.token_usage?.cost_usd).toBe(4.18);
      expect(result.report.token_usage?.num_turns).toBe(93);
    }
  });

  it("accepts token_usage with null optional fields (codex-style)", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 300,
      consecutive_failures: 0,
      token_usage: {
        input_tokens: 2508878,
        output_tokens: 25086,
        cache_read_input_tokens: 2259200,
        cache_creation_input_tokens: null,
        cost_usd: null,
        num_turns: 75,
        model_breakdown: null,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.token_usage?.cost_usd).toBeNull();
      expect(result.report.token_usage?.model_breakdown).toBeNull();
    }
  });

  it("accepts token_usage: null (unsupported provider)", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 60,
      consecutive_failures: 0,
      token_usage: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.token_usage).toBeNull();
  });

  it("accepts run_summary, strips ANSI escapes, and trims surrounding whitespace", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 60,
      consecutive_failures: 0,
      run_summary: "\n\u001b[32m### Done\u001b[39m\nMerged docs and posted review.\n",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.run_summary).toBe("### Done\nMerged docs and posted review.");
    }
  });

  it("rejects run_summary that is empty after ANSI stripping", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 60,
      consecutive_failures: 0,
      run_summary: "\u001b[31m\u001b[0m   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("run_summary");
  });

  it("caps run_summary at 4096 chars after sanitization", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 60,
      consecutive_failures: 0,
      run_summary: `${"\u001b[32m"}${"x".repeat(5000)}\u001b[0m`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.report.run_summary).toHaveLength(4096);
    }
  });

  it("omits token_usage from report when not provided", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.token_usage).toBeUndefined();
  });

  it("rejects token_usage with non-integer input_tokens", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      token_usage: {
        input_tokens: 1.5,
        output_tokens: 100,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cost_usd: null,
        num_turns: 1,
        model_breakdown: null,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("input_tokens");
  });

  it("rejects token_usage with invalid model_breakdown key", () => {
    const result = validateReport({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      token_usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cost_usd: null,
        num_turns: 1,
        model_breakdown: {
          "invalid model id with spaces": {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
            cost_usd: null,
          },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("model_breakdown");
  });
});

// ---------------------------------------------------------------------------
// Tests - idempotency
// ---------------------------------------------------------------------------

describe("reserveHealthReportIdempotency", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  const baseReport: HealthReport = {
    agent_id: "bee-1",
    repo: "hivemoot/sandbox",
    run_id: "run-42",
    outcome: "success",
    duration_secs: 42,
    consecutive_failures: 0,
    received_at: "2026-02-24T10:00:00Z",
  };

  it("reserves a new run_id on first write", async () => {
    const reservation = await reserveHealthReportIdempotency("inst-1", baseReport, redis);
    expect(reservation).toStrictEqual({
      kind: "new",
      receivedAt: "2026-02-24T10:00:00Z",
    });
  });

  it("returns pending for same run payload while first write is in-flight", async () => {
    await reserveHealthReportIdempotency("inst-1", baseReport, redis);

    const retryReport: HealthReport = {
      ...baseReport,
      received_at: "2026-02-24T10:01:00Z",
    };

    const reservation = await reserveHealthReportIdempotency("inst-1", retryReport, redis);
    expect(reservation).toStrictEqual({
      kind: "pending",
    });
  });

  it("returns duplicate for same run payload after commit and preserves original received_at", async () => {
    await reserveHealthReportIdempotency("inst-1", baseReport, redis);
    await commitHealthReportIdempotency("inst-1", baseReport, redis);

    const retryReport: HealthReport = {
      ...baseReport,
      received_at: "2026-02-24T10:01:00Z",
    };

    const reservation = await reserveHealthReportIdempotency("inst-1", retryReport, redis);
    expect(reservation).toStrictEqual({
      kind: "duplicate",
      receivedAt: "2026-02-24T10:00:00Z",
    });
  });

  it("treats model as non-identity metadata for idempotency", async () => {
    await reserveHealthReportIdempotency("inst-1", baseReport, redis);
    await commitHealthReportIdempotency("inst-1", baseReport, redis);

    const retryWithModel: HealthReport = {
      ...baseReport,
      model: "llama3.1:8b",
      received_at: "2026-02-24T10:01:00Z",
    };

    const reservation = await reserveHealthReportIdempotency("inst-1", retryWithModel, redis);
    expect(reservation).toStrictEqual({
      kind: "duplicate",
      receivedAt: "2026-02-24T10:00:00Z",
    });
  });

  it("treats run_summary as non-identity metadata for idempotency", async () => {
    await reserveHealthReportIdempotency("inst-1", baseReport, redis);
    await commitHealthReportIdempotency("inst-1", baseReport, redis);

    const retryWithSummary: HealthReport = {
      ...baseReport,
      run_summary: "### Done\nCommented on #325.",
      received_at: "2026-02-24T10:01:00Z",
    };

    const reservation = await reserveHealthReportIdempotency("inst-1", retryWithSummary, redis);
    expect(reservation).toStrictEqual({
      kind: "duplicate",
      receivedAt: "2026-02-24T10:00:00Z",
    });
  });

  it("returns conflict for same run_id with different payload", async () => {
    await reserveHealthReportIdempotency("inst-1", baseReport, redis);

    const conflicting: HealthReport = {
      ...baseReport,
      outcome: "failure",
      error: "timeout",
      received_at: "2026-02-24T10:02:00Z",
    };

    const reservation = await reserveHealthReportIdempotency("inst-1", conflicting, redis);
    expect(reservation).toStrictEqual({ kind: "conflict" });
  });

  it("releasing reservation allows reprocessing", async () => {
    await reserveHealthReportIdempotency("inst-1", baseReport, redis);
    await releaseHealthReportIdempotency("inst-1", baseReport, redis);

    const reservation = await reserveHealthReportIdempotency("inst-1", baseReport, redis);
    expect(reservation).toStrictEqual({
      kind: "new",
      receivedAt: "2026-02-24T10:00:00Z",
    });
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

  it("stores the latest report with default TTL when no next_run_at", async () => {
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
      { ex: 86400 },
    );
  });

  it("uses dynamic TTL when next_run_at is provided", async () => {
    // Use 14h so 2x (28h = 100800s) exceeds the 24h default floor (86400s)
    const nextRunAt = new Date(Date.now() + 14 * 60 * 60 * 1000).toISOString();
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      next_run_at: nextRunAt,
      received_at: new Date().toISOString(),
    };

    await recordHealthReport("inst-1", report, redis);

    // TTL should be 2x the time until next run (~28 hours = ~100800s), exceeding default 86400
    const setCall = vi.mocked(redis.set).mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("latest"),
    );
    expect(setCall).toBeDefined();
    const ttl = (setCall![2] as { ex: number }).ex;
    expect(ttl).toBeGreaterThan(86400);
    expect(ttl).toBeLessThanOrEqual(14 * 60 * 60 * 2); // ~2x 14h
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

// ---------------------------------------------------------------------------
// Tests — getOverview
// ---------------------------------------------------------------------------

describe("getOverview", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns empty array when no agents are indexed", async () => {
    const result = await getOverview("inst-1", redis);
    expect(result).toEqual([]);
  });

  it("returns overview entries for indexed agents", async () => {
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "failure",
      duration_secs: 33,
      consecutive_failures: 2,
      model: "openai/gpt-4o",
      error: "timeout",
      run_summary: "### Done\nOpened a PR and replied to review.",
      received_at: "2026-02-24T10:00:00Z",
    };

    // Simulate state after recordHealthReport
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", report);

    const result = await getOverview("inst-1", redis);
    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe("bee-1");
    expect(result[0].repo).toBe("hivemoot/sandbox");
    expect(result[0].outcome).toBe("failure");
    expect(result[0].consecutive_failures).toBe(2);
    expect(result[0].model).toBe("openai/gpt-4o");
    expect(result[0].run_summary).toBe("### Done\nOpened a PR and replied to review.");
    expect(result[0].status).toBe("failed");
  });

  it("uses Redis pipeline for overview reads", async () => {
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 1,
      consecutive_failures: 0,
      received_at: "2026-02-24T10:00:00Z",
    });

    await getOverview("inst-1", redis);

    expect(redis.pipeline).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(1);
  });

  it("removes stale index entry when latest key has expired", async () => {
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    // No latest key stored → expired

    const result = await getOverview("inst-1", redis);
    expect(result).toHaveLength(0);
    // Stale entry should be removed from the index
    expect(redis._sets.get("agent-health:index:inst-1")?.has("bee-1:hivemoot/sandbox")).toBe(false);
  });

  it("derives ok status for successful outcome without next_run_at", async () => {
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      received_at: new Date().toISOString(),
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].status).toBe("ok");
  });

  it("derives ok status for successful outcome with future next_run_at", async () => {
    const futureIso = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      next_run_at: futureIso,
      received_at: new Date().toISOString(),
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].status).toBe("ok");
    expect(result[0].next_run_at).toBe(futureIso);
  });

  it("derives late status when past next_run_at plus buffer", async () => {
    // received_at 2h ago, next_run_at 1h ago → interval was 1h, buffer 30min, now past both
    const receivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const nextRunAt = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      next_run_at: nextRunAt,
      received_at: receivedAt,
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].status).toBe("late");
  });

  it("derives failed status for failure outcome regardless of next_run_at", async () => {
    const futureIso = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "failure",
      duration_secs: 42,
      consecutive_failures: 1,
      error: "timeout",
      next_run_at: futureIso,
      received_at: new Date().toISOString(),
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].status).toBe("failed");
  });

  it("derives failed status for timeout outcome", async () => {
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "timeout",
      duration_secs: 3600,
      consecutive_failures: 1,
      received_at: new Date().toISOString(),
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].status).toBe("failed");
  });

  it("sorts entries by received_at descending", async () => {
    redis._sets.set("agent-health:index:inst-1", new Set([
      "bee-1:hivemoot/sandbox",
      "bee-2:hivemoot/sandbox",
    ]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 42,
      consecutive_failures: 0,
      received_at: "2026-02-24T09:00:00Z",
    });
    redis._store.set("agent-health:latest:inst-1:bee-2:hivemoot/sandbox", {
      agent_id: "bee-2",
      repo: "hivemoot/sandbox",
      run_id: "run-2",
      outcome: "failure",
      duration_secs: 20,
      consecutive_failures: 1,
      received_at: "2026-02-24T10:00:00Z",
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].agent_id).toBe("bee-2"); // more recent
    expect(result[1].agent_id).toBe("bee-1");
  });
});

// ---------------------------------------------------------------------------
// Tests — getHistory
// ---------------------------------------------------------------------------

describe("getHistory", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("returns empty array when no history exists", async () => {
    const result = await getHistory("inst-1", "bee-1", "repo", redis);
    expect(result).toEqual([]);
  });

  it("returns parsed reports from sorted set", async () => {
    const recentTimestamp = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const report: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-1",
      outcome: "success",
      duration_secs: 9,
      consecutive_failures: 0,
      run_summary: "### Done\nMerged #281.",
      received_at: recentTimestamp,
    };

    // Simulate stored sorted set data
    const key = "agent-health:runs:inst-1:bee-1:hivemoot/sandbox";
    redis._sortedSets.set(key, new Map([
      [JSON.stringify(report), new Date(recentTimestamp).getTime()],
    ]));

    const result = await getHistory("inst-1", "bee-1", "hivemoot/sandbox", redis);
    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe("bee-1");
    expect(result[0].outcome).toBe("success");
    expect(result[0].run_summary).toBe("### Done\nMerged #281.");
  });

  it("trims stale entries before returning", async () => {
    await getHistory("inst-1", "bee-1", "repo", redis);
    expect(redis.zremrangebyscore).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — validateHeartbeat
// ---------------------------------------------------------------------------

describe("validateHeartbeat", () => {
  it("accepts a minimal heartbeat", () => {
    const result = validateHeartbeat({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "heartbeat",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.heartbeat.agent_id).toBe("bee-1");
      expect(result.heartbeat.repo).toBe("hivemoot/sandbox");
      expect(result.heartbeat.outcome).toBe("heartbeat");
      expect(result.heartbeat.received_at).toBeDefined();
    }
  });

  it("accepts heartbeat with next_run_at", () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const result = validateHeartbeat({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "heartbeat",
      next_run_at: futureIso,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.heartbeat.next_run_at).toBe(futureIso);
    }
  });

  it("rejects unknown fields", () => {
    const result = validateHeartbeat({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "heartbeat",
      run_id: "should-not-be-here",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Unknown field");
  });

  it("rejects non-heartbeat outcome", () => {
    const result = validateHeartbeat({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "success",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("heartbeat");
  });

  it("rejects invalid agent_id", () => {
    const result = validateHeartbeat({
      agent_id: "BEE#1",
      repo: "hivemoot/sandbox",
      outcome: "heartbeat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("agent_id");
  });

  it("rejects invalid repo format", () => {
    const result = validateHeartbeat({
      agent_id: "bee-1",
      repo: "no-slash",
      outcome: "heartbeat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("repo");
  });

  it("rejects non-object body", () => {
    expect(validateHeartbeat("string").ok).toBe(false);
    expect(validateHeartbeat(null).ok).toBe(false);
    expect(validateHeartbeat([]).ok).toBe(false);
  });

  it("rejects next_run_at in the far past", () => {
    const pastIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const result = validateHeartbeat({
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "heartbeat",
      next_run_at: pastIso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("past");
  });
});

// ---------------------------------------------------------------------------
// Tests — recordHeartbeat
// ---------------------------------------------------------------------------

describe("recordHeartbeat", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  const baseHeartbeat: HeartbeatPayload = {
    agent_id: "bee-1",
    repo: "hivemoot/sandbox",
    outcome: "heartbeat",
    received_at: "2026-03-14T12:00:00Z",
  };

  it("stores a minimal heartbeat entry when no prior report exists", async () => {
    await recordHeartbeat("inst-1", baseHeartbeat, redis);

    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      "agent-health:latest:inst-1:bee-1:hivemoot/sandbox",
      expect.objectContaining({ outcome: "heartbeat" }),
      expect.objectContaining({ ex: expect.any(Number) }),
    );
    expect(redis.sadd).toHaveBeenCalledWith(
      "agent-health:index:inst-1",
      "bee-1:hivemoot/sandbox",
    );
  });

  it("does not add to the runs sorted set", async () => {
    await recordHeartbeat("inst-1", baseHeartbeat, redis);

    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it("patches existing report preserving run data", async () => {
    const existingReport: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-42",
      outcome: "success",
      duration_secs: 300,
      consecutive_failures: 0,
      received_at: "2026-03-14T10:00:00Z",
    };

    redis._store.set(
      "agent-health:latest:inst-1:bee-1:hivemoot/sandbox",
      existingReport,
    );

    await recordHeartbeat("inst-1", baseHeartbeat, redis);

    const stored = redis._store.get(
      "agent-health:latest:inst-1:bee-1:hivemoot/sandbox",
    ) as Record<string, unknown>;

    // Run data preserved
    expect(stored.run_id).toBe("run-42");
    expect(stored.outcome).toBe("success");
    expect(stored.duration_secs).toBe(300);
    // Timestamps refreshed
    expect(stored.received_at).toBe("2026-03-14T12:00:00Z");
  });

  it("updates next_run_at on existing report when provided", async () => {
    const futureIso = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const existingReport: HealthReport = {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-42",
      outcome: "success",
      duration_secs: 300,
      consecutive_failures: 0,
      received_at: "2026-03-14T10:00:00Z",
    };

    redis._store.set(
      "agent-health:latest:inst-1:bee-1:hivemoot/sandbox",
      existingReport,
    );

    await recordHeartbeat("inst-1", { ...baseHeartbeat, next_run_at: futureIso }, redis);

    const stored = redis._store.get(
      "agent-health:latest:inst-1:bee-1:hivemoot/sandbox",
    ) as Record<string, unknown>;

    expect(stored.next_run_at).toBe(futureIso);
  });
});

// ---------------------------------------------------------------------------
// Tests — deriveStatus with heartbeat
// ---------------------------------------------------------------------------

describe("getOverview (heartbeat status)", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = makeMockRedis();
  });

  it("derives ok status for a heartbeat-only entry", async () => {
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      outcome: "heartbeat",
      received_at: new Date().toISOString(),
    });

    const result = await getOverview("inst-1", redis);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("ok");
    expect(result[0].outcome).toBe("heartbeat");
  });

  it("preserves failed status from patched report (heartbeat does not mask failure)", async () => {
    // Simulate: a failed run was stored, then a heartbeat patched received_at
    redis._sets.set("agent-health:index:inst-1", new Set(["bee-1:hivemoot/sandbox"]));
    redis._store.set("agent-health:latest:inst-1:bee-1:hivemoot/sandbox", {
      agent_id: "bee-1",
      repo: "hivemoot/sandbox",
      run_id: "run-42",
      outcome: "failure",
      duration_secs: 300,
      consecutive_failures: 3,
      error: "timeout",
      received_at: new Date().toISOString(),
    });

    const result = await getOverview("inst-1", redis);
    expect(result[0].status).toBe("failed");
    expect(result[0].outcome).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// Tests — validateReport trigger: "task"
// ---------------------------------------------------------------------------

describe("validateReport trigger extensions", () => {
  it("accepts trigger: 'task'", () => {
    const result = validateReport({
      agent_id: "attendant",
      repo: "hivemoot/sandbox",
      run_id: "task-run-1",
      outcome: "success",
      duration_secs: 60,
      consecutive_failures: 0,
      trigger: "task",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.trigger).toBe("task");
  });
});
