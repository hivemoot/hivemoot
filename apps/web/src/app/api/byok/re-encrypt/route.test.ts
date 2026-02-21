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
  decrypt: vi.fn(),
}));
vi.mock("@/server/byok-store", () => ({
  getByokEnvelope: vi.fn(),
  setByokEnvelope: vi.fn(),
}));

import { authenticateByokRequest } from "@/server/byok-auth";
import { encrypt, decrypt } from "@/server/crypto";
import { getByokEnvelope, setByokEnvelope } from "@/server/byok-store";
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
    keyring: new Map([
      ["v1", Buffer.alloc(32)],
      ["v2", Buffer.alloc(32)],
    ]),
    activeKeyVersion: "v2",
    redis: {} as never,
  });
}

const OLD_ENVELOPE = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  ciphertext: "old-encrypted",
  iv: "old-iv",
  tag: "old-tag",
  keyVersion: "v1",
  status: "active" as const,
  updatedAt: "2026-02-19T12:00:00Z",
  updatedBy: "alice",
  fingerprint: "1234",
};

function makeRequest() {
  return new NextRequest("https://example.com/api/byok/re-encrypt", {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthSuccess();
  vi.mocked(getByokEnvelope).mockResolvedValue({ ...OLD_ENVELOPE });
  vi.mocked(decrypt).mockReturnValue("sk-ant-plaintext-key");
  vi.mocked(encrypt).mockReturnValue({
    ciphertext: "new-encrypted",
    iv: "new-iv",
    tag: "new-tag",
    keyVersion: "v2",
  });
  vi.mocked(setByokEnvelope).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/byok/re-encrypt", () => {
  it("re-encrypts an envelope with the active key version", async () => {
    const req = makeRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reEncrypted).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.failed).toEqual([]);

    // Verify decrypt was called with old envelope
    expect(decrypt).toHaveBeenCalledWith(
      expect.objectContaining({ keyVersion: "v1" }),
      expect.any(Map),
    );

    // Verify encrypt was called with new key version
    expect(encrypt).toHaveBeenCalledWith("sk-ant-plaintext-key", "v2", expect.any(Map));
  });

  it("skips envelopes already on current key version", async () => {
    vi.mocked(getByokEnvelope).mockResolvedValue({
      ...OLD_ENVELOPE,
      keyVersion: "v2",
    });

    const req = makeRequest();
    const res = await POST(req);
    const body = await res.json();

    expect(body.reEncrypted).toBe(0);
    expect(body.skipped).toBe(1);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("skips revoked envelopes", async () => {
    vi.mocked(getByokEnvelope).mockResolvedValue({
      ...OLD_ENVELOPE,
      status: "revoked",
      ciphertext: "",
      iv: "",
      tag: "",
    });

    const req = makeRequest();
    const res = await POST(req);
    const body = await res.json();

    expect(body.reEncrypted).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it("skips when envelope does not exist", async () => {
    vi.mocked(getByokEnvelope).mockResolvedValue(null);

    const req = makeRequest();
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reEncrypted).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it("records failed installations without aborting", async () => {
    vi.mocked(decrypt).mockImplementation(() => {
      throw new Error("tampered");
    });

    const req = makeRequest();
    const res = await POST(req);
    const body = await res.json();

    expect(body.reEncrypted).toBe(0);
    expect(body.failed).toEqual([MOCK_SESSION.installationId]);
  });
});
