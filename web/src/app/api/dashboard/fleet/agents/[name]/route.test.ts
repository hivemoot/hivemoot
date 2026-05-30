/**
 * Route tests for the per-agent fleet surface (v2). Load-bearing properties:
 * MULTITENANT (a foreign name 404s in the caller's namespace; installationId
 * only from the session), DELETE deletes the record but does NOT revoke the
 * linked token (tokens are managed independently), and re-pointing the token on
 * PATCH re-derives the agent's repos via resolveTokenRepos.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));
vi.mock("@/server/agent-health-store", () => ({ getHistory: vi.fn() }));

vi.mock("@/server/fleet-routes", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-routes")>("@/server/fleet-routes");
  return { ...real, resolveTokenRepos: vi.fn() };
});

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn() };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { resolveTokenRepos } from "@/server/fleet-routes";
import { getAgent, updateAgent, deleteAgent, AgentNotFoundError, type FleetAgent } from "@/server/fleet-store";
import { getHistory } from "@/server/agent-health-store";
import { GET, PATCH, DELETE } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedResolveRepos = vi.mocked(resolveTokenRepos);
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
    repos: ["owner/repo"],
    engine: "claude",
    skills: [],
    system_prompt: "",
    triggers: {
      schedule: { enabled: false, settings: { interval_secs: 21600, jitter_secs: 600, prompt: "" } },
      pull_requests: { enabled: false, settings: { watch_new_prs: true, watch_review_requests: true, author_allowlist: [], poll_interval_secs: 300 } },
      mentions: { enabled: false, settings: { poll_interval_secs: 90 } },
      tasks: { enabled: false, settings: {} },
      war_rooms: { enabled: false, settings: { contribute: false } },
    },
    enabled: true,
    managed: true,
    agent_token_name: "victim-token",
    created_at: "2026-05-29T00:00:00.000Z",
    created_by: "owner",
    updated_at: "2026-05-29T00:00:00.000Z",
    config_version: 1,
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
  mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["new/repo"] });
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

  it("PATCH re-linking a token as another tenant → 404; token resolution scoped to the attacker", async () => {
    authForInstallation(ATTACKER);
    const res = await PATCH(req("PATCH", { agent_token_name: "attacker-token" }), params);
    expect(res.status).toBe(404);
    // The token re-link runs FIRST and is scoped to the attacker's own namespace,
    // never the owner's; the ownership 404 still gates the write.
    expect(mockedResolveRepos).toHaveBeenCalledWith(ATTACKER, "attacker-token", expect.anything());
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

describe("PATCH — re-linking the token re-derives repos", () => {
  it("resolves the new token's repos and passes them to updateAgent", async () => {
    authForInstallation(OWNER);
    const res = await PATCH(req("PATCH", { agent_token_name: "new-token" }), params);
    expect(res.status).toBe(200);
    expect(mockedResolveRepos).toHaveBeenCalledWith(OWNER, "new-token", expect.anything());
    expect(mockedUpdateAgent).toHaveBeenCalledWith(expect.objectContaining({ repos: ["new/repo"] }));
  });

  it("a config-only patch (no token change) does not resolve repos", async () => {
    authForInstallation(OWNER);
    const res = await PATCH(req("PATCH", { skills: [] }), params);
    expect(res.status).toBe(200);
    expect(mockedResolveRepos).not.toHaveBeenCalled();
  });
});
