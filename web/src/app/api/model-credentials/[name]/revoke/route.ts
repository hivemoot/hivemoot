/**
 * POST /api/model-credentials/[name]/revoke  (MODEL_AUTH_DESIGN.md §5.3)
 *
 * status → revoked + blank ciphertext, keep metadata for audit (mirrors
 * byok/revoke). requireFresh:true (mutation). Never returns the secret.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { revokeModelCredential } from "@/server/model-credential-store";
import { mapModelCredentialError } from "@/server/model-credential-routes";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  const { name } = await params;

  try {
    const summary = await revokeModelCredential({
      installationId,
      name,
      revokedBy: auth.session.userLogin,
      redis: auth.redis,
      auditContext: { operator: auth.session.userLogin },
    });
    return NextResponse.json(summary);
  } catch (err) {
    return mapModelCredentialError(err, {
      route: "POST /api/model-credentials/[name]/revoke",
      installationId,
      name,
    });
  }
}
