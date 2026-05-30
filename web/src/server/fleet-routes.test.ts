/**
 * Tests for resolveTokenRepos — the v2 link-an-existing-token gate. It validates
 * the selected token exists, is repo-scoped, and that each scoped repo is
 * well-formed (defense in depth, since token policies are only typeof-checked at
 * issue time). Everything is fail-closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/agent-token-v1", async () => {
  const real = await vi.importActual<typeof import("@/server/agent-token-v1")>("@/server/agent-token-v1");
  return { ...real, getAgentTokenSummary: vi.fn() };
});

import { getAgentTokenSummary, TokenNotFoundError } from "@/server/agent-token-v1";
import { resolveTokenRepos } from "@/server/fleet-routes";

const mocked = vi.mocked(getAgentTokenSummary);

function summary(allowedRepos?: string[]) {
  return {
    name: "t",
    agent_role: "t",
    capabilities: ["agent_health.report"],
    fingerprint: "fp",
    createdAt: "t",
    createdBy: "x",
    expiresAt: null as string | null,
    ...(allowedRepos !== undefined ? { policy: { allowed_repos: allowedRepos } } : {}),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("resolveTokenRepos", () => {
  it("returns the token's allowed_repos when scoped + well-formed", async () => {
    mocked.mockResolvedValue(summary(["owner/repo", "owner/other"]) as never);
    const r = await resolveTokenRepos("inst", "t", {} as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["owner/repo", "owner/other"]);
  });

  it("rejects an unknown token → 400 fleet_invalid_token", async () => {
    mocked.mockRejectedValue(new TokenNotFoundError("inst", "t"));
    const r = await resolveTokenRepos("inst", "t", {} as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json().then((b) => b.code)).toBe("fleet_invalid_token");
    }
  });

  it("rejects a token with no repo scope → 400 fleet_token_not_scoped", async () => {
    mocked.mockResolvedValue(summary([]) as never);
    const r = await resolveTokenRepos("inst", "t", {} as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json().then((b) => b.code)).toBe("fleet_token_not_scoped");
  });

  it("rejects a legacy-permissive token (no policy) → 400 fleet_token_not_scoped", async () => {
    mocked.mockResolvedValue(summary(undefined) as never);
    const r = await resolveTokenRepos("inst", "t", {} as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json().then((b) => b.code)).toBe("fleet_token_not_scoped");
  });

  it.each(["owner/../../etc", "owner", "owner name", "a/b/c"])(
    "rejects a malformed repo %s in the token policy → 400 (fail-closed)",
    async (badRepo) => {
      mocked.mockResolvedValue(summary([badRepo]) as never);
      const r = await resolveTokenRepos("inst", "t", {} as never);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json().then((b) => b.code)).toBe("fleet_invalid_token");
      }
    },
  );
});
