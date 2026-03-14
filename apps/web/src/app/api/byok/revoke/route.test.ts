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
  setByokEnvelope: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope, setByokEnvelope } from "@/server/byok-store";
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

function makeRequest(body: unknown) {
  return new NextRequest("https://example.com/api/byok/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockAuthSuccess();
  vi.mocked(getByokEnvelope).mockResolvedValue({ ...MOCK_ENVELOPE });
  vi.mocked(setByokEnvelope).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/byok/revoke", () => {
  it("revokes the BYOK config and clears ciphertext", async () => {
    const req = makeRequest({});
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("revoked");

    // Verify ciphertext was cleared for the session installation
    expect(setByokEnvelope).toHaveBeenCalledWith(
      MOCK_SESSION.installationId,
      expect.objectContaining({
        status: "revoked",
        ciphertext: "",
        iv: "",
        tag: "",
      }),
      expect.anything(),
    );
  });

  it("returns 404 with byok_not_configured when no envelope exists", async () => {
    vi.mocked(getByokEnvelope).mockResolvedValue(null);

    const req = makeRequest({});
    const res = await POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe(BYOK_ERROR.NOT_CONFIGURED);
    expect(body.message).toBe("BYOK is not configured");
  });

  it("returns structured 500 when the BYOK store fails", async () => {
    const error = new Error("redis down");
    vi.mocked(getByokEnvelope).mockRejectedValue(error);

    const req = makeRequest({});
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe(BYOK_ERROR.SERVER_MISCONFIGURATION);
    expect(body.message).toBe("Internal server error");
    expect(console.error).toHaveBeenCalledWith(
      "[byok-revoke] Failed to process request",
      expect.objectContaining({
        installationId: MOCK_SESSION.installationId,
        error,
      }),
    );
  });
});
