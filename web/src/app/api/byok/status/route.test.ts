import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));
vi.mock("@/server/byok-store", () => ({
  getByokEnvelope: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope } from "@/server/byok-store";
import { BYOK_ERROR } from "@/server/byok-error";
import { GET } from "./route";

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

const MOCK_ENVELOPE = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  ciphertext: "encrypted",
  iv: "iv",
  tag: "tag",
  keyVersion: "v1",
  status: "active" as const,
  updatedAt: "2026-02-19T12:00:00Z",
  updatedBy: "alice",
  fingerprint: "1234",
};

function makeRequest() {
  return new NextRequest("https://example.com/api/byok/status");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
  vi.mocked(getByokEnvelope).mockResolvedValue({ ...MOCK_ENVELOPE });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/byok/status", () => {
  it("returns non-sensitive metadata for an active config", async () => {
    const req = makeRequest();
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-sonnet-4-20250514");
    expect(body.fingerprint).toBeUndefined();
    expect(body.updatedAt).toBe("2026-02-19T12:00:00Z");

    // Must NOT include sensitive fields
    expect(body.ciphertext).toBeUndefined();
    expect(body.iv).toBeUndefined();
    expect(body.tag).toBeUndefined();
    expect(body.keyVersion).toBeUndefined();
  });

  it("returns byok_revoked for a revoked config", async () => {
    vi.mocked(getByokEnvelope).mockResolvedValue({
      ...MOCK_ENVELOPE,
      status: "revoked",
      ciphertext: "",
      iv: "",
      tag: "",
    });

    const req = makeRequest();
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe(BYOK_ERROR.REVOKED);
    expect(body.status).toBe("revoked");
  });

  it("returns 404 with byok_not_configured when no envelope exists", async () => {
    vi.mocked(getByokEnvelope).mockResolvedValue(null);

    const req = makeRequest();
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe(BYOK_ERROR.NOT_CONFIGURED);
    expect(body.message).toBe("BYOK is not configured");
  });

  it("uses installationId from session, not query params", async () => {
    const req = makeRequest();
    await GET(req);

    expect(getByokEnvelope).toHaveBeenCalledWith(
      MOCK_SESSION.installationId,
      expect.anything(),
    );
  });
});
