/**
 * POST /api/byok/revoke
 *
 * Revokes the BYOK config for an installation. Clears all ciphertext fields
 * so no key material can be recovered, but preserves metadata for audit trail.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { getByokEnvelope, setByokEnvelope } from "@/server/byok-store";
import { BYOK_ERROR, byokError } from "@/server/byok-error";

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  let existing;
  try {
    existing = await getByokEnvelope(installationId, auth.redis);
  } catch (err) {
    console.error("[byok-revoke] Failed to read envelope from Redis", { installationId, error: err });
    return byokError(BYOK_ERROR.SERVER_MISCONFIGURATION, "Failed to read configuration", 500);
  }
  if (!existing) {
    return byokError(BYOK_ERROR.NOT_CONFIGURED, "BYOK is not configured", 404);
  }

  // Clear ciphertext fields, keep metadata for audit
  const revoked = {
    ...existing,
    status: "revoked" as const,
    ciphertext: "",
    iv: "",
    tag: "",
    updatedAt: new Date().toISOString(),
    updatedBy: auth.session.userLogin,
  };

  try {
    await setByokEnvelope(installationId, revoked, auth.redis);
  } catch (err) {
    console.error("[byok-revoke] Failed to write revoked envelope to Redis", { installationId, error: err });
    return byokError(BYOK_ERROR.SERVER_MISCONFIGURATION, "Failed to revoke configuration", 500);
  }

  return NextResponse.json({
    status: "revoked",
    provider: revoked.provider,
    model: revoked.model,
    updatedAt: revoked.updatedAt,
  });
}
