/**
 * Fleet agent — detail / update / delete (cookie-auth dashboard surface).
 *
 * GET    → agent config + recent runs (per-agent health history, no repo dimension).
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
  validateLinkedToken,
  resolveGithubRepos,
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
    // Health is a per-agent signal now — a single history lookup keyed by the
    // agent name (no per-repo fan-out). getHistory already returns runs
    // newest-first.
    const runs: HealthReport[] = await getHistory(installationId, name, auth.redis);
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
    const code = validation.field === "plugins.queen" ? FLEET_ERROR.QUEEN_NOT_SUPPORTED : FLEET_ERROR.VALIDATION;
    return fleetError(code, validation.message, 400, { field: validation.field });
  }

  // Re-pointing the token only re-validates EXISTENCE (capabilities, not repos).
  // Scoped to the caller's installation, so a cross-tenant token name misses.
  if (validation.value.agent_token_name !== undefined) {
    const tokenCheck = await validateLinkedToken(installationId, validation.value.agent_token_name, auth.redis);
    if (!tokenCheck.ok) return tokenCheck.response;
  }

  // Whenever the patch carries a github plugin block (enabled or not), re-resolve
  // its repos against the installation (fail-closed) and write the canonical list
  // back, so a disabled-but-uncovered repo can't be slipped into storage either.
  //
  // defaultAllWhenEmpty mirrors enabled (enabled+empty → ALL installed repos),
  // identical to create's default-all-on-empty-enabled — so a PATCH that leaves
  // github ENABLED with an EMPTY repos list intentionally RE-WIDENS to every
  // installed repo. The dashboard form always submits the operator's explicit
  // repo selection and client-validates it non-empty, so this only affects
  // direct API callers; and every resolved repo is still installation-covered
  // (resolveGithubRepos fail-closes on anything else). This is consistent-with-
  // create by design, not a behavior change.
  if (validation.value.plugins?.github) {
    const resolved = await resolveGithubRepos(installationId, validation.value.plugins.github.repos, {
      defaultAllWhenEmpty: validation.value.plugins.github.enabled,
    });
    if (!resolved.ok) return resolved.response;
    validation.value.plugins.github.repos = resolved.repos;
  }

  try {
    const updated = await updateAgent({
      installationId,
      name,
      patch: validation.value,
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
