/**
 * POST /api/model-credentials/[name]/re-encrypt  (MODEL_AUTH_DESIGN.md §5.3)
 *
 * Master-key rebind: decrypt with the old key version, re-encrypt with the
 * current active version, preserve everything else (mirrors byok/re-encrypt).
 * Skips revoked / already-current envelopes. requireFresh:true (mutation).
 * Never returns the secret.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { reEncryptModelCredential } from "@/server/model-credential-store";
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
    const result = await reEncryptModelCredential({
      installationId,
      name,
      activeKeyVersion: auth.activeKeyVersion,
      keyring: auth.keyring,
      redis: auth.redis,
      auditContext: { operator: auth.session.userLogin },
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapModelCredentialError(err, {
      route: "POST /api/model-credentials/[name]/re-encrypt",
      installationId,
      name,
    });
  }
}
