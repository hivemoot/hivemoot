/**
 * Route tests for /api/model-credentials/[name] and its lifecycle verbs
 * (GET summary, rotate, revoke, re-encrypt).
 *
 * Asserts the route contract:
 *   - GET passes requireFresh:false; rotate/revoke/re-encrypt pass true
 *   - GET / rotate / revoke never return ciphertext
 *   - IDOR: a foreign name → 404 scoped to the caller (store throws NotFound)
 *   - rotate live-validates an api_key before re-encrypting
 *   - installationId comes from the session, never the path/body
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/server/byok-auth", () => ({
  authenticateByokRequest: vi.fn(),
}));
vi.mock("@/server/require-installation", () => ({
  requireInstallation: vi.fn(),
}));
vi.mock("@/server/provider-validation", () => ({
  validateProviderKey: vi.fn(),
}));
vi.mock("@/server/model-credential-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/model-credential-store")
  >("@/server/model-credential-store");
  return {
    ...actual,
    getModelCredentialSummary: vi.fn(),
    getModelCredential: vi.fn(),
    rotateModelCredential: vi.fn(),
    revokeModelCredential: vi.fn(),
    reEncryptModelCredential: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { validateProviderKey } from "@/server/provider-validation";
import {
  getModelCredentialSummary,
  getModelCredential,
  rotateModelCredential,
  revokeModelCredential,
  reEncryptModelCredential,
  ModelCredentialNotFoundError,
} from "@/server/model-credential-store";

import { GET } from "./route";
import { POST as ROTATE } from "./rotate/route";
import { POST as REVOKE } from "./revoke/route";
import { POST as REENCRYPT } from "./re-encrypt/route";

const mockAuth = vi.mocked(authenticateByokRequest);
const mockRequireInstallation = vi.mocked(requireInstallation);
const mockValidate = vi.mocked(validateProviderKey);
const mockGetSummary = vi.mocked(getModelCredentialSummary);
const mockGet = vi.mocked(getModelCredential);
const mockRotate = vi.mocked(rotateModelCredential);
const mockRevoke = vi.mocked(revokeModelCredential);
const mockReEncrypt = vi.mocked(reEncryptModelCredential);

function authedSession() {
  mockAuth.mockResolvedValue({
    ok: true,
    session: { userLogin: "operator", installationId: "12345" },
    keyring: new Map([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  } as never);
  mockRequireInstallation.mockReturnValue({
    ok: true,
    installationId: "12345",
  } as never);
}

function makeRequest(body?: unknown) {
  return {
    body: body === undefined ? null : {},
    json: async () => body,
    cookies: { get: () => undefined },
  } as never;
}

function params(name: string) {
  return { params: Promise.resolve({ name }) };
}

const SUMMARY = {
  name: "team-claude",
  kind: "api_key" as const,
  provider: "anthropic" as const,
  status: "active" as const,
  fingerprint: "deadbeef",
  createdAt: "2026-05-30T00:00:00.000Z",
  createdBy: "operator",
  rotatedAt: null,
  expiresAt: null,
  deliverable: true,
};

const FULL_ENVELOPE = {
  ...SUMMARY,
  ciphertext: "AAAA",
  iv: "BBBB",
  tag: "CCCC",
  keyVersion: "v1",
};

// ---------------------------------------------------------------------------
// GET [name]
// ---------------------------------------------------------------------------

describe("GET /api/model-credentials/[name]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedSession();
    mockGetSummary.mockResolvedValue(SUMMARY);
  });

  it("does NOT require a fresh session (read)", async () => {
    await GET(makeRequest(), params("team-claude"));
    // Read posture is EXPLICIT { requireFresh: false }, not argument omission.
    expect(mockAuth.mock.calls[0][1]).toEqual({ requireFresh: false });
  });

  it("returns the summary, never ciphertext", async () => {
    const res = await GET(makeRequest(), params("team-claude"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect("ciphertext" in json).toBe(false);
    expect(json.name).toBe("team-claude");
  });

  it("uses the SESSION installationId, not anything from the path", async () => {
    await GET(makeRequest(), params("team-claude"));
    expect(mockGetSummary).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345", name: "team-claude" }),
    );
  });

  it("IDOR: a foreign name → 404 (store throws NotFound)", async () => {
    mockGetSummary.mockRejectedValue(
      new ModelCredentialNotFoundError("12345", "someone-elses"),
    );
    const res = await GET(makeRequest(), params("someone-elses"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------

describe("POST /api/model-credentials/[name]/rotate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedSession();
    mockGet.mockResolvedValue(FULL_ENVELOPE);
    mockValidate.mockResolvedValue({ valid: true });
    mockRotate.mockResolvedValue({ ...SUMMARY, rotatedAt: "2026-05-30T01:00:00.000Z" });
  });

  it("requires a FRESH session (requireFresh:true)", async () => {
    await ROTATE(makeRequest({ value: "sk-ant-new" }), params("team-claude"));
    expect(mockAuth).toHaveBeenCalledWith(expect.anything(), {
      requireFresh: true,
    });
  });

  it("live-validates the new api_key value before rotating", async () => {
    await ROTATE(makeRequest({ value: "sk-ant-new" }), params("team-claude"));
    expect(mockValidate).toHaveBeenCalledWith("anthropic", "sk-ant-new");
    expect(mockRotate).toHaveBeenCalledTimes(1);
  });

  it("rejects when the provider rejects the new key (no rotate)", async () => {
    mockValidate.mockResolvedValue({ valid: false, reason: "Invalid API key" });
    const res = await ROTATE(
      makeRequest({ value: "sk-bad" }),
      params("team-claude"),
    );
    expect(res.status).toBe(400);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it("returns the rotated summary, never ciphertext", async () => {
    const res = await ROTATE(
      makeRequest({ value: "sk-ant-new" }),
      params("team-claude"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect("ciphertext" in json).toBe(false);
    expect(json.rotatedAt).not.toBeNull();
  });

  it("does NOT live-validate an oauth_subscription rotation", async () => {
    mockGet.mockResolvedValue({
      ...FULL_ENVELOPE,
      kind: "oauth_subscription",
    });
    await ROTATE(
      makeRequest({ value: "sk-ant-oat01-new" }),
      params("team-claude"),
    );
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockRotate).toHaveBeenCalledTimes(1);
  });

  it("400s on missing value", async () => {
    const res = await ROTATE(makeRequest({}), params("team-claude"));
    expect(res.status).toBe(400);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it("IDOR: foreign name → 404 (getModelCredential throws NotFound)", async () => {
    mockGet.mockRejectedValue(
      new ModelCredentialNotFoundError("12345", "someone-elses"),
    );
    const res = await ROTATE(
      makeRequest({ value: "sk-ant-new" }),
      params("someone-elses"),
    );
    expect(res.status).toBe(404);
    expect(mockRotate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("POST /api/model-credentials/[name]/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedSession();
    mockRevoke.mockResolvedValue({ ...SUMMARY, status: "revoked" });
  });

  it("requires a FRESH session (requireFresh:true)", async () => {
    await REVOKE(makeRequest(), params("team-claude"));
    expect(mockAuth).toHaveBeenCalledWith(expect.anything(), {
      requireFresh: true,
    });
  });

  it("returns the revoked summary, never ciphertext", async () => {
    const res = await REVOKE(makeRequest(), params("team-claude"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("revoked");
    expect("ciphertext" in json).toBe(false);
  });

  it("uses the SESSION installationId", async () => {
    await REVOKE(makeRequest(), params("team-claude"));
    expect(mockRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345", name: "team-claude" }),
    );
  });

  it("IDOR: foreign name → 404", async () => {
    mockRevoke.mockRejectedValue(
      new ModelCredentialNotFoundError("12345", "someone-elses"),
    );
    const res = await REVOKE(makeRequest(), params("someone-elses"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// re-encrypt
// ---------------------------------------------------------------------------

describe("POST /api/model-credentials/[name]/re-encrypt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedSession();
    mockReEncrypt.mockResolvedValue({ action: "re_encrypted" });
  });

  it("requires a FRESH session (requireFresh:true)", async () => {
    await REENCRYPT(makeRequest(), params("team-claude"));
    expect(mockAuth).toHaveBeenCalledWith(expect.anything(), {
      requireFresh: true,
    });
  });

  it("returns the action result (no secret)", async () => {
    const res = await REENCRYPT(makeRequest(), params("team-claude"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.action).toBe("re_encrypted");
    expect("ciphertext" in json).toBe(false);
    expect("value" in json).toBe(false);
  });

  it("passes the active key version + session installationId", async () => {
    await REENCRYPT(makeRequest(), params("team-claude"));
    expect(mockReEncrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "12345",
        name: "team-claude",
        activeKeyVersion: "v1",
      }),
    );
  });

  it("IDOR: foreign name → 404", async () => {
    mockReEncrypt.mockRejectedValue(
      new ModelCredentialNotFoundError("12345", "someone-elses"),
    );
    const res = await REENCRYPT(makeRequest(), params("someone-elses"));
    expect(res.status).toBe(404);
  });

  it("short-circuits on auth failure", async () => {
    mockAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: "session_stale" }, { status: 401 }),
    } as never);
    const res = await REENCRYPT(makeRequest(), params("team-claude"));
    expect(res.status).toBe(401);
    expect(mockReEncrypt).not.toHaveBeenCalled();
  });
});
