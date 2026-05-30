/**
 * Route tests for the per-agent fleet surface. The load-bearing properties here
 * are MULTITENANT: a name belonging to another installation must resolve to 404
 * in the caller's namespace (no cross-tenant read/mutate, no existence oracle),
 * installationId must come only from the session, and DELETE must revoke the
 * token BEFORE deleting the record (fail-closed — never orphan a live bearer).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, getAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn() };
});

vi.mock("@/server/agent-token-v1", async () => {
  const real = await vi.importActual<typeof import("@/server/agent-token-v1")>("@/server/agent-token-v1");
  return { ...real, revokeAgentToken: vi.fn(), setAgentTokenCapabilities: vi.fn() };
});

vi.mock("@/server/agent-health-store", () => ({ getHistory: vi.fn() }));

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { getAgent, updateAgent, deleteAgent, AgentNotFoundError, type FleetAgent } from "@/server/fleet-store";
import { revokeAgentToken } from "@/server/agent-token-v1";
import { getHistory } from "@/server/agent-health-store";
import { GET, PATCH, DELETE } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedGetAgent = vi.mocked(getAgent);
const mockedUpdateAgent = vi.mocked(updateAgent);
const mockedDeleteAgent = vi.mocked(deleteAgent);
const mockedRevoke = vi.mocked(revokeAgentToken);
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
    repo: "owner/repo",
    engine: "claude",
    duty: "standing",
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
    agent_token_name: "victim",
    created_at: "2026-05-29T00:00:00.000Z",
    created_by: "owner",
    updated_at: "2026-05-29T00:00:00.000Z",
    config_version: 1,
  };
}

function req(method: string): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/agents/victim", {
    method,
    headers: { cookie: "session=mock", "content-type": "application/json" },
    ...(method === "PATCH" ? { body: JSON.stringify({ skills: [] }) } : {}),
  });
}
const params = { params: Promise.resolve({ name: "victim" }) };

beforeEach(() => {
  vi.clearAllMocks();
  // Store only knows "victim" under OWNER. A caller scoped to any other
  // installation gets a miss / not-found — the namespace isolation.
  mockedGetAgent.mockImplementation(async ({ installationId }) =>
    installationId === OWNER ? victimAgent() : null,
  );
  mockedUpdateAgent.mockImplementation(async ({ installationId, name }) => {
    if (installationId !== OWNER) throw new AgentNotFoundError(installationId, name);
    return victimAgent();
  });
  mockedDeleteAgent.mockResolvedValue(true);
  mockedRevoke.mockResolvedValue(true);
  mockedGetHistory.mockResolvedValue([]);
});

describe("cross-tenant isolation (IDOR)", () => {
  it("GET another tenant's agent → 404, scoped to the session installationId", async () => {
    authForInstallation(ATTACKER);
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(404);
    // Resolved ONLY under the attacker's namespace — never the owner's.
    expect(mockedGetAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: ATTACKER, name: "victim" }));
    expect(mockedGetAgent).not.toHaveBeenCalledWith(expect.objectContaining({ installationId: OWNER }));
  });

  it("PATCH another tenant's agent → 404, scoped to the session installationId", async () => {
    authForInstallation(ATTACKER);
    const res = await PATCH(req("PATCH"), params);
    expect(res.status).toBe(404);
    expect(mockedUpdateAgent).toHaveBeenCalledWith(expect.objectContaining({ installationId: ATTACKER }));
  });

  it("DELETE another tenant's agent → 404, and NEITHER revoke NOR delete is called", async () => {
    authForInstallation(ATTACKER);
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(404);
    expect(mockedRevoke).not.toHaveBeenCalled();
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

describe("DELETE fail-closed ordering", () => {
  it("revokes the token BEFORE deleting the record", async () => {
    authForInstallation(OWNER);
    const order: string[] = [];
    mockedRevoke.mockImplementation(async () => {
      order.push("revoke");
      return true;
    });
    mockedDeleteAgent.mockImplementation(async () => {
      order.push("delete");
      return true;
    });
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(order).toEqual(["revoke", "delete"]);
    expect(mockedRevoke).toHaveBeenCalledWith(expect.objectContaining({ installationId: OWNER, name: "victim" }));
  });

  it("if token revoke throws, the record is NOT deleted (no orphaned bearer)", async () => {
    authForInstallation(OWNER);
    mockedRevoke.mockRejectedValue(new Error("revoke failed"));
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(500);
    expect(mockedDeleteAgent).not.toHaveBeenCalled();
  });
});
