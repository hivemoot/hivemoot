import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));
vi.mock("@/server/crypto", () => ({
  encrypt: vi.fn(),
}));
vi.mock("@/server/byok-store", () => ({
  setByokEnvelope: vi.fn(),
}));
vi.mock("@/server/provider-validation", () => ({
  validateProviderKey: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { encrypt } from "@/server/crypto";
import { setByokEnvelope } from "@/server/byok-store";
import { validateProviderKey } from "@/server/provider-validation";
import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  installationId: "123",
  userId: 1,
  userLogin: "alice",
};

const MOCK_KEYRING = new Map([["v1", Buffer.alloc(32)]]);

function mockAuthSuccess() {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: MOCK_SESSION,
    keyring: MOCK_KEYRING,
    activeKeyVersion: "v1",
    redis: {} as never,
  });
}

function mockAuthFailure(status: number, code: string, message: string) {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: false,
    response: NextResponse.json({ code, message }, { status }),
  });
}

function makeRequest(body: unknown) {
  return new NextRequest("https://example.com/api/byok/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
  vi.mocked(validateProviderKey).mockResolvedValue({ valid: true });
  vi.mocked(encrypt).mockReturnValue({
    ciphertext: "encrypted",
    iv: "iv",
    tag: "tag",
    keyVersion: "v1",
  });
  vi.mocked(setByokEnvelope).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/byok/config", () => {
  it("creates a BYOK config and returns status", async () => {
    const req = makeRequest({
      installationId: "123",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test1234",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.provider).toBe("anthropic");
    expect(body.fingerprint).toBe("1234");
    expect(setByokEnvelope).toHaveBeenCalledWith(
      "123",
      expect.objectContaining({ status: "active", provider: "anthropic" }),
      expect.anything(),
    );
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthFailure(401, "byok_not_authenticated", "Not authenticated");
    const req = makeRequest({ installationId: "123" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const req = makeRequest({ installationId: "123" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is not valid JSON", async () => {
    const req = new NextRequest("https://example.com/api/byok/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 403 when installationId does not match session", async () => {
    const req = makeRequest({
      installationId: "999",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-test1234",
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 with byok_provider_invalid when key validation fails", async () => {
    vi.mocked(validateProviderKey).mockResolvedValue({
      valid: false,
      reason: "Invalid API key",
    });

    const req = makeRequest({
      installationId: "123",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "bad-key",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("byok_provider_invalid");
    expect(body.message).toBe("Invalid API key");
  });

  it("does not include API key in error responses", async () => {
    vi.mocked(validateProviderKey).mockResolvedValue({
      valid: false,
      reason: "Invalid API key",
    });

    const req = makeRequest({
      installationId: "123",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-secret-key-value",
    });
    const res = await POST(req);
    const body = await res.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("sk-ant-secret-key-value");
  });
});
