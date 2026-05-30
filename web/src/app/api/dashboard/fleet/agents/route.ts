/**
 * Fleet agent registry — list + create (cookie-auth dashboard surface).
 *
 * GET  → registered agents (+ latest health) and observed-only (unregistered)
 *        agents for adoption.
 * POST → register an agent that LINKS an existing capability token. The flow
 *        never mints/mutates/revokes a token — it validates the selected token
 *        exists and is repo-scoped, and snapshots its `allowed_repos` as the
 *        agent's repos. installationId always comes from the session.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  FLEET_ERROR,
  fleetError,
  readJsonObject,
  mapFleetStorageError,
  checkFleetCreateRateLimit,
  resolveTokenRepos,
} from "@/server/fleet-routes";
import {
  createAgent,
  listAgents,
  countAgents,
  validateCreateAgentInput,
  MAX_AGENTS_PER_INSTALLATION,
} from "@/server/fleet-store";
import { getOverview, type HealthOverviewEntry } from "@/server/agent-health-store";

interface AgentHealthView {
  status: HealthOverviewEntry["status"];
  received_at: string;
  outcome?: HealthOverviewEntry["outcome"];
  next_run_at?: string;
  run_summary?: string;
}

function projectHealth(h: HealthOverviewEntry | undefined): AgentHealthView | null {
  if (!h) return null;
  return {
    status: h.status,
    received_at: h.received_at,
    ...(h.outcome !== undefined ? { outcome: h.outcome } : {}),
    ...(h.next_run_at !== undefined ? { next_run_at: h.next_run_at } : {}),
    ...(h.run_summary !== undefined ? { run_summary: h.run_summary } : {}),
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;
  const inst = requireInstallation(auth.session);
  if (!inst.ok) return inst.response;
  const installationId = inst.installationId;

  try {
    const [agents, overview] = await Promise.all([
      listAgents({ installationId, redis: auth.redis }),
      getOverview(installationId, auth.redis),
    ]);

    // An agent may operate on several repos and report health per repo — join by
    // agent_id and keep the most recent health entry.
    const latestByAgent = new Map<string, HealthOverviewEntry>();
    for (const h of overview) {
      const prev = latestByAgent.get(h.agent_id);
      if (!prev || h.received_at > prev.received_at) latestByAgent.set(h.agent_id, h);
    }

    const registeredNames = new Set(agents.map((a) => a.name));
    const view = agents.map((a) => ({ ...a, health: projectHealth(latestByAgent.get(a.name)) }));

    // Observed-only: a health record whose agent_id has no registry record yet
    // (e.g. statically-deployed agents during migration). Offered for adoption.
    const observed = overview
      .filter((h) => !registeredNames.has(h.agent_id))
      .map((h) => ({ agent_id: h.agent_id, repo: h.repo, status: h.status, received_at: h.received_at }));

    return NextResponse.json({ agents: view, observed });
  } catch (err) {
    return mapFleetStorageError(err, { route: "GET /api/dashboard/fleet/agents", installationId });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;
  const inst = requireInstallation(auth.session);
  if (!inst.ok) return inst.response;
  const installationId = inst.installationId;

  const rl = await checkFleetCreateRateLimit(installationId, auth.session.userId, auth.redis);
  if (!rl.allowed) {
    return fleetError(FLEET_ERROR.RATE_LIMITED, "Too many agent creations — slow down.", 429, {
      retryAfterSeconds: rl.retryAfterSeconds,
    });
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const validation = validateCreateAgentInput(parsed.body);
  if (!validation.ok) {
    const code = validation.field === "triggers.queen" ? FLEET_ERROR.QUEEN_NOT_SUPPORTED : FLEET_ERROR.VALIDATION;
    return fleetError(code, validation.message, 400, { field: validation.field });
  }
  const input = validation.value;

  const count = await countAgents(installationId, auth.redis);
  if (count >= MAX_AGENTS_PER_INSTALLATION) {
    return fleetError(
      FLEET_ERROR.AGENT_LIMIT_REACHED,
      `Installation is at the ${MAX_AGENTS_PER_INSTALLATION}-agent limit. Delete an agent first.`,
      409,
    );
  }

  // Link an EXISTING capability token. The token (managed on Credentials) is the
  // source of truth for BOTH capabilities and repo scope — validate it exists and
  // is repo-scoped, then snapshot its allowed_repos.
  const repos = await resolveTokenRepos(installationId, input.agent_token_name, auth.redis);
  if (!repos.ok) return repos.response;

  try {
    const record = await createAgent({
      installationId,
      input,
      repos: repos.repos,
      createdBy: auth.session.userLogin,
      agentTokenName: input.agent_token_name,
      redis: auth.redis,
    });
    return NextResponse.json({ agent: record }, { status: 201 });
  } catch (err) {
    return mapFleetStorageError(err, { route: "POST /api/dashboard/fleet/agents", installationId, name: input.name });
  }
}
