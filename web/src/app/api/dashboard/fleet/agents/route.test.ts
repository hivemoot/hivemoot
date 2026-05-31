/**
 * Route tests for the fleet list + create surface (plugin model). The create
 * flow validates the linked token EXISTS (capabilities only), and whenever a
 * github plugin block is PRESENT (enabled or not) resolves its repos against the
 * installation (fail-closed), writing the resolved list back into
 * plugins.github.repos. Nothing is minted. installationId always comes from the
 * session, and mutations require a FRESH session.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));
vi.mock("@/server/agent-health-store", () => ({ getOverview: vi.fn() }));

vi.mock("@/server/fleet-routes", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-routes")>("@/server/fleet-routes");
  return { ...real, checkFleetCreateRateLimit: vi.fn(), validateLinkedToken: vi.fn(), resolveGithubRepos: vi.fn() };
});

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, createAgent: vi.fn(), countAgents: vi.fn(), listAgents: vi.fn() };
});

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { getOverview } from "@/server/agent-health-store";
import { checkFleetCreateRateLimit, validateLinkedToken, resolveGithubRepos } from "@/server/fleet-routes";
import { createAgent, countAgents, listAgents, type FleetAgent } from "@/server/fleet-store";
import { GET, POST } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedGetOverview = vi.mocked(getOverview);
const mockedRateLimit = vi.mocked(checkFleetCreateRateLimit);
const mockedValidateToken = vi.mocked(validateLinkedToken);
const mockedResolveRepos = vi.mocked(resolveGithubRepos);
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

/** A schedule-only body — no github plugin, so resolveGithubRepos is never hit. */
function scheduleBody(over: Record<string, unknown> = {}) {
  return {
    name: "builder",
    engine: "claude",
    skills: [],
    system_prompt: "",
    plugins: {
      schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "Make progress." },
    },
    agent_token_name: "builder-token",
    ...over,
  };
}

/** A github-ENABLED body with an explicit repo list. */
function githubBody(repos: string[]) {
  return {
    name: "builder",
    engine: "claude",
    skills: [],
    system_prompt: "",
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
    agent_token_name: "builder-token",
  };
}

/** A github-DISABLED body (plus an enabled schedule so the ≥1-enabled rule
 * passes). The github block is still present, so the route MUST coverage-check
 * any repos it carries. */
function disabledGithubBody(repos: string[]) {
  return {
    name: "builder",
    engine: "claude",
    skills: [],
    system_prompt: "",
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

function record(plugins: FleetAgent["plugins"]): FleetAgent {
  return {
    name: "builder",
    engine: "claude",
    skills: [],
    system_prompt: "",
    plugins,
    enabled: true,
    managed: true,
    agent_token_name: "builder-token",
    created_at: "t",
    created_by: "op",
    updated_at: "t",
    config_version: 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authOk();
  mockedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockedCount.mockResolvedValue(0);
  mockedValidateToken.mockResolvedValue({ ok: true });
  mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["owner/repo"] });
});

describe("POST create — link an existing token (plugin model)", () => {
  it("requires a FRESH session (requireFresh: true)", async () => {
    mockedCreate.mockResolvedValue(record({ schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" } }));
    await POST(postReq(scheduleBody()));
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requireFresh: true });
  });

  it("schedule-only agent → 201; never resolves github repos", async () => {
    mockedCreate.mockResolvedValue(record({ schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "Make progress." } }));
    const res = await POST(postReq(scheduleBody()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.name).toBe("builder");
    expect(body.token).toBeUndefined(); // nothing is minted
    expect(mockedValidateToken).toHaveBeenCalledWith(INSTALL, "builder-token", expect.anything());
    expect(mockedResolveRepos).not.toHaveBeenCalled();
  });

  it("github-enabled with a repo subset passes the requested repos through (defaultAllWhenEmpty:true) and persists the resolved list", async () => {
    mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["owner/a", "owner/b"] });
    mockedCreate.mockImplementation(async (args) => record(args.input.plugins));
    const res = await POST(postReq(githubBody(["owner/a", "owner/b"])));
    expect(res.status).toBe(201);
    expect(mockedResolveRepos).toHaveBeenCalledWith(INSTALL, ["owner/a", "owner/b"], { defaultAllWhenEmpty: true });
    // The resolved (canonical) repos are what gets persisted.
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          plugins: expect.objectContaining({ github: expect.objectContaining({ repos: ["owner/a", "owner/b"] }) }),
        }),
      }),
    );
  });

  it("github-enabled with EMPTY repos defaults to ALL installed THROUGH the route (default-all path)", async () => {
    // The resolver (mocked) models the default-all expansion; the route must pass
    // the empty list + defaultAllWhenEmpty:true and persist whatever it returns.
    mockedResolveRepos.mockResolvedValue({ ok: true, repos: ["owner/a", "owner/b", "owner/c"] });
    mockedCreate.mockImplementation(async (args) => record(args.input.plugins));
    const res = await POST(postReq(githubBody([])));
    expect(res.status).toBe(201);
    expect(mockedResolveRepos).toHaveBeenCalledWith(INSTALL, [], { defaultAllWhenEmpty: true });
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          plugins: expect.objectContaining({ github: expect.objectContaining({ repos: ["owner/a", "owner/b", "owner/c"] }) }),
        }),
      }),
    );
  });

  it("github-ENABLED with an UNCOVERED repo → REPO_NOT_COVERED; createAgent NOT called", async () => {
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_repo_not_covered" }), { status: 400 }) as never,
    });
    const res = await POST(postReq(githubBody(["owner/uncovered"])));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    expect(mockedResolveRepos).toHaveBeenCalledWith(INSTALL, ["owner/uncovered"], { defaultAllWhenEmpty: true });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("github-DISABLED but carrying an UNCOVERED repo → STILL coverage-checked → REPO_NOT_COVERED (proves coverage runs regardless of enabled)", async () => {
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_repo_not_covered" }), { status: 400 }) as never,
    });
    const res = await POST(postReq(disabledGithubBody(["owner/uncovered"])));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    // Called with defaultAllWhenEmpty:false because the block is disabled.
    expect(mockedResolveRepos).toHaveBeenCalledWith(INSTALL, ["owner/uncovered"], { defaultAllWhenEmpty: false });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("github-enabled + EMPTY installation → REPO_NOT_COVERED at the route; createAgent NOT called", async () => {
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_repo_not_covered" }), { status: 400 }) as never,
    });
    const res = await POST(postReq(githubBody([])));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_repo_not_covered");
    expect(mockedResolveRepos).toHaveBeenCalledWith(INSTALL, [], { defaultAllWhenEmpty: true });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("unknown/invalid token → 400 from validateLinkedToken; createAgent NOT called", async () => {
    mockedValidateToken.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_invalid_token" }), { status: 400 }) as never,
    });
    const res = await POST(postReq(scheduleBody()));
    expect(res.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("repo resolution fails (lister unavailable) → its 503 response; createAgent NOT called", async () => {
    mockedResolveRepos.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ code: "fleet_repos_unavailable" }), { status: 503 }) as never,
    });
    const res = await POST(postReq(githubBody(["owner/a"])));
    expect(res.status).toBe(503);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("queen plugin is rejected from the dashboard (before token/repo resolution)", async () => {
    const body = scheduleBody() as Record<string, unknown>;
    (body.plugins as Record<string, unknown>).queen = { enabled: true };
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_queen_not_supported");
    expect(mockedValidateToken).not.toHaveBeenCalled();
    expect(mockedResolveRepos).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("an agent with no enabled plugin → 400 validation; nothing resolved or created", async () => {
    const res = await POST(postReq(scheduleBody({ plugins: { tasks: { enabled: false } } })));
    expect(res.status).toBe(400);
    expect(await res.json().then((b) => b.code)).toBe("fleet_validation");
    expect(mockedValidateToken).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("rate limited → 429", async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const res = await POST(postReq(scheduleBody()));
    expect(res.status).toBe(429);
  });

  it("agent cap reached → 409", async () => {
    mockedCount.mockResolvedValue(20);
    const res = await POST(postReq(scheduleBody()));
    expect(res.status).toBe(409);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe("GET list", () => {
  it("uses a NON-fresh session (requireFresh: false) and scopes to the session installationId", async () => {
    mockedList.mockResolvedValue([
      record({ schedule: { enabled: true, interval_secs: 21600, jitter_secs: 600, prompt: "go" } }),
    ]);
    mockedGetOverview.mockResolvedValue([
      { agent_id: "builder", status: "ok", received_at: "t" } as never,
      { agent_id: "ghost", status: "late", received_at: "t2" } as never,
    ]);
    const res = await GET(new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/agents", { headers: { cookie: "x" } }));
    expect(res.status).toBe(200);
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requireFresh: false });
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    // Observed is per-agent now — surfaces last-seen, not a repo.
    expect(body.observed).toEqual([
      { agent_id: "ghost", status: "late", received_at: "t2" },
    ]);
    expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ installationId: INSTALL }));
  });
});
