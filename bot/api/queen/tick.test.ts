/**
 * Tests for the GET /api/queen/tick Vercel function (G'.5).
 * Mocks the App + manager-loop dependencies so the tests don't make
 * network calls or instantiate real Octokit clients.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

const {
  runQueenManagerLoopMock,
  createSynthesizerMock,
  getAppConfigMock,
  getInstallationOctokitMock,
  AppCtorMock,
} = vi.hoisted(() => ({
  runQueenManagerLoopMock: vi.fn(),
  createSynthesizerMock: vi.fn(),
  getAppConfigMock: vi.fn(),
  getInstallationOctokitMock: vi.fn(),
  AppCtorMock: vi.fn(),
}));

vi.mock("../lib/queen/manager-loop.js", () => ({
  runQueenManagerLoop: runQueenManagerLoopMock,
}));

vi.mock("../lib/queen/ai-sdk-synthesizer.js", () => ({
  createSynthesizer: createSynthesizerMock,
}));

vi.mock("../lib/env-validation.js", () => ({
  getAppConfig: getAppConfigMock,
}));

vi.mock("octokit", () => ({
  App: AppCtorMock,
}));

import handler from "./tick.js";

interface MockResponse extends ServerResponse {
  _statusCode: number;
  _body: string;
  _headers: Record<string, string>;
}

function makeRequest(opts: {
  method?: string;
  url?: string;
  authorization?: string | undefined;
}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.authorization !== undefined) {
    headers.authorization = opts.authorization;
  }
  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "/api/queen/tick",
    headers,
  } as unknown as IncomingMessage;
}

function makeResponse(): MockResponse {
  const r: MockResponse = {
    statusCode: 0,
    _statusCode: 0,
    _body: "",
    _headers: {},
    setHeader(name: string, value: string) {
      this._headers[name.toLowerCase()] = value;
      return this;
    },
    end(body?: string) {
      if (typeof body === "string") this._body = body;
      this._statusCode = this.statusCode;
      return this;
    },
  } as unknown as MockResponse;
  return r;
}

const HAPPY_RESULT = {
  totalRoomsScanned: 3,
  scannedAwaitingContributions: 1,
  eligible: 1,
  claimed: 1,
  closed: 1,
  conflicts: 0,
  staleClaimsAbandoned: 0,
  postsSucceeded: 1,
  postsFailed: 0,
  postsSkipped: 0,
  errors: 0,
};

beforeEach(() => {
  runQueenManagerLoopMock.mockReset().mockResolvedValue(HAPPY_RESULT);
  createSynthesizerMock.mockReset().mockResolvedValue({});
  getAppConfigMock.mockReset().mockReturnValue({
    appId: 12345,
    privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  });
  getInstallationOctokitMock.mockReset().mockResolvedValue({
    rest: { issues: { createComment: vi.fn() } },
  });
  AppCtorMock.mockReset().mockImplementation(function (this: unknown) {
    const self = this as {
      getInstallationOctokit: typeof getInstallationOctokitMock;
      eachInstallation: { iterator: () => AsyncIterable<{ installation: { id: number } }> };
    };
    self.getInstallationOctokit = getInstallationOctokitMock;
    // Default mock fleet: a single installation matching the legacy
    // env-var (67890) so individual tests don't have to set up the
    // iterator unless they need a multi-tenant scenario. Tests that
    // exercise multi-tenant iteration override `eachInstallation`
    // before invoking the handler.
    self.eachInstallation = {
      iterator: () =>
        (async function* () {
          yield { installation: { id: 67890 } };
        })(),
    };
  });
  process.env.CRON_SECRET = "test-secret";
  // WarRoomStore validates these at construction. Tests don't hit
  // real Redis (the manager-loop is mocked), but `getRedisClient()`
  // throws if the env vars are missing, so the construction path
  // needs them set.
  process.env.HIVEMOOT_REDIS_REST_URL = "https://redis.example/test";
  process.env.HIVEMOOT_REDIS_REST_TOKEN = "test-redis-token";
  delete process.env.HIVEMOOT_BOT_AGENT_TOKEN;
  delete process.env.HIVEMOOT_QUEEN_RUNNER_ID;
  delete process.env.HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/queen/tick — auth", () => {
  it("returns 401 when CRON_SECRET env var is unset (misconfig)", async () => {
    delete process.env.CRON_SECRET;
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(401);
    // Empty body — no oracle for "deployment misconfigured" vs "wrong bearer".
    expect(res._body).toBe("");
  });

  it("returns 401 when authorization header is missing", async () => {
    const res = makeResponse();
    await handler(makeRequest({}), res);
    expect(res._statusCode).toBe(401);
    expect(res._body).toBe("");
  });

  it("returns 401 when authorization header is wrong", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer wrong-secret" }),
      res,
    );
    expect(res._statusCode).toBe(401);
    expect(res._body).toBe("");
  });

  it("returns 401 for non-Bearer authorization scheme", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Basic test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(401);
  });
});

describe("GET /api/queen/tick — method", () => {
  it("returns 405 for POST", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({
        method: "POST",
        authorization: "Bearer test-secret",
      }),
      res,
    );
    expect(res._statusCode).toBe(405);
    expect(JSON.parse(res._body)).toMatchObject({
      code: "method_not_allowed",
    });
  });

  it("returns 405 for DELETE", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({
        method: "DELETE",
        authorization: "Bearer test-secret",
      }),
      res,
    );
    expect(res._statusCode).toBe(405);
  });
});

describe("GET /api/queen/tick — installation iteration", () => {
  it("returns 400 when ?installationId= override is non-numeric", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({
        authorization: "Bearer test-secret",
        url: "/api/queen/tick?installationId=not-a-number",
      }),
      res,
    );
    expect(res._statusCode).toBe(400);
    expect(JSON.parse(res._body)).toMatchObject({
      code: "invalid_installation_id",
    });
  });

  it("with ?installationId= override, runs ONE installation only", async () => {
    // Wide default iterator (5 installations) — the override should
    // skip iteration entirely and run just the one specified.
    AppCtorMock.mockImplementationOnce(function (this: unknown) {
      const self = this as { getInstallationOctokit: typeof getInstallationOctokitMock; eachInstallation: { iterator: () => AsyncIterable<{ installation: { id: number } }> } };
      self.getInstallationOctokit = getInstallationOctokitMock;
      self.eachInstallation = {
        iterator: () =>
          (async function* () {
            yield { installation: { id: 11111 } };
            yield { installation: { id: 22222 } };
            yield { installation: { id: 33333 } };
          })(),
      };
    });
    const res = makeResponse();
    await handler(
      makeRequest({
        authorization: "Bearer test-secret",
        url: "/api/queen/tick?installationId=99999",
      }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].installationId).toBe("99999");
    expect(getInstallationOctokitMock).toHaveBeenCalledWith(99999);
    expect(getInstallationOctokitMock).toHaveBeenCalledTimes(1);
  });

  it("without override, iterates every installation the App is on", async () => {
    AppCtorMock.mockImplementationOnce(function (this: unknown) {
      const self = this as { getInstallationOctokit: typeof getInstallationOctokitMock; eachInstallation: { iterator: () => AsyncIterable<{ installation: { id: number } }> } };
      self.getInstallationOctokit = getInstallationOctokitMock;
      self.eachInstallation = {
        iterator: () =>
          (async function* () {
            yield { installation: { id: 1001 } };
            yield { installation: { id: 1002 } };
            yield { installation: { id: 1003 } };
          })(),
      };
    });
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.installations.map((i: { installationId: string }) => i.installationId)).toEqual([
      "1001",
      "1002",
      "1003",
    ]);
    expect(runQueenManagerLoopMock).toHaveBeenCalledTimes(3);
  });

  it("aggregates per-installation counters into the top-level summary", async () => {
    AppCtorMock.mockImplementationOnce(function (this: unknown) {
      const self = this as { getInstallationOctokit: typeof getInstallationOctokitMock; eachInstallation: { iterator: () => AsyncIterable<{ installation: { id: number } }> } };
      self.getInstallationOctokit = getInstallationOctokitMock;
      self.eachInstallation = {
        iterator: () =>
          (async function* () {
            yield { installation: { id: 2001 } };
            yield { installation: { id: 2002 } };
          })(),
      };
    });
    runQueenManagerLoopMock.mockReset();
    runQueenManagerLoopMock.mockResolvedValueOnce({
      ...HAPPY_RESULT,
      claimed: 2,
      closed: 2,
      postsSucceeded: 2,
    });
    runQueenManagerLoopMock.mockResolvedValueOnce({
      ...HAPPY_RESULT,
      claimed: 1,
      closed: 0,
      postsSucceeded: 0,
      errors: 1,
    });
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.aggregated.claimed).toBe(3);
    expect(body.aggregated.closed).toBe(2);
    expect(body.aggregated.postsSucceeded).toBe(2);
    expect(body.aggregated.errors).toBe(1);
  });

  it("isolates per-installation failures: one tenant erroring doesn't block others", async () => {
    AppCtorMock.mockImplementationOnce(function (this: unknown) {
      const self = this as { getInstallationOctokit: typeof getInstallationOctokitMock; eachInstallation: { iterator: () => AsyncIterable<{ installation: { id: number } }> } };
      self.getInstallationOctokit = getInstallationOctokitMock;
      self.eachInstallation = {
        iterator: () =>
          (async function* () {
            yield { installation: { id: 3001 } };
            yield { installation: { id: 3002 } };
            yield { installation: { id: 3003 } };
          })(),
      };
    });
    runQueenManagerLoopMock.mockReset();
    runQueenManagerLoopMock.mockResolvedValueOnce(HAPPY_RESULT);
    runQueenManagerLoopMock.mockRejectedValueOnce(new Error("tenant 3002 broke"));
    runQueenManagerLoopMock.mockResolvedValueOnce(HAPPY_RESULT);

    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.installations).toHaveLength(3);
    expect(body.installations[1].error).toContain("tenant 3002 broke");
    expect(body.installations[0].result).toBeDefined();
    expect(body.installations[2].result).toBeDefined();
    // Per-tenant errors increment the aggregated errors counter so
    // alerting catches them at the deployment level.
    expect(body.aggregated.errors).toBe(1);
  });

  it("returns 500 when eachInstallation iteration throws (not per-tenant)", async () => {
    AppCtorMock.mockImplementationOnce(function (this: unknown) {
      const self = this as { getInstallationOctokit: typeof getInstallationOctokitMock; eachInstallation: { iterator: () => AsyncIterable<{ installation: { id: number } }> } };
      self.getInstallationOctokit = getInstallationOctokitMock;
      self.eachInstallation = {
        iterator: () =>
          (async function* () {
            throw new Error("github api 503");
          })(),
      };
    });
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      code: "installations_iteration_failed",
    });
  });
});

describe("GET /api/queen/tick — happy path", () => {
  it("returns 200 with runnerId + installations[] + aggregated", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.runnerId).toBeDefined();
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].installationId).toBe("67890");
    expect(body.installations[0].result).toEqual(HAPPY_RESULT);
    expect(body.aggregated).toMatchObject(HAPPY_RESULT);
  });

  it("constructs App with appId + privateKey from getAppConfig", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(AppCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "12345",
        privateKey: expect.stringContaining("BEGIN"),
      }),
    );
  });

  it("calls createSynthesizer with the installationId", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    expect(createSynthesizerMock).toHaveBeenCalledWith({
      installationId: 67890,
    });
  });

  it("calls runQueenManagerLoop with all four DI dependencies", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    expect(runQueenManagerLoopMock).toHaveBeenCalledTimes(1);
    const args = runQueenManagerLoopMock.mock.calls[0][0];
    expect(args.client).toBeDefined();
    expect(args.synthesizer).toBeDefined();
    expect(args.decisionPoster).toBeDefined();
    expect(args.runnerId).toMatch(/^vercel-queen\.\d+\./);
  });

  it("uses HIVEMOOT_QUEEN_RUNNER_ID env when set", async () => {
    process.env.HIVEMOOT_QUEEN_RUNNER_ID = "queen-prod-deploy-abc";
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    const args = runQueenManagerLoopMock.mock.calls[0][0];
    expect(args.runnerId).toBe("queen-prod-deploy-abc");
  });

  it("forwards HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK as maxRoomsPerTick", async () => {
    process.env.HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK = "25";
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    const args = runQueenManagerLoopMock.mock.calls[0][0];
    expect(args.maxRoomsPerTick).toBe(25);
  });

  it("ignores invalid HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK", async () => {
    process.env.HIVEMOOT_QUEEN_MAX_ROOMS_PER_TICK = "abc";
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    const args = runQueenManagerLoopMock.mock.calls[0][0];
    expect(args.maxRoomsPerTick).toBeUndefined();
  });
});

describe("GET /api/queen/tick — error paths", () => {
  it("per-tenant runQueenManagerLoop failure surfaces in installations[].error (not 500)", async () => {
    // With multi-tenant iteration, a single tenant erroring should NOT
    // 500 the whole tick — the tick handler must keep going for the
    // remaining tenants and surface the failure on the per-tenant row.
    runQueenManagerLoopMock.mockRejectedValueOnce(new Error("upstream 502"));
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0].error).toContain("upstream 502");
    expect(body.aggregated.errors).toBe(1);
  });

  it("returns 500 when getAppConfig throws (App can't be constructed)", async () => {
    getAppConfigMock.mockImplementationOnce(() => {
      throw new Error("APP_ID environment variable is not set");
    });
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(500);
    expect(JSON.parse(res._body).code).toBe("app_init_failed");
  });
});

describe("makeManagerLoopLogAdapter (R1 #542 guard B1)", () => {
  // Closes #542 guard B1: prior adapter signature was (msg) => ...
  // which dropped the meta arg silently. Without this regression,
  // a future refactor could reintroduce the same drop without
  // tripping any test.
  it("preserves structured meta when present", async () => {
    const { makeManagerLoopLogAdapter } = await import("./tick.js");
    const { logger: realLogger } = await import("../lib/logger.js");
    const errorSpy = vi.spyOn(realLogger, "error").mockImplementation(() => {});
    const adapter = makeManagerLoopLogAdapter();
    adapter.error("manager_loop.unexpected_error", {
      roomId: "room-123",
      reason: "explosion",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("room-123"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("explosion"));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[queen-tick]"),
    );
    errorSpy.mockRestore();
  });

  it("formats meta-less calls without trailing JSON", async () => {
    const { makeManagerLoopLogAdapter } = await import("./tick.js");
    const { logger: realLogger } = await import("../lib/logger.js");
    const infoSpy = vi.spyOn(realLogger, "info").mockImplementation(() => {});
    const adapter = makeManagerLoopLogAdapter();
    adapter.info("queen.startup");
    expect(infoSpy).toHaveBeenCalledWith("[queen-tick] queen.startup");
    infoSpy.mockRestore();
  });

  it("handles empty meta object as meta-less", async () => {
    const { makeManagerLoopLogAdapter } = await import("./tick.js");
    const { logger: realLogger } = await import("../lib/logger.js");
    const warnSpy = vi.spyOn(realLogger, "warn").mockImplementation(() => {});
    const adapter = makeManagerLoopLogAdapter();
    adapter.warn("warning", {});
    expect(warnSpy).toHaveBeenCalledWith("[queen-tick] warning");
    warnSpy.mockRestore();
  });
});

describe("GET /api/queen/tick — per-installation lock (R1 #542 builder)", () => {
  // Closes #542 builder R1: tick lock required by WAR_ROOM_DESIGN.md
  // §971 to prevent overlapping fires from burning duplicate LLM
  // credits at the 2-minute schedule + 5-minute maxDuration.
  // Lock is best-effort: when Redis env unset, runs unlocked (V1
  // single-installation dev). When Redis is reachable, SET NX EX
  // 290 acquire + compare-and-DEL release.

  beforeEach(() => {
    delete process.env.HIVEMOOT_REDIS_REST_URL;
    delete process.env.HIVEMOOT_REDIS_REST_TOKEN;
  });

  it("runs unlocked when Redis env is not configured", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    expect(runQueenManagerLoopMock).toHaveBeenCalledTimes(1);
  });

  it("acquires lock via SET NX EX with canonical key + body-form command", async () => {
    // Closes #542 builder R2: previously used path-form
    // /set/key/value?NX&EX=290 which has ambiguous query-arg handling
    // per Upstash docs. Body-form keeps NX/EX as positional command
    // args, semantics unambiguous + matches release path. Key namespace
    // matches WAR_ROOM_DESIGN.md L999 + REDIS_KEY_CONVENTION.md
    // (`hive:v1:lock:*` reserved for distributed locks).
    process.env.HIVEMOOT_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "fake-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "OK" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 1 }), { status: 200 }),
      );
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    // Acquire is the first fetch — verify URL + body-form command.
    const acquireCall = fetchSpy.mock.calls[0];
    expect(acquireCall[0]).toBe("https://fake-redis.upstash.io");
    const acquireBody = JSON.parse(
      (acquireCall[1] as RequestInit).body as string,
    );
    expect(acquireBody[0]).toBe("SET");
    expect(acquireBody[1]).toBe("hive:v1:lock:queen-tick:67890");
    // acquireBody[2] is the runnerId — generated, not asserted to a literal.
    expect(typeof acquireBody[2]).toBe("string");
    expect(acquireBody[3]).toBe("NX");
    expect(acquireBody[4]).toBe("EX");
    expect(acquireBody[5]).toBe("290");
    expect(runQueenManagerLoopMock).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("returns skipped=true on per-installation row when another runner holds the lock (NX result null)", async () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "fake-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: null }), { status: 200 }),
      );
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.installations[0].skipped).toBe(true);
    expect(body.installations[0].reason).toBe("lock_contention");
    expect(runQueenManagerLoopMock).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("releases lock with compare-and-DEL on successful tick completion", async () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "fake-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "OK" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 1 }), { status: 200 }),
      );
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    // Second fetch is the release — POST to base URL with EVAL body.
    const releaseCall = fetchSpy.mock.calls[1];
    expect(releaseCall[0]).toBe("https://fake-redis.upstash.io");
    const body = JSON.parse((releaseCall[1] as RequestInit).body as string);
    expect(body[0]).toBe("EVAL");
    expect(body[1]).toContain("redis.call");
    fetchSpy.mockRestore();
  });

  it("releases lock even when manager loop throws", async () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "fake-token";
    runQueenManagerLoopMock.mockRejectedValueOnce(new Error("loop crash"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "OK" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 1 }), { status: 200 }),
      );
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    // Per-tenant manager-loop failure is captured on the installation
    // row rather than 500'ing the whole tick (multi-tenant isolation
    // — one bad tenant doesn't kill the others).
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.installations[0].error).toContain("loop crash");
    // Release was still attempted via finally.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const releaseCall = fetchSpy.mock.calls[1];
    expect(JSON.parse((releaseCall[1] as RequestInit).body as string)[0]).toBe(
      "EVAL",
    );
    fetchSpy.mockRestore();
  });

  it("falls through to unlocked when acquire HTTP fails (availability)", async () => {
    process.env.HIVEMOOT_REDIS_REST_URL = "https://fake-redis.upstash.io";
    process.env.HIVEMOOT_REDIS_REST_TOKEN = "fake-token";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("ISE", { status: 500 }));
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    expect(runQueenManagerLoopMock).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
