/**
 * GET /api/byok/status?installationId=<id>
 *
 * Returns non-sensitive metadata about the BYOK configuration.
 * Never returns key material — only provider, model, fingerprint, status, timestamps.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope } from "@/server/byok-store";

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const installationId = searchParams.get("installationId");

  if (!installationId) {
    return NextResponse.json(
      { error: "Missing required query parameter: installationId" },
      { status: 400 },
    );
  }

  if (auth.session.installationId !== installationId) {
    return NextResponse.json(
      { error: "Installation ID does not match session" },
      { status: 403 },
    );
  }

  const envelope = await getByokEnvelope(installationId, auth.redis);
  if (!envelope) {
    return NextResponse.json(
      { code: "byok_not_configured" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    status: envelope.status,
    provider: envelope.provider,
    model: envelope.model,
    fingerprintLast4: envelope.fingerprintLast4,
    updatedAt: envelope.updatedAt,
  });
}
