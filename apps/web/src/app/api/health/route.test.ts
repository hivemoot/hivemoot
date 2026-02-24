import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock next/server before importing the route handler
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

import { GET } from "./route";

// process.env typed as mutable for test manipulation
type MutableEnv = Record<string, string | undefined>;

describe("GET /api/health", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv } as typeof process.env;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const env = () => process.env as MutableEnv;

  it("returns 200 with status ok in development", () => {
    delete env().NODE_ENV;

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.timestamp).toBeDefined();
  });

  it("returns 503 with missing vars in production", () => {
    env().NODE_ENV = "production";
    delete env().HIVEMOOT_REDIS_REST_URL;
    delete env().HIVEMOOT_REDIS_REST_TOKEN;
    delete env().GITHUB_APP_ID;
    delete env().GITHUB_APP_PRIVATE_KEY;
    delete env().GITHUB_CLIENT_ID;
    delete env().GITHUB_CLIENT_SECRET;
    delete env().BYOK_ACTIVE_KEY_VERSION;
    delete env().BYOK_MASTER_KEYS;
    delete env().NEXT_PUBLIC_SITE_URL;

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("error");
    expect(response.body.missing).toEqual([
      "HIVEMOOT_REDIS_REST_URL",
      "HIVEMOOT_REDIS_REST_TOKEN",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "BYOK_ACTIVE_KEY_VERSION",
      "BYOK_MASTER_KEYS",
      "NEXT_PUBLIC_SITE_URL",
    ]);
  });

  it("returns 200 in production when all vars present", () => {
    env().NODE_ENV = "production";
    env().HIVEMOOT_REDIS_REST_URL = "https://example.upstash.io";
    env().HIVEMOOT_REDIS_REST_TOKEN = "test-token";
    env().GITHUB_APP_ID = "99";
    env().GITHUB_APP_PRIVATE_KEY = "key";
    env().GITHUB_CLIENT_ID = "Iv1.test";
    env().GITHUB_CLIENT_SECRET = "secret";
    env().BYOK_ACTIVE_KEY_VERSION = "v1";
    env().BYOK_MASTER_KEYS = '{"v1":"' + "a".repeat(64) + '"}';

    env().NEXT_PUBLIC_SITE_URL = "https://hivemoot.dev";

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.env).toBe("production");
  });

});
