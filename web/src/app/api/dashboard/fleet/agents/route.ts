/**
 * Fleet agent registry — list + create (cookie-auth dashboard surface).
 *
 * GET  /api/dashboard/fleet/agents  → registered agents (+ health) and
 *      observed-only (unregistered) agents for adoption.
 * POST /api/dashboard/fleet/agents  → register an agent. Auto-issues a
 *      least-privilege, repo-scoped V1 token (bearer shown ONCE). Fail-closed
 *      on repo coverage; rolls back the token if the record write fails.
 *
 * installationId always comes from the authenticated session — never the body.
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
} from "@/server/fleet-routes";
import {
  createAgent,
  listAgents,
  countAgents,
  validateCreateAgentInput,
  MAX_AGENTS_PER_INSTALLATION,
  type FleetAgent,
} from "@/server/fleet-store";
import { deriveCapabilities } from "@/server/agent-token-capabilities";
import {
  issueAgentToken,
  revokeAgentToken,
  TokenNameTakenError,
  TokenLimitReachedError,
} from "@/server/agent-token-v1";
import { assertRepoCoveredByInstallation } from "@/server/github-installation-repos";
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

function healthKey(agentId: string, repo: string): string {
  return `${agentId}:${repo}`;
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

    const healthBy = new Map<string, HealthOverviewEntry>();
    for (const h of overview) healthBy.set(healthKey(h.agent_id, h.repo), h);

    const registeredNames = new Set(agents.map((a) => a.name));
    const view = agents.map((a) => ({
      ...a,
      health: projectHealth(healthBy.get(healthKey(a.name, a.repo))),
    }));

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

  // Cheap pre-check for a clear error; createAgent re-checks atomically.
  const count = await countAgents(installationId, auth.redis);
  if (count >= MAX_AGENTS_PER_INSTALLATION) {
    return fleetError(
      FLEET_ERROR.AGENT_LIMIT_REACHED,
      `Installation is at the ${MAX_AGENTS_PER_INSTALLATION}-agent limit. Delete an agent first.`,
      409,
    );
  }

  // Fail-closed repo-coverage authorization.
  const coverage = await assertRepoCoveredByInstallation({ installationId, repo: input.repo });
  if (!coverage.ok) {
    return coverage.reason === "not_covered"
      ? fleetError(FLEET_ERROR.REPO_NOT_COVERED, coverage.message, 403, { repo: input.repo })
      : fleetError(FLEET_ERROR.COVERAGE_CHECK_FAILED, coverage.message, 503);
  }

  // Least-privilege capabilities derived purely from the enabled triggers.
  const capabilities = deriveCapabilities({
    schedule: input.triggers.schedule.enabled,
    pull_requests: input.triggers.pull_requests.enabled,
    mentions: input.triggers.mentions.enabled,
    tasks: input.triggers.tasks.enabled,
    war_rooms: input.triggers.war_rooms.enabled,
    war_rooms_contribute: input.triggers.war_rooms.settings.contribute,
  });

  // Issue the agent's token first (enforces token-name uniqueness + token cap).
  let issued;
  try {
    issued = await issueAgentToken({
      installationId,
      name: input.name,
      agent_role: input.name,
      capabilities,
      policy: { allowed_repos: [input.repo] },
      createdBy: auth.session.userLogin,
      expiresAt: null,
      keyring: auth.keyring,
      keyVersion: auth.activeKeyVersion,
      redis: auth.redis,
      auditContext: {
        operator: { fingerprint: "", name: "dashboard" },
        detailExtras: { issued_by: auth.session.userLogin, source: "fleet" },
      },
    });
  } catch (err) {
    if (err instanceof TokenNameTakenError) {
      return fleetError(FLEET_ERROR.NAME_TAKEN, `An agent or token named '${input.name}' already exists.`, 409, {
        name: input.name,
      });
    }
    if (err instanceof TokenLimitReachedError) {
      return fleetError(FLEET_ERROR.AGENT_LIMIT_REACHED, err.message, 409);
    }
    return mapFleetStorageError(err, { route: "POST /api/dashboard/fleet/agents", installationId, name: input.name });
  }

  // Persist the record; on failure revoke the just-issued token (no orphan).
  let record: FleetAgent;
  try {
    record = await createAgent({
      installationId,
      input,
      createdBy: auth.session.userLogin,
      agentTokenName: issued.name,
      redis: auth.redis,
    });
  } catch (err) {
    try {
      await revokeAgentToken({
        installationId,
        name: issued.name,
        redis: auth.redis,
        auditContext: {
          operator: { fingerprint: "", name: "dashboard" },
          detailExtras: { reason: "fleet_create_rollback" },
        },
      });
    } catch (revokeErr) {
      console.error("[fleet] token revoke after create-failure also failed", {
        installationId,
        name: issued.name,
        revokeErr,
      });
    }
    return mapFleetStorageError(err, { route: "POST /api/dashboard/fleet/agents", installationId, name: input.name });
  }

  return NextResponse.json(
    {
      agent: record,
      token: issued.token,
      token_fingerprint: issued.fingerprint,
      message: "Agent created. The token below is shown ONCE — store it securely (it provisions the agent on the hive).",
    },
    { status: 201 },
  );
}
