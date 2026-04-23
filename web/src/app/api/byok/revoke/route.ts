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

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;

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
