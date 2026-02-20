/**
 * GET /api/byok/status?installationId=<id>
 *
 * Returns non-sensitive metadata about the BYOK configuration.
 * Never returns key material — only provider, model, fingerprint, status, timestamps.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope } from "@/server/byok-store";
import { BYOK_ERROR, byokError } from "@/server/byok-error";

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const installationId = searchParams.get("installationId");

  if (!installationId) {
    return byokError(
      BYOK_ERROR.MISSING_FIELDS,
      "Missing required fields: installationId",
      400,
    );
  }

  if (auth.session.installationId !== installationId) {
    return byokError(
      BYOK_ERROR.INSTALLATION_MISMATCH,
      "Installation ID does not match session",
      403,
    );
  }

  const envelope = await getByokEnvelope(installationId, auth.redis);
  if (!envelope) {
    return byokError(
      BYOK_ERROR.NOT_CONFIGURED,
      "BYOK is not configured",
      404,
    );
  }

  if (envelope.status === "revoked") {
    return byokError(
      BYOK_ERROR.REVOKED,
      "BYOK configuration has been revoked",
      409,
      {
        status: envelope.status,
        provider: envelope.provider,
        model: envelope.model,
        fingerprint: envelope.fingerprint,
        updatedAt: envelope.updatedAt,
      },
    );
  }

  return NextResponse.json({
    status: envelope.status,
    provider: envelope.provider,
    model: envelope.model,
    fingerprint: envelope.fingerprint,
    updatedAt: envelope.updatedAt,
  });
}
