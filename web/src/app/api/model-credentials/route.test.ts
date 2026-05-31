/**
 * Route tests for /api/model-credentials (POST create + GET list).
 *
 * Mocks the auth gate, installation guard, provider validation, and the
 * storage layer so we can assert the route's contract:
 *   - POST passes requireFresh:true; GET passes requireFresh:false
 *   - api_key create live-validates the value before storing
 *   - create returns the (ciphertext-free) summary; list returns summaries
 *   - installationId comes from the session, never the body
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
    createModelCredential: vi.fn(),
    listModelCredentials: vi.fn(),
  };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { validateProviderKey } from "@/server/provider-validation";
import {
  createModelCredential,
  listModelCredentials,
} from "@/server/model-credential-store";
import { POST, GET } from "./route";

const mockAuth = vi.mocked(authenticateByokRequest);
const mockRequireInstallation = vi.mocked(requireInstallation);
const mockValidate = vi.mocked(validateProviderKey);
const mockCreate = vi.mocked(createModelCredential);
const mockList = vi.mocked(listModelCredentials);

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

function makeRequest(body: unknown) {
  return {
    body: body === undefined ? null : {},
    json: async () => body,
    cookies: { get: () => undefined },
  } as never;
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

describe("POST /api/model-credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedSession();
    mockValidate.mockResolvedValue({ valid: true });
    mockCreate.mockResolvedValue(SUMMARY);
  });

  it("requires a FRESH session (requireFresh:true)", async () => {
    await POST(
      makeRequest({
        name: "team-claude",
        kind: "api_key",
        provider: "anthropic",
        value: "sk-ant-x",
        deliverable: true,
      }),
    );
    expect(mockAuth).toHaveBeenCalledWith(expect.anything(), {
      requireFresh: true,
    });
  });

  it("live-validates an api_key before storing", async () => {
    await POST(
      makeRequest({
        name: "team-claude",
        kind: "api_key",
        provider: "anthropic",
        value: "sk-ant-x",
        deliverable: true,
      }),
    );
    expect(mockValidate).toHaveBeenCalledWith("anthropic", "sk-ant-x");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects when the provider rejects the key (no store write)", async () => {
    mockValidate.mockResolvedValue({ valid: false, reason: "Invalid API key" });
    const res = await POST(
      makeRequest({
        name: "team-claude",
        kind: "api_key",
        provider: "anthropic",
        value: "sk-bad",
        deliverable: true,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns the summary (ciphertext-free) with 201", async () => {
    const res = await POST(
      makeRequest({
        name: "team-claude",
        kind: "api_key",
        provider: "anthropic",
        value: "sk-ant-x",
        deliverable: true,
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect("ciphertext" in json).toBe(false);
    expect(json.name).toBe("team-claude");
  });

  it("passes the SESSION installationId to the store (never the body)", async () => {
    await POST(
      makeRequest({
        name: "team-claude",
        kind: "api_key",
        provider: "anthropic",
        value: "sk-ant-x",
        deliverable: true,
        installationId: "ATTACKER-9999",
      }),
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345" }),
    );
  });

  it("rejects an invalid kind without touching the store", async () => {
    const res = await POST(
      makeRequest({
        name: "team-claude",
        kind: "password",
        provider: "anthropic",
        value: "x",
        deliverable: true,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an invalid provider without touching the store", async () => {
    const res = await POST(
      makeRequest({
        name: "team-claude",
        kind: "api_key",
        provider: "mistral",
        value: "x",
        deliverable: true,
      }),
    );
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does NOT live-validate a zai api_key (no probe endpoint), still stores", async () => {
    await POST(
      makeRequest({
        name: "team-zai",
        kind: "api_key",
        provider: "zai",
        value: "zai-key",
        deliverable: true,
      }),
    );
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT live-validate an oauth_subscription value", async () => {
    await POST(
      makeRequest({
        name: "team-claude-oauth",
        kind: "oauth_subscription",
        provider: "anthropic",
        value: "sk-ant-oat01-x",
        deliverable: true,
      }),
    );
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("short-circuits on auth failure", async () => {
    mockAuth.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { code: "not_authenticated" },
        { status: 401 },
      ),
    } as never);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("GET /api/model-credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedSession();
    mockList.mockResolvedValue([SUMMARY]);
  });

  it("does NOT require a fresh session (read)", async () => {
    await GET(makeRequest(undefined));
    expect(mockAuth).toHaveBeenCalledWith(expect.anything());
    expect(mockAuth.mock.calls[0][1]).toBeUndefined();
  });

  it("returns summaries, none containing ciphertext", async () => {
    const res = await GET(makeRequest(undefined));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      credentials: Record<string, unknown>[];
    };
    expect(json.credentials).toHaveLength(1);
    for (const c of json.credentials) {
      expect("ciphertext" in c).toBe(false);
    }
  });

  it("lists with the SESSION installationId", async () => {
    await GET(makeRequest(undefined));
    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "12345" }),
    );
  });
});
