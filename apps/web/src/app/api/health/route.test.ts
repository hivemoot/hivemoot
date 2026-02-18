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
const ENCRYPTION_KEY_FORMAT_ERROR = "ENCRYPTION_KEY (must be 64 hex chars for AES-256-GCM)";

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
    delete env().REDIS_URL;
    delete env().GITHUB_APP_ID;
    delete env().GITHUB_APP_PRIVATE_KEY;
    delete env().ENCRYPTION_KEY;

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("error");
    expect(response.body.missing).toEqual([
      "REDIS_URL",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "ENCRYPTION_KEY",
    ]);
  });

  it("returns 200 in production when all vars present", () => {
    env().NODE_ENV = "production";
    env().REDIS_URL = "redis://prod:6379";
    env().GITHUB_APP_ID = "99";
    env().GITHUB_APP_PRIVATE_KEY = "key";
    env().ENCRYPTION_KEY = "a".repeat(64);

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.env).toBe("production");
  });

  it("returns 503 in production when ENCRYPTION_KEY is malformed", () => {
    env().NODE_ENV = "production";
    env().REDIS_URL = "redis://prod:6379";
    env().GITHUB_APP_ID = "99";
    env().GITHUB_APP_PRIVATE_KEY = "key";
    env().ENCRYPTION_KEY = "not-hex";

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(503);
    expect(response.body.status).toBe("error");
    expect(response.body.missing).toEqual([ENCRYPTION_KEY_FORMAT_ERROR]);
  });
});
