import { describe, it, expect, vi, beforeEach } from "vitest";
import { type Redis } from "@upstash/redis";
import {
  DEFAULT_QUEEN_MODE,
  getQueenSettings,
  setQueenSettings,
  type QueenSettings,
} from "./queen-settings-store";

// ---------------------------------------------------------------------------
// Mock Redis with minimal HSET / HGETALL / HDEL + lock primitives
// ---------------------------------------------------------------------------

interface MockState {
  hashes: Map<string, Map<string, string>>;
  strings: Map<string, { value: string; expiresAt?: number }>;
  evalCalls: number;
}

function makeMockRedis(): Redis & { _state: MockState } {
  const state: MockState = {
    hashes: new Map(),
    strings: new Map(),
    evalCalls: 0,
  };

  const client = {
    hgetall: vi.fn(async (key: string) => {
      const h = state.hashes.get(key);
      if (!h || h.size === 0) return null;
      const obj: Record<string, string> = {};
      for (const [k, v] of h) obj[k] = v;
      return obj;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      const h = state.hashes.get(key) ?? new Map<string, string>();
      let added = 0;
      for (const [k, v] of Object.entries(fields)) {
        if (!h.has(k)) added += 1;
        h.set(k, String(v));
      }
      state.hashes.set(key, h);
      return added;
    }),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      const h = state.hashes.get(key);
      if (!h) return 0;
      let removed = 0;
      for (const f of fields) {
        if (h.delete(f)) removed += 1;
      }
      return removed;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      const h = state.hashes.get(key);
      return h?.get(field) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx) {
        const existing = state.strings.get(key);
        if (existing && (!existing.expiresAt || existing.expiresAt > Date.now())) return null;
      }
      state.strings.set(key, {
        value,
        expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined,
      });
      return "OK";
    }),
    eval: vi.fn(async (_script: string, keys: string[], args: string[]) => {
      state.evalCalls += 1;
      // CAS release: only delete if value matches
      const key = keys[0];
      const expected = args[0];
      const entry = state.strings.get(key);
      if (entry && entry.value === expected) {
        state.strings.delete(key);
        return 1;
      }
      return 0;
    }),
    // Minimal MULTI pipeline mock — chains record ops and run on exec.
    // Only HDEL + HSET wired since those are the ones the store uses;
    // any new chained op gets a "not a function" failure rather than
    // a silently-wrong return.
    multi: vi.fn(() => {
      const ops: Array<() => Promise<unknown>> = [];
      const chain = {
        hdel: (key: string, ...fields: string[]) => {
          ops.push(async () => {
            const h = state.hashes.get(key);
            if (!h) return 0;
            let removed = 0;
            for (const f of fields) {
              if (h.delete(f)) removed += 1;
            }
            return removed;
          });
          return chain;
        },
        hset: (key: string, f: Record<string, string>) => {
          ops.push(async () => {
            const h = state.hashes.get(key) ?? new Map<string, string>();
            for (const [k, v] of Object.entries(f)) h.set(k, String(v));
            state.hashes.set(key, h);
            return 0;
          });
          return chain;
        },
        exec: async () => {
          const out: unknown[] = [];
          for (const op of ops) out.push(await op());
          return out;
        },
      };
      return chain;
    }),
    _state: state,
  };

  return client as unknown as Redis & { _state: MockState };
}

const SETTINGS_KEY = (id: string) => `hive:v1:installation:${id}:queen-settings`;
const LOCK_KEY = (id: string) => `hive:v1:lock:installation:${id}:queen-settings`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getQueenSettings", () => {
  it("returns the documented default for a new installation", async () => {
    const redis = makeMockRedis();
    const settings = await getQueenSettings("42", redis);
    expect(settings).toEqual({
      queen_mode: DEFAULT_QUEEN_MODE,
      queen_prompt_override: null,
    });
  });

  it("returns the stored settings", async () => {
    const redis = makeMockRedis();
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([
        ["queen_mode", "local"],
        ["queen_prompt_override", "merge_conventions: squash-only"],
      ]),
    );
    const settings = await getQueenSettings("42", redis);
    expect(settings.queen_mode).toBe("local");
    expect(settings.queen_prompt_override).toBe("merge_conventions: squash-only");
  });

  it("falls back to cloud when stored mode is malformed (defensive)", async () => {
    const redis = makeMockRedis();
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([["queen_mode", "remote-quantum-mode"]]),
    );
    const settings = await getQueenSettings("42", redis);
    expect(settings.queen_mode).toBe("cloud");
  });

  it("treats empty override field as null, not empty string", async () => {
    const redis = makeMockRedis();
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([
        ["queen_mode", "cloud"],
        ["queen_prompt_override", ""],
      ]),
    );
    const settings = await getQueenSettings("42", redis);
    expect(settings.queen_prompt_override).toBeNull();
  });
});

describe("setQueenSettings", () => {
  let redis: Redis & { _state: MockState };

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it("writes mode + override to the hash and returns previous + current", async () => {
    const result = await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "local", queen_prompt_override: "test override" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.previous.queen_mode).toBe("cloud");
    expect(result.current.queen_mode).toBe("local");
    expect(result.current.queen_prompt_override).toBe("test override");
    // verify storage
    const stored = redis._state.hashes.get(SETTINGS_KEY("42"));
    expect(stored?.get("queen_mode")).toBe("local");
    expect(stored?.get("queen_prompt_override")).toBe("test override");
  });

  it("leaves override unchanged when caller omits the field", async () => {
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([
        ["queen_mode", "cloud"],
        ["queen_prompt_override", "existing override"],
      ]),
    );
    const result = await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "local" }, // no override key
    });
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.current.queen_prompt_override).toBe("existing override");
    const stored = redis._state.hashes.get(SETTINGS_KEY("42"));
    expect(stored?.get("queen_prompt_override")).toBe("existing override");
  });

  it("deletes override when caller passes null explicitly", async () => {
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([
        ["queen_mode", "local"],
        ["queen_prompt_override", "to be deleted"],
      ]),
    );
    const result = await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "local", queen_prompt_override: null },
    });
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.current.queen_prompt_override).toBeNull();
    const stored = redis._state.hashes.get(SETTINGS_KEY("42"));
    expect(stored?.has("queen_prompt_override")).toBe(false);
  });

  it("acquires the per-installation lock during the write (G12)", async () => {
    const setSpy = vi.spyOn(redis, "set");
    await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "local" },
    });
    // First set call should be the lock acquisition with NX + EX
    expect(setSpy).toHaveBeenCalledWith(
      LOCK_KEY("42"),
      expect.any(String),
      expect.objectContaining({ nx: true, ex: expect.any(Number) }),
    );
    // Lock release happens via eval (CAS)
    expect(redis._state.evalCalls).toBeGreaterThan(0);
  });

  it("runs precheck inside the lock and short-circuits on blocked result", async () => {
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([["queen_mode", "cloud"]]),
    );
    const result = await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "local" },
      precheck: async (current) => {
        expect(current.queen_mode).toBe("cloud");
        return { blocked: { reason: "rooms_in_flight", count: 3 } };
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.blocked).toEqual({ reason: "rooms_in_flight", count: 3 });
    // Storage NOT mutated when blocked
    const stored = redis._state.hashes.get(SETTINGS_KEY("42"));
    expect(stored?.get("queen_mode")).toBe("cloud");
  });

  it("proceeds when precheck returns null", async () => {
    const precheck = vi.fn(async () => null);
    const result = await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "local" },
      precheck,
    });
    expect(precheck).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("returns previous settings reflecting prior state", async () => {
    redis._state.hashes.set(
      SETTINGS_KEY("42"),
      new Map([
        ["queen_mode", "local"],
        ["queen_prompt_override", "v1"],
      ]),
    );
    const result = await setQueenSettings({
      installationId: "42",
      redis,
      next: { queen_mode: "cloud", queen_prompt_override: "v2" },
    });
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.previous).toEqual<QueenSettings>({
      queen_mode: "local",
      queen_prompt_override: "v1",
    });
  });
});
