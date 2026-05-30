/**
 * Pause / resume an agent: POST { enabled: boolean }.
 *
 * Pausing keeps the token live (the stopped container can't present it); the
 * reconciler stops the container because the agent is still LISTED in
 * desired-state with enabled:false. Resuming flips it back.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { FLEET_ERROR, fleetError, readJsonObject, mapFleetStorageError } from "@/server/fleet-routes";
import { setAgentEnabled, validateAgentName } from "@/server/fleet-store";

export async function POST(
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
  if (typeof parsed.body.enabled !== "boolean") {
    return fleetError(FLEET_ERROR.VALIDATION, "Body must include { enabled: boolean }.", 400, { field: "enabled" });
  }

  try {
    const updated = await setAgentEnabled({
      installationId,
      name,
      enabled: parsed.body.enabled,
      actor: auth.session.userLogin,
      redis: auth.redis,
    });
    return NextResponse.json({ agent: updated });
  } catch (err) {
    return mapFleetStorageError(err, { route: "POST /api/dashboard/fleet/agents/[name]/enabled", installationId, name });
  }
}
