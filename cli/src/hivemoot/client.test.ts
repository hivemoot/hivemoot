import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CliError } from "../config/types.js";
import {
  DEFAULT_API_URL,
  hivemootGet,
  hivemootPost,
  resolveApiUrl,
  resolveToken,
} from "./client.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.HIVEMOOT_API_URL;
  delete process.env.HIVEMOOT_API_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveApiUrl", () => {
  it("returns the --api-url flag when supplied", () => {
    process.env.HIVEMOOT_API_URL = "https://env.example";
    expect(resolveApiUrl({ apiUrl: "https://flag.example" })).toBe(
      "https://flag.example",
    );
  });

  it("falls back to HIVEMOOT_API_URL env when no flag", () => {
    process.env.HIVEMOOT_API_URL = "https://env.example";
    expect(resolveApiUrl({})).toBe("https://env.example");
  });

  it("falls back to the production default when nothing set", () => {
    expect(resolveApiUrl({})).toBe(DEFAULT_API_URL);
  });

  it("treats empty / whitespace flag as absent", () => {
    process.env.HIVEMOOT_API_URL = "https://env.example";
    expect(resolveApiUrl({ apiUrl: "   " })).toBe("https://env.example");
  });
});

describe("resolveToken", () => {
  it("returns the --token flag when supplied", () => {
    process.env.HIVEMOOT_API_TOKEN = "env-tok";
    expect(resolveToken({ token: "flag-tok" })).toBe("flag-tok");
  });

  it("falls back to HIVEMOOT_API_TOKEN env when no flag", () => {
    process.env.HIVEMOOT_API_TOKEN = "env-tok";
    expect(resolveToken({})).toBe("env-tok");
  });

  it("throws CliError(AUTH_ERROR, exit=2) when neither set", () => {
    expect(() => resolveToken({})).toThrow(CliError);
    try {
      resolveToken({});
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("AUTH_ERROR");
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it("treats whitespace-only as absent", () => {
    process.env.HIVEMOOT_API_TOKEN = "   ";
    expect(() => resolveToken({ token: "   " })).toThrow(CliError);
  });

  it("strips surrounding whitespace from the resolved token", () => {
    expect(resolveToken({ token: "  abc  " })).toBe("abc");
  });
});

function jsonResponse(
  status: number,
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("hivemootGet", () => {
  it("constructs the URL and sends the bearer header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { rooms: [] }),
    );
    await hivemootGet<{ rooms: unknown[] }>({
      apiUrl: "https://api.example",
      token: "tok-123",
      path: "/api/rooms",
      query: { limit: 25, status: undefined },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://api.example/api/rooms?limit=25");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers.Accept).toBe("application/json");
  });

  it("returns parsed JSON on 2xx", async () => {
    const payload = { rooms: [{ roomId: "r1" }] };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, payload));
    const out = await hivemootGet<typeof payload>({
      token: "t",
      apiUrl: "https://x",
      path: "/api/rooms",
      fetchImpl,
    });
    expect(out).toEqual(payload);
  });

  it("maps 401 to exit code 2 (token issue)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { code: "unauthorized", message: "bad bearer" }),
    );
    try {
      await hivemootGet({
        token: "t",
        apiUrl: "https://x",
        path: "/api/rooms",
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("unauthorized");
      expect((err as CliError).message).toContain("401");
      expect((err as CliError).message).toContain("bad bearer");
    }
  });

  it("maps non-401 4xx to exit code 3 with server-supplied code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(403, { code: "missing_capability", message: "need rooms.read_all" }),
    );
    try {
      await hivemootGet({
        token: "t",
        apiUrl: "https://x",
        path: "/api/rooms",
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as CliError).code).toBe("missing_capability");
    }
  });

  it("maps 5xx to exit code 3 with HTTP_<status> code when no body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    try {
      await hivemootGet({
        token: "t",
        apiUrl: "https://x",
        path: "/api/rooms",
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as CliError).code).toBe("HTTP_500");
    }
  });

  it("maps network errors to NETWORK_ERROR / exit 3", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    try {
      await hivemootGet({
        token: "t",
        apiUrl: "https://x",
        path: "/api/rooms",
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).code).toBe("NETWORK_ERROR");
      expect((err as CliError).exitCode).toBe(3);
      expect((err as CliError).message).toContain("https://x");
    }
  });

  it("maps malformed JSON on a 2xx to PARSE_ERROR / exit 3", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await hivemootGet({
        token: "t",
        apiUrl: "https://x",
        path: "/api/rooms",
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).code).toBe("PARSE_ERROR");
      expect((err as CliError).exitCode).toBe(3);
    }
  });

  it("skips undefined and null query values", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await hivemootGet({
      token: "t",
      apiUrl: "https://x",
      path: "/api/rooms",
      query: { limit: 10, status: undefined, repo: null },
      fetchImpl,
    });
    const [calledUrl] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://x/api/rooms?limit=10");
  });

  it("propagates the server message in the CliError text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(429, { code: "rate_limited", message: "too many requests" }),
    );
    try {
      await hivemootGet({
        token: "t",
        apiUrl: "https://x",
        path: "/api/rooms",
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).message).toContain("too many requests");
    }
  });
});

describe("hivemootPost", () => {
  it("sends Bearer auth + JSON content-type and serializes the body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { sequence: 7 }));
    await hivemootPost({
      apiUrl: "https://api.example",
      token: "tok-123",
      path: "/api/rooms/abc/contributions",
      body: { sequenceObservedByClient: 5, body: { verdict: "APPROVE" } },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://api.example/api/rooms/abc/contributions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      sequenceObservedByClient: 5,
      body: { verdict: "APPROVE" },
    });
  });

  it("returns parsed JSON on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { sequence: 42 }));
    const out = await hivemootPost<unknown, { sequence: number }>({
      apiUrl: "https://x",
      token: "t",
      path: "/api/rooms/abc/contributions",
      body: {},
      fetchImpl,
    });
    expect(out).toEqual({ sequence: 42 });
  });

  it("maps 401 to exit 2", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { code: "unauthorized", message: "bad bearer" }),
    );
    try {
      await hivemootPost({
        apiUrl: "https://x",
        token: "t",
        path: "/api/rooms/abc/contributions",
        body: {},
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(2);
      expect((err as CliError).code).toBe("unauthorized");
    }
  });

  it("maps server-supplied 4xx code (e.g., status_precondition_failed)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        code: "status_precondition_failed",
        message: "Room moved to deciding",
      }),
    );
    try {
      await hivemootPost({
        apiUrl: "https://x",
        token: "t",
        path: "/api/rooms/abc/contributions",
        body: {},
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).exitCode).toBe(3);
      expect((err as CliError).code).toBe("status_precondition_failed");
    }
  });

  it("maps network errors to NETWORK_ERROR / exit 3", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    try {
      await hivemootPost({
        apiUrl: "https://x",
        token: "t",
        path: "/api/rooms/abc/contributions",
        body: {},
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).code).toBe("NETWORK_ERROR");
      expect((err as CliError).exitCode).toBe(3);
    }
  });

  it("throws AUTH_ERROR exit 2 when no token configured", async () => {
    const fetchImpl = vi.fn();
    try {
      await hivemootPost({
        apiUrl: "https://x",
        path: "/api/rooms/abc/contributions",
        body: {},
        fetchImpl,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CliError).code).toBe("AUTH_ERROR");
      expect((err as CliError).exitCode).toBe(2);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
