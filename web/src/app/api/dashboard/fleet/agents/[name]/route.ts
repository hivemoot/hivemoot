/**
 * Fleet agent — detail / update / delete (cookie-auth dashboard surface).
 *
 * GET    → agent config + recent runs (joined from agent-health across its repos).
 * PATCH  → update config; re-point `agent_token_name` to change the linked token
 *          (which re-derives the agent's repos). Never mutates token capabilities.
 * DELETE → delete the record. Does NOT revoke the linked token — tokens are
 *          managed independently on the Credentials screen.
 *
 * A name belonging to another tenant resolves to 404 in the caller's namespace
 * (no cross-tenant existence oracle).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  FLEET_ERROR,
  fleetError,
  readJsonObject,
  mapFleetStorageError,
  resolveTokenRepos,
} from "@/server/fleet-routes";
import {
  getAgent,
  updateAgent,
  deleteAgent,
  validateUpdateAgentInput,
  validateAgentName,
} from "@/server/fleet-store";
import { getHistory, type HealthReport } from "@/server/agent-health-store";

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
    // The agent may span multiple repos — merge run history across them, newest first.
    const perRepo = await Promise.all(
      agent.repos.map((repo) => getHistory(installationId, name, repo, auth.redis)),
    );
    const runs: HealthReport[] = perRepo
      .flat()
      .sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
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

  // Re-pointing the token re-derives the agent's repo scope from the new token.
  let repos: string[] | undefined;
  if (validation.value.agent_token_name !== undefined) {
    const resolved = await resolveTokenRepos(installationId, validation.value.agent_token_name, auth.redis);
    if (!resolved.ok) return resolved.response;
    repos = resolved.repos;
  }

  try {
    const updated = await updateAgent({
      installationId,
      name,
      patch: validation.value,
      repos,
      actor: auth.session.userLogin,
      redis: auth.redis,
    });
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
    // Delete the record only — the linked token is shared and managed
    // independently on the Credentials screen, so we never revoke it here.
    await deleteAgent({ installationId, name, actor: auth.session.userLogin, redis: auth.redis });
    return NextResponse.json({ deleted: true, name });
  } catch (err) {
    return mapFleetStorageError(err, { route: "DELETE /api/dashboard/fleet/agents/[name]", installationId, name });
  }
}
