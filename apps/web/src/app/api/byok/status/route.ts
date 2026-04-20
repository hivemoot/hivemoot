/**
 * GET /api/byok/status
 *
 * Returns non-sensitive metadata about the BYOK configuration.
 * Never returns key material — only provider, model, status, timestamps.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope } from "@/server/byok-store";
import { BYOK_ERROR, byokError } from "@/server/byok-error";

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;

  let envelope: Awaited<ReturnType<typeof getByokEnvelope>>;
  try {
    envelope = await getByokEnvelope(installationId, auth.redis);
  } catch (err) {
    console.error("[byok-status] Redis error reading envelope", { installationId, error: err });
    return byokError(BYOK_ERROR.SERVER_MISCONFIGURATION, "Failed to read BYOK status", 500);
  }

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
        updatedAt: envelope.updatedAt,
      },
    );
  }

  return NextResponse.json({
    status: envelope.status,
    provider: envelope.provider,
    model: envelope.model,
    updatedAt: envelope.updatedAt,
  });
}
