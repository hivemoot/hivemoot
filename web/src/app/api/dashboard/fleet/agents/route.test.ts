/**
 * Route tests for the fleet list + create surface. The security-critical path is
 * the two-phase create: issue the V1 token FIRST, then persist the record; if
 * the record write fails the token MUST be revoked so no orphaned live bearer
 * remains for a non-existent agent. Also covers the short-circuit branches where
 * the token is never issued (so no rollback should fire) and repo-coverage
 * failing closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));
vi.mock("@/server/github-installation-repos", () => ({ assertRepoCoveredByInstallation: vi.fn() }));
vi.mock("@/server/agent-health-store", () => ({ getOverview: vi.fn() }));

vi.mock("@/server/fleet-routes", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-routes")>("@/server/fleet-routes");
  return { ...real, checkFleetCreateRateLimit: vi.fn() };
});

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, createAgent: vi.fn(), countAgents: vi.fn(), listAgents: vi.fn() };
});

vi.mock("@/server/agent-token-v1", async () => {
  const real = await vi.importActual<typeof import("@/server/agent-token-v1")>("@/server/agent-token-v1");
  return { ...real, issueAgentToken: vi.fn(), revokeAgentToken: vi.fn() };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { assertRepoCoveredByInstallation } from "@/server/github-installation-repos";
import { getOverview } from "@/server/agent-health-store";
import { checkFleetCreateRateLimit } from "@/server/fleet-routes";
import { createAgent, countAgents, listAgents, type FleetAgent } from "@/server/fleet-store";
import {
  issueAgentToken,
  revokeAgentToken,
  TokenNameTakenError,
  TokenLimitReachedError,
} from "@/server/agent-token-v1";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedCoverage = vi.mocked(assertRepoCoveredByInstallation);
const mockedGetOverview = vi.mocked(getOverview);
const mockedRateLimit = vi.mocked(checkFleetCreateRateLimit);
const mockedCreate = vi.mocked(createAgent);
const mockedCount = vi.mocked(countAgents);
const mockedList = vi.mocked(listAgents);
const mockedIssue = vi.mocked(issueAgentToken);
const mockedRevoke = vi.mocked(revokeAgentToken);

const INSTALL = "install-1";

function authOk() {
  mockedAuth.mockResolvedValue({
    ok: true as const,
    session: { userLogin: "op", userId: 7, installationId: INSTALL } as never,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  });
  mockedRequireInstallation.mockReturnValue({ ok: true as const, installationId: INSTALL });
}

function validBody() {
  return {
    name: "builder",
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
  };
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/agents", {
    method: "POST",
    headers: { cookie: "session=mock", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function issued() {
  return {
    token: "hmt_secretbearer",
    name: "builder",
    agent_role: "builder",
    capabilities: ["agent_health.report"],
    fingerprint: "fp123456",
    expiresAt: null as string | null,
  };
}

function record(): FleetAgent {
  return { ...(validBody() as unknown as FleetAgent), enabled: true, managed: true, agent_token_name: "builder", created_at: "t", created_by: "op", updated_at: "t", config_version: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  authOk();
  mockedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockedCount.mockResolvedValue(0);
  mockedCoverage.mockResolvedValue({ ok: true });
  mockedIssue.mockResolvedValue(issued());
  mockedRevoke.mockResolvedValue(true);
});

describe("POST create — token rollback invariant", () => {
  it("happy path → 201, returns the bearer once, no revoke", async () => {
    mockedCreate.mockResolvedValue(record());
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBe("hmt_secretbearer");
    expect(body.agent.name).toBe("builder");
    expect(mockedRevoke).not.toHaveBeenCalled();
  });

  it("createAgent fails → token is REVOKED and the create error (not 201) surfaces", async () => {
    mockedCreate.mockRejectedValue(new Error("redis exploded"));
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(500);
    expect(mockedRevoke).toHaveBeenCalledTimes(1);
    expect(mockedRevoke).toHaveBeenCalledWith(expect.objectContaining({ installationId: INSTALL, name: "builder" }));
  });

  it("createAgent fails AND revoke also fails → still surfaces the create error", async () => {
    mockedCreate.mockRejectedValue(new Error("redis exploded"));
    mockedRevoke.mockRejectedValue(new Error("revoke also failed"));
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(500);
    expect(mockedRevoke).toHaveBeenCalledTimes(1);
  });

  it("duplicate name (token issue throws TokenNameTakenError) → 409, no createAgent, no revoke", async () => {
    mockedIssue.mockRejectedValue(new TokenNameTakenError(INSTALL, "builder"));
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(409);
    expect(await res.json().then((b) => b.code)).toBe("fleet_name_taken");
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedRevoke).not.toHaveBeenCalled();
  });

  it("token cap reached (TokenLimitReachedError) → 409, no createAgent", async () => {
    mockedIssue.mockRejectedValue(new TokenLimitReachedError(INSTALL, 20));
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(409);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("repo not covered → 403 fail-closed, token never issued", async () => {
    mockedCoverage.mockResolvedValue({ ok: false, reason: "not_covered", message: "not installed" });
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(403);
    expect(mockedIssue).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("queen trigger is rejected from the dashboard", async () => {
    const body = validBody() as Record<string, unknown>;
    (body.triggers as Record<string, unknown>).queen = { enabled: true, settings: {} };
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_queen_not_supported");
    expect(mockedIssue).not.toHaveBeenCalled();
  });
});

describe("GET list", () => {
  it("returns registered + observed agents scoped to the session installationId", async () => {
    mockedList.mockResolvedValue([record()]);
    mockedGetOverview.mockResolvedValue([
      { agent_id: "builder", repo: "owner/repo", status: "ok", received_at: "t" } as never,
      { agent_id: "ghost", repo: "owner/repo", status: "late", received_at: "t" } as never,
    ]);
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/agents", { headers: { cookie: "x" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.observed.map((o: { agent_id: string }) => o.agent_id)).toEqual(["ghost"]);
    expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ installationId: INSTALL }));
  });
});
