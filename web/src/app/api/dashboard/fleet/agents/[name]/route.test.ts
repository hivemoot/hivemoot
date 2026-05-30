/**
 * Route tests for the per-agent fleet surface (plugin model). Load-bearing
 * properties: MULTITENANT (a foreign name 404s in the caller's namespace;
 * installationId only from the session; token/repo resolution is scoped to the
 * ATTACKER's own namespace, never the owner's), mutations require a FRESH session,
 * DELETE deletes the record but does NOT revoke the linked token, and a PATCH
 * carrying a github plugin block (enabled OR disabled) re-resolves its repos
 * against the installation via resolveGithubRepos.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));
vi.mock("@/server/agent-health-store", () => ({ getHistory: vi.fn() }));

vi.mock("@/server/fleet-routes", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-routes")>("@/server/fleet-routes");
  return { ...real, validateLinkedToken: vi.fn(), resolveGithubRepos: vi.fn() };
});

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn() };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { validateLinkedToken, resolveGithubRepos } from "@/server/fleet-routes";
import { getAgent, updateAgent, deleteAgent, AgentNotFoundError, type FleetAgent } from "@/server/fleet-store";
import { getHistory } from "@/server/agent-health-store";
import { GET, PATCH, DELETE } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedValidateToken = vi.mocked(validateLinkedToken);
const mockedResolveRepos = vi.mocked(resolveGithubRepos);
const mockedGetAgent = vi.mocked(getAgent);
const mockedUpdateAgent = vi.mocked(updateAgent);
const mockedDeleteAgent = vi.mocked(deleteAgent);
const mockedGetHistory = vi.mocked(getHistory);

const ATTACKER = "attacker-install";
const OWNER = "owner-install";

function authForInstallation(installationId: string) {
  mockedAuth.mockResolvedValue({
    ok: true as const,
    session: { userLogin: "op", installationId } as never,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  });
  mockedRequireInstallation.mockReturnValue({ ok: true as const, installationId });
}

function victimAgent(): FleetAgent {
  return {
    name: "victim",
    engine: "claude",
    skills: [],
    system_prompt: "",
    plugins: {
      github: {
        enabled: true,
        repos: ["owner/repo"],
        watch_new_prs: true,
        watch_review_requests: false,
        watch_mentions: false,
        poll_interval_secs: 90,
      },
    },
    enabled: true,
    managed: true,
    agent_token_name: "victim-token",
    created_at: "2026-05-29T00:00:00.000Z",
    created_by: "owner",
    updated_at: "2026-05-29T00:00:00.000Z",
    config_version: 2,
  };
}

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/agents/victim", {
    method,
    headers: { cookie: "session=mock", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = { params: Promise.resolve({ name: "victim" }) };

function githubPatch(repos: string[]) {
  return {
    plugins: {
      github: {
        enabled: true,
        repos,
        watch_new_prs: true,
        watch_review_requests: false,
        watch_mentions: false,
        poll_interval_secs: 90,
      },
    },
  };
}

/** A PATCH carrying a DISABLED github block (plus an enabled schedule so the
 * ≥1-enabled rule passes). The block is still present, so the route must
 * coverage-check its repos with defaultAllWhenEmpty:false. */
function disabledGithubPatch(repos: string[]) {
  return {
    plugins: {
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" },
      github: {
        enabled: false,
        repos,
        watch_new_prs: false,
        watch_review_requests: false,
        watch_mentions: false,
        poll_interval_secs: 90,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAgent.mockImplementation(async ({ installationId }) =>
    installationId === OWNER ? victimAgent() : null,
  );
  mockedUpdateAgent.mockImplementation(async ({ installationId, name }) => {
    if (installationId !== OWNER) throw new AgentNotFoundError(installationId, name);
    return victimAgent();
  });
  mockedDeleteAgent.mockResolvedValue(true);
  mockedGetHistory.mockResolvedValue([]);
  mockedValidateToken.mockResolvedValue({ ok: true });
  mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["new/repo"] });
});

describe("session freshness (requireFresh)", () => {
  it("GET uses a NON-fresh session (requireFresh: false)", async () => {
    authForInstallation(OWNER);
    await GET(req("GET"), params);
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requireFresh: false });
  });

  it("PATCH requires a FRESH session (requireFresh: true)", async () => {
    authForInstallation(OWNER);
    await PATCH(req("PATCH", { skills: [] }), params);
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requireFresh: true });
  });

  it("DELETE requires a FRESH session (requireFresh: true)", async () => {
    authForInstallation(OWNER);
    await DELETE(req("DELETE"), params);
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requireFresh: true });
  });
});

describe("cross-tenant isolation (IDOR)", () => {
  it("GET another tenant's agent → 404, scoped to the session installationId", async () => {
    authForInstallation(ATTACKER);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(404);
    expect(mockedGetAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: ATTACKER, name: "victim" }));
    expect(mockedGetAgent).not.toHaveBeenCalledWith(expect.objectContaining({ installationId: OWNER }));
  });

  it("PATCH another tenant's agent → 404", async () => {
    authForInstallation(ATTACKER);
    const res = await PATCH(req("PATCH", { skills: [] }), params);
    expect(res.status).toBe(404);
    expect(mockedUpdateAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: ATTACKER }));
  });

  it("PATCH re-linking a token as another tenant → 404; token validation scoped to the attacker, never the owner", async () => {
    authForInstallation(ATTACKER);
    const res = await PATCH(req("PATCH", { agent_token_name: "attacker-token" }), params);
    expect(res.status).toBe(404);
    expect(mockedValidateToken).toHaveBeenCalledWith(ATTACKER, "attacker-token", expect.anything());
    expect(mockedValidateToken).not.toHaveBeenCalledWith(OWNER, expect.anything(), expect.anything());
    expect(mockedUpdateAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: ATTACKER }));
  });

  it("PATCH (re)configuring github as another tenant → 404; repo resolution scoped to the attacker, never the owner", async () => {
    authForInstallation(ATTACKER);
    const res = await PATCH(req("PATCH", githubPatch(["owner/repo"])), params);
    expect(res.status).toBe(404);
    expect(mockedResolveRepos).toHaveBeenCalledWith(ATTACKER, ["owner/repo"], { defaultAllWhenEmpty: true });
    expect(mockedResolveRepos).not.toHaveBeenCalledWith(OWNER, expect.anything(), expect.anything());
    expect(mockedUpdateAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: ATTACKER }));
  });

  it("DELETE another tenant's agent → 404, deleteAgent NOT called", async () => {
    authForInstallation(ATTACKER);
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(404);
    expect(mockedDeleteAgent).not.toHaveBeenCalled();
  });

  it("GET the caller's own agent → 200 with config + runs", async () => {
    authForInstallation(OWNER);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.name).toBe("victim");
    expect(body.runs).toEqual([]);
  });
});

describe("DELETE — record only, token untouched", () => {
  it("deletes the record and never revokes the linked token", async () => {
    authForInstallation(OWNER);
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(mockedDeleteAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: OWNER, name: "victim" }));
  });
});

describe("PATCH — token existence + github repo resolution", () => {
  it("re-linking a token only re-validates existence (no repo derivation from the token)", async () => {
    authForInstallation(OWNER);
    const res = await PATCH(req("PATCH", { agent_token_name: "new-token" }), params);
    expect(res.status).toBe(200);
    expect(mockedValidateToken).toHaveBeenCalledWith(OWNER, "new-token", expect.anything());
    // No github plugin in the patch → no repo resolution.
    expect(mockedResolveRepos).not.toHaveBeenCalled();
  });

  it("a config-only patch (no token, no github) validates no token and resolves no repos", async () => {
    authForInstallation(OWNER);
    const res = await PATCH(req("PATCH", { skills: [] }), params);
    expect(res.status).toBe(200);
    expect(mockedValidateToken).not.toHaveBeenCalled();
    expect(mockedResolveRepos).not.toHaveBeenCalled();
  });

  it("a github-enabled patch resolves repos (defaultAllWhenEmpty:true) and persists the resolved list", async () => {
    authForInstallation(OWNER);
    mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["owner/x", "owner/y"] });
    const res = await PATCH(req("PATCH", githubPatch(["owner/x"])), params);
    expect(res.status).toBe(200);
    expect(mockedResolveRepos).toHaveBeenCalledWith(OWNER, ["owner/x"], { defaultAllWhenEmpty: true });
    expect(mockedUpdateAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({
          plugins: expect.objectContaining({ github: expect.objectContaining({ repos: ["owner/x", "owner/y"] }) }),
        }),
      }),
    );
  });

  it("a github-DISABLED patch carrying an UNCOVERED repo → STILL coverage-checked → REPO_NOT_COVERED; updateAgent NOT called", async () => {
    authForInstallation(OWNER);
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_repo_not_covered" }), { status: 400 }) as never,
    });
    const res = await PATCH(req("PATCH", disabledGithubPatch(["owner/uncovered"])), params);
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    // defaultAllWhenEmpty:false because the patched github block is disabled.
    expect(mockedResolveRepos).toHaveBeenCalledWith(OWNER, ["owner/uncovered"], { defaultAllWhenEmpty: false });
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });

  it("a github-enabled patch whose repo resolution fails → that response; updateAgent NOT called", async () => {
    authForInstallation(OWNER);
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_repo_not_covered" }), { status: 400 }) as never,
    });
    const res = await PATCH(req("PATCH", githubPatch(["owner/uncovered"])), params);
    expect(res.status).toBe(400);
    expect(mockedUpdateAgent).not.toHaveBeenCalled();
  });
});
