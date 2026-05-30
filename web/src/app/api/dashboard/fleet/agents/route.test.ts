/**
 * Route tests for the fleet list + create surface (v2: link an EXISTING token).
 * The create flow no longer mints a token — it validates the selected token
 * exists and is repo-scoped (via resolveTokenRepos) and snapshots its repos.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));
vi.mock("@/server/agent-health-store", () => ({ getOverview: vi.fn() }));

vi.mock("@/server/fleet-routes", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-routes")>("@/server/fleet-routes");
  return { ...real, checkFleetCreateRateLimit: vi.fn(), resolveTokenRepos: vi.fn() };
});

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, createAgent: vi.fn(), countAgents: vi.fn(), listAgents: vi.fn() };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { getOverview } from "@/server/agent-health-store";
import { checkFleetCreateRateLimit, resolveTokenRepos } from "@/server/fleet-routes";
import { createAgent, countAgents, listAgents, type FleetAgent } from "@/server/fleet-store";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedGetOverview = vi.mocked(getOverview);
const mockedRateLimit = vi.mocked(checkFleetCreateRateLimit);
const mockedResolveRepos = vi.mocked(resolveTokenRepos);
const mockedCreate = vi.mocked(createAgent);
const mockedCount = vi.mocked(countAgents);
const mockedList = vi.mocked(listAgents);

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
    agent_token_name: "builder-token",
  };
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/agents", {
    method: "POST",
    headers: { cookie: "session=mock", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function record(): FleetAgent {
  return {
    name: "builder",
    repos: ["owner/repo"],
    engine: "claude",
    skills: [],
    system_prompt: "",
    triggers: validBody().triggers,
    enabled: true,
    managed: true,
    agent_token_name: "builder-token",
    created_at: "t",
    created_by: "op",
    updated_at: "t",
    config_version: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authOk();
  mockedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockedCount.mockResolvedValue(0);
  mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["owner/repo"] });
});

describe("POST create — link an existing token", () => {
  it("happy path → 201 with the agent; repos came from the token's policy", async () => {
    mockedCreate.mockResolvedValue(record());
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.name).toBe("builder");
    expect(body.agent.repos).toEqual(["owner/repo"]);
    expect(body.token).toBeUndefined(); // nothing is minted anymore
    // createAgent received the token's repos.
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({ agentTokenName: "builder-token", repos: ["owner/repo"] }),
    );
  });

  it("unknown/invalid token → 400 from resolveTokenRepos, createAgent NOT called", async () => {
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_invalid_token" }), { status: 400 }) as never,
    });
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("token not scoped to a repo → 400, createAgent NOT called", async () => {
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_token_not_scoped" }), { status: 400 }) as never,
    });
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("queen trigger is rejected from the dashboard (before token resolution)", async () => {
    const body = validBody() as Record<string, unknown>;
    (body.triggers as Record<string, unknown>).queen = { enabled: true, settings: {} };
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_queen_not_supported");
    expect(mockedResolveRepos).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("rate limited → 429", async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(429);
  });

  it("agent cap reached → 409", async () => {
    mockedCount.mockResolvedValue(20);
    const res = await POST(postReq(validBody()));
    expect(res.status).toBe(409);
    expect(mockedCreate).not.toHaveBeenCalled();
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
