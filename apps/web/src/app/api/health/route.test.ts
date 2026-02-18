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

describe("GET /api/health", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 200 with status ok in development", () => {
    delete process.env.NODE_ENV;

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.timestamp).toBeDefined();
  });

  it("returns 503 with missing vars in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.ENCRYPTION_KEY;

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
    process.env.NODE_ENV = "production";
    process.env.REDIS_URL = "redis://prod:6379";
    process.env.GITHUB_APP_ID = "99";
    process.env.GITHUB_APP_PRIVATE_KEY = "key";
    process.env.ENCRYPTION_KEY = "a".repeat(64);

    const response = GET() as unknown as { body: Record<string, unknown>; status: number };
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.env).toBe("production");
  });
});
