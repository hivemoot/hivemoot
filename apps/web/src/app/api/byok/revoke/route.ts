/**
 * POST /api/byok/revoke
 *
 * Revokes the BYOK config for an installation. Clears all ciphertext fields
 * so no key material can be recovered, but preserves metadata for audit trail.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope, setByokEnvelope } from "@/server/byok-store";
import { BYOK_ERROR, byokError } from "@/server/byok-error";

interface RevokeRequestBody {
  installationId: string;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  let body: RevokeRequestBody;
  try {
    body = (await request.json()) as RevokeRequestBody;
  } catch {
    return byokError(BYOK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  const { installationId } = body;

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

  const existing = await getByokEnvelope(installationId, auth.redis);
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

  await setByokEnvelope(installationId, revoked, auth.redis);

  return NextResponse.json({
    status: "revoked",
    provider: revoked.provider,
    model: revoked.model,
    updatedAt: revoked.updatedAt,
  });
}
