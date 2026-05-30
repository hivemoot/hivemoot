/**
 * Fleet agent — detail / update / delete (cookie-auth dashboard surface).
 *
 * GET    → agent config + recent runs (joined from agent-health).
 * PATCH  → update config; RESYNC the token's capabilities when triggers change
 *          (snap-to, so removing a trigger drops its privilege).
 * DELETE → REVOKE the token first (fail-closed), then delete the record.
 *
 * A name belonging to another tenant resolves to 404 in the caller's namespace
 * (no cross-tenant existence oracle).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { FLEET_ERROR, fleetError, readJsonObject, mapFleetStorageError } from "@/server/fleet-routes";
import {
  getAgent,
  updateAgent,
  deleteAgent,
  validateUpdateAgentInput,
  validateAgentName,
  type AgentTriggers,
} from "@/server/fleet-store";
import { deriveCapabilities } from "@/server/agent-token-capabilities";
import { setAgentTokenCapabilities, revokeAgentToken } from "@/server/agent-token-v1";
import { getHistory } from "@/server/agent-health-store";

const DASHBOARD_AUDIT = { operator: { fingerprint: "", name: "dashboard" } } as const;

function triggerFlags(t: AgentTriggers) {
  return {
    schedule: t.schedule.enabled,
    pull_requests: t.pull_requests.enabled,
    mentions: t.mentions.enabled,
    tasks: t.tasks.enabled,
    war_rooms: t.war_rooms.enabled,
    war_rooms_contribute: t.war_rooms.settings.contribute,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;
  const inst = requireInstallation(auth.session);
  if (!inst.ok) return inst.response;
  const installationId = inst.installationId;
  const { name } = await params;

  if (!validateAgentName(name).ok) {
    return fleetError(FLEET_ERROR.NOT_FOUND, "Agent not found.", 404);
  }

  try {
    const agent = await getAgent({ installationId, name, redis: auth.redis });
    if (!agent) return fleetError(FLEET_ERROR.NOT_FOUND, "Agent not found.", 404);
    const runs = await getHistory(installationId, name, agent.repo, auth.redis);
    return NextResponse.json({ agent, runs });
  } catch (err) {
    return mapFleetStorageError(err, { route: "GET /api/dashboard/fleet/agents/[name]", installationId, name });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;
  const inst = requireInstallation(auth.session);
  if (!inst.ok) return inst.response;
  const installationId = inst.installationId;
  const { name } = await params;

  if (!validateAgentName(name).ok) {
    return fleetError(FLEET_ERROR.NOT_FOUND, "Agent not found.", 404);
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const validation = validateUpdateAgentInput(parsed.body);
  if (!validation.ok) {
    const code = validation.field === "triggers.queen" ? FLEET_ERROR.QUEEN_NOT_SUPPORTED : FLEET_ERROR.VALIDATION;
    return fleetError(code, validation.message, 400, { field: validation.field });
  }

  try {
    const updated = await updateAgent({
      installationId,
      name,
      patch: validation.value,
      actor: auth.session.userLogin,
      redis: auth.redis,
    });

    // Resync token capabilities when triggers changed (snap-to: a downgrade
    // drops privilege). Idempotent — a transient failure here returns 500 so
    // the operator retries and the system converges.
    if (validation.value.triggers !== undefined) {
      await setAgentTokenCapabilities({
        installationId,
        name: updated.agent_token_name,
        capabilities: deriveCapabilities(triggerFlags(updated.triggers)),
        redis: auth.redis,
        auditContext: { ...DASHBOARD_AUDIT, detailExtras: { reason: "fleet_trigger_resync", issued_by: auth.session.userLogin } },
      });
    }

    return NextResponse.json({ agent: updated });
  } catch (err) {
    return mapFleetStorageError(err, { route: "PATCH /api/dashboard/fleet/agents/[name]", installationId, name });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;
  const inst = requireInstallation(auth.session);
  if (!inst.ok) return inst.response;
  const installationId = inst.installationId;
  const { name } = await params;

  if (!validateAgentName(name).ok) {
    return fleetError(FLEET_ERROR.NOT_FOUND, "Agent not found.", 404);
  }

  try {
    const agent = await getAgent({ installationId, name, redis: auth.redis });
    if (!agent) return fleetError(FLEET_ERROR.NOT_FOUND, "Agent not found.", 404);

    // Fail-closed: revoke the token FIRST. If revoke throws, abort the delete so
    // we never leave a live bearer for a deleted agent. `revoke` returning false
    // (already gone) is fine — the goal state "no live token" is met.
    await revokeAgentToken({
      installationId,
      name: agent.agent_token_name,
      redis: auth.redis,
      auditContext: { ...DASHBOARD_AUDIT, detailExtras: { reason: "fleet_agent_delete", issued_by: auth.session.userLogin } },
    });

    await deleteAgent({ installationId, name, actor: auth.session.userLogin, redis: auth.redis });
    return NextResponse.json({ deleted: true, name });
  } catch (err) {
    return mapFleetStorageError(err, { route: "DELETE /api/dashboard/fleet/agents/[name]", installationId, name });
  }
}
