import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
import { BYOK_ERROR } from "@/server/byok-error";
import { POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  installationId: "123",
  userId: 1,
  userLogin: "alice",
};

function mockAuthSuccess() {
  vi.mocked(authenticateByokRequest).mockResolvedValue({
    ok: true,
    session: MOCK_SESSION,
    keyring: new Map([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  });
}

function makeRequest(body: unknown) {
  return new NextRequest("https://example.com/api/byok/rotate", {
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
    ciphertext: "new-encrypted",
    iv: "new-iv",
    tag: "new-tag",
    keyVersion: "v1",
  });
  vi.mocked(setByokEnvelope).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/byok/rotate", () => {
  it("rotates the key and returns updated status", async () => {
    const req = makeRequest({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-new-key5678",
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.fingerprint).toBeUndefined();
    expect(setByokEnvelope).toHaveBeenCalled();
  });

  it("returns 400 when provider validation fails", async () => {
    vi.mocked(validateProviderKey).mockResolvedValue({
      valid: false,
      reason: "Invalid API key",
    });

    const req = makeRequest({
      provider: "anthropic",
      model: "m",
      apiKey: "bad-key",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(BYOK_ERROR.PROVIDER_INVALID);
    expect(body.message).toBe("Invalid API key");
  });

  it("returns 400 when required fields are missing", async () => {
    const req = makeRequest({ provider: "anthropic" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("encrypts a JSON payload containing apiKey, provider, and model", async () => {
    const req = makeRequest({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-new-key5678",
    });
    await POST(req);

    expect(encrypt).toHaveBeenCalledWith(
      JSON.stringify({
        apiKey: "sk-ant-new-key5678",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      }),
      "v1",
      expect.any(Map),
    );
  });

  it("does not encrypt the bare API key string", async () => {
    const req = makeRequest({
      provider: "google",
      model: "gemini-3-flash-preview",
      apiKey: "AIzaSyTest",
    });
    await POST(req);

    const encryptCall = vi.mocked(encrypt).mock.calls[0];
    const plaintext = encryptCall[0];
    expect(() => JSON.parse(plaintext)).not.toThrow();
    const parsed = JSON.parse(plaintext);
    expect(parsed).toHaveProperty("apiKey", "AIzaSyTest");
    expect(parsed).toHaveProperty("provider", "google");
    expect(parsed).toHaveProperty("model", "gemini-3-flash-preview");
  });

  it("uses installationId from session, not request body", async () => {
    const req = makeRequest({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-new-key5678",
    });
    await POST(req);

    expect(setByokEnvelope).toHaveBeenCalledWith(
      MOCK_SESSION.installationId,
      expect.anything(),
      expect.anything(),
    );
  });
});
