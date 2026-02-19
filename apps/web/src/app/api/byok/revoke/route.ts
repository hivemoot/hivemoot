/**
 * POST /api/byok/revoke
 *
 * Revokes the BYOK config for an installation. Clears all ciphertext fields
 * so no key material can be recovered, but preserves metadata for audit trail.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { getByokEnvelope, setByokEnvelope } from "@/server/byok-store";

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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { installationId } = body;

  if (!installationId) {
    return NextResponse.json(
      { error: "Missing required field: installationId" },
      { status: 400 },
    );
  }

  if (auth.session.installationId !== installationId) {
    return NextResponse.json(
      { error: "Installation ID does not match session" },
      { status: 403 },
    );
  }

  const existing = await getByokEnvelope(installationId, auth.redis);
  if (!existing) {
    return NextResponse.json(
      { code: "byok_not_configured" },
      { status: 404 },
    );
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
