/**
 * Tests for the fleet route helpers (plugin model):
 *
 *  - `validateLinkedToken` — EXISTENCE only. The token is the agent's capability
 *    bearer, decoupled from repo scope; a missing token → INVALID_TOKEN. There is
 *    no repo-scoping / TOKEN_NOT_SCOPED concept anymore.
 *  - `resolveGithubRepos` — resolves the github plugin's repos against the
 *    installation's accessible repos. Fail-closed everywhere: lister throws →
 *    503 REPOS_UNAVAILABLE, empty install → REPO_NOT_COVERED, uncovered repo →
 *    REPO_NOT_COVERED, malformed repo → VALIDATION. Default (no requested) → all.
 *    Coverage match is case-insensitive and returns the installation's canonical
 *    casing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/agent-token-v1", async () => {
  const real = await vi.importActual<typeof import("@/server/agent-token-v1")>("@/server/agent-token-v1");
  return { ...real, getAgentTokenSummary: vi.fn() };
});

vi.mock("@/server/github-installation-repos", async () => {
  const real = await vi.importActual<typeof import("@/server/github-installation-repos")>(
    "@/server/github-installation-repos",
  );
  return { ...real, listInstallationRepos: vi.fn() };
});

import { getAgentTokenSummary, TokenNotFoundError } from "@/server/agent-token-v1";
import {
  listInstallationRepos,
  InstallationReposError,
} from "@/server/github-installation-repos";
import { validateLinkedToken, resolveGithubRepos } from "@/server/fleet-routes";

const mockedSummary = vi.mocked(getAgentTokenSummary);
const mockedList = vi.mocked(listInstallationRepos);

function summary() {
  return {
    name: "t",
    agent_role: "t",
    capabilities: ["agent_health.report"],
    fingerprint: "fp",
    createdAt: "t",
    createdBy: "x",
    expiresAt: null as string | null,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("validateLinkedToken (existence only)", () => {
  it("resolves ok when the token exists", async () => {
    mockedSummary.mockResolvedValue(summary() as never);
    const r = await validateLinkedToken("inst", "t", {} as never);
    expect(r.ok).toBe(true);
    expect(mockedSummary).toHaveBeenCalledWith(expect.objectContaining({ installationId: "inst", name: "t" }));
  });

  it("rejects an unknown token → 400 fleet_invalid_token", async () => {
    mockedSummary.mockRejectedValue(new TokenNotFoundError("inst", "t"));
    const r = await validateLinkedToken("inst", "t", {} as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json().then((b) => b.code)).toBe("fleet_invalid_token");
    }
  });

  it("accepts a token with no repo policy (repo scope is decoupled from the token now)", async () => {
    // A token without any allowed_repos used to be rejected (TOKEN_NOT_SCOPED).
    // In the plugin model the token carries capabilities only — existence passes.
    mockedSummary.mockResolvedValue(summary() as never);
    const r = await validateLinkedToken("inst", "t", {} as never);
    expect(r.ok).toBe(true);
  });

  it("propagates an unexpected (non-not-found) error", async () => {
    mockedSummary.mockRejectedValue(new Error("redis down"));
    await expect(validateLinkedToken("inst", "t", {} as never)).rejects.toThrow("redis down");
  });
});

describe("resolveGithubRepos", () => {
  const fetcher = (() => {}) as unknown as typeof fetch; // never called; lister is mocked
  // Most cases model the ENABLED plugin (defaultAllWhenEmpty: true).
  const enabledOpts = { defaultAllWhenEmpty: true, fetcher };
  const disabledOpts = { defaultAllWhenEmpty: false, fetcher };

  it("enabled + none requested → defaults to ALL installed repos", async () => {
    mockedList.mockResolvedValue(["owner/a", "owner/b"]);
    const r = await resolveGithubRepos("inst", undefined, enabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["owner/a", "owner/b"]);
  });

  it("enabled + empty list requested → defaults to ALL installed repos", async () => {
    mockedList.mockResolvedValue(["owner/a", "owner/b"]);
    const r = await resolveGithubRepos("inst", [], enabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["owner/a", "owner/b"]);
  });

  it("DISABLED + none requested → returns [] WITHOUT calling the lister", async () => {
    const r = await resolveGithubRepos("inst", [], disabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual([]);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("DISABLED + non-empty requested → STILL coverage-checks (uncovered → REPO_NOT_COVERED)", async () => {
    mockedList.mockResolvedValue(["owner/a"]);
    const r = await resolveGithubRepos("inst", ["owner/not-installed"], disabledOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    expect(mockedList).toHaveBeenCalled();
  });

  it("DISABLED + non-empty covered requested → returns the canonical covered subset", async () => {
    mockedList.mockResolvedValue(["Owner/Repo"]);
    const r = await resolveGithubRepos("inst", ["owner/repo"], disabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["Owner/Repo"]);
  });

  it("narrows to a covered subset (preserving the request order)", async () => {
    mockedList.mockResolvedValue(["owner/a", "owner/b", "owner/c"]);
    const r = await resolveGithubRepos("inst", ["owner/c", "owner/a"], enabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["owner/c", "owner/a"]);
  });

  it("matches coverage case-insensitively and returns the installation's canonical casing", async () => {
    mockedList.mockResolvedValue(["Owner/Repo"]);
    const r = await resolveGithubRepos("inst", ["owner/repo"], enabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["Owner/Repo"]);
  });

  it("dedupes a repeated requested repo", async () => {
    mockedList.mockResolvedValue(["owner/a"]);
    const r = await resolveGithubRepos("inst", ["owner/a", "owner/a"], enabledOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repos).toEqual(["owner/a"]);
  });

  it("an uncovered requested repo → 400 REPO_NOT_COVERED", async () => {
    mockedList.mockResolvedValue(["owner/a"]);
    const r = await resolveGithubRepos("inst", ["owner/not-installed"], enabledOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    }
  });

  it.each(["owner", "owner/../x", "owner name", "a/b/c", "../etc/passwd"])(
    "a malformed requested repo %s → 400 VALIDATION (before coverage)",
    async (bad) => {
      mockedList.mockResolvedValue(["owner/a"]);
      const r = await resolveGithubRepos("inst", [bad], enabledOpts);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(400);
        expect(await r.response.json().then((b) => b.code)).toBe("fleet_validation");
      }
    },
  );

  it("an empty installation roster → 400 REPO_NOT_COVERED", async () => {
    mockedList.mockResolvedValue([]);
    const r = await resolveGithubRepos("inst", ["owner/a"], enabledOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      expect(await r.response.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    }
  });

  it("enabled + empty installation roster → 400 REPO_NOT_COVERED even with no requested repos (fail-closed, never 'all=none')", async () => {
    mockedList.mockResolvedValue([]);
    const r = await resolveGithubRepos("inst", undefined, enabledOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(await r.response.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
  });

  it("lister throws InstallationReposError → 503 REPOS_UNAVAILABLE (fail-closed, no agent)", async () => {
    mockedList.mockRejectedValue(new InstallationReposError("boom"));
    const r = await resolveGithubRepos("inst", ["owner/a"], enabledOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      expect(await r.response.json().then((b) => b.code)).toBe("fleet_repos_unavailable");
    }
  });

  it("propagates an unexpected (non-InstallationReposError) lister error", async () => {
    mockedList.mockRejectedValue(new Error("unexpected"));
    await expect(resolveGithubRepos("inst", ["owner/a"], enabledOpts)).rejects.toThrow("unexpected");
  });
});
