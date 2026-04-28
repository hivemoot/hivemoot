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
    (this as { getInstallationOctokit: typeof getInstallationOctokitMock }).getInstallationOctokit =
      getInstallationOctokitMock;
  });
  process.env.CRON_SECRET = "test-secret";
  process.env.HIVEMOOT_QUEEN_INSTALLATION_ID = "67890";
  // WarRoomClient validates this at construction. Tests don't make
  // real HTTP calls (the manager-loop is mocked), but the
  // construction path runs.
  process.env.HIVEMOOT_BOT_AGENT_TOKEN = "test-bearer-token";
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

describe("GET /api/queen/tick — installationId resolution", () => {
  it("returns 500 when neither query nor env supplies installationId", async () => {
    delete process.env.HIVEMOOT_QUEEN_INSTALLATION_ID;
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      code: "no_installation_id",
    });
  });

  it("returns 400 when installationId is non-numeric", async () => {
    delete process.env.HIVEMOOT_QUEEN_INSTALLATION_ID;
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

  it("uses query param when provided (overrides env)", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({
        authorization: "Bearer test-secret",
        url: "/api/queen/tick?installationId=99999",
      }),
      res,
    );
    expect(res._statusCode).toBe(200);
    expect(getInstallationOctokitMock).toHaveBeenCalledWith(99999);
    expect(JSON.parse(res._body).installationId).toBe("99999");
  });

  it("falls back to HIVEMOOT_QUEEN_INSTALLATION_ID env var", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    expect(getInstallationOctokitMock).toHaveBeenCalledWith(67890);
    expect(JSON.parse(res._body).installationId).toBe("67890");
  });
});

describe("GET /api/queen/tick — happy path", () => {
  it("returns 200 with runnerId + installationId + result", async () => {
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.runnerId).toBeDefined();
    expect(body.installationId).toBe("67890");
    expect(body.result).toEqual(HAPPY_RESULT);
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
  it("returns 500 when runQueenManagerLoop throws", async () => {
    runQueenManagerLoopMock.mockRejectedValueOnce(new Error("upstream 502"));
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      code: "tick_failed",
      message: "upstream 502",
    });
  });

  it("returns 500 when getAppConfig throws", async () => {
    getAppConfigMock.mockImplementationOnce(() => {
      throw new Error("APP_ID environment variable is not set");
    });
    const res = makeResponse();
    await handler(
      makeRequest({ authorization: "Bearer test-secret" }),
      res,
    );
    expect(res._statusCode).toBe(500);
    expect(JSON.parse(res._body).code).toBe("tick_failed");
  });
});
