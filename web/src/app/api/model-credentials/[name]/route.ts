/**
 * GET /api/model-credentials/[name]  (MODEL_AUTH_DESIGN.md §5.3)
 *
 * Returns the credential SUMMARY (metadata only, NEVER ciphertext).
 * requireFresh:false (a read). installationId from the session only — a
 * foreign name resolves to 404 in the caller's namespace (no cross-tenant
 * existence oracle).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { getModelCredentialSummary } from "@/server/model-credential-store";
import { mapModelCredentialError } from "@/server/model-credential-routes";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  const { name } = await params;

  try {
    const summary = await getModelCredentialSummary({
      installationId,
      name,
      redis: auth.redis,
    });
    // summary excludes all crypto fields — never returns the value.
    return NextResponse.json(summary);
  } catch (err) {
    return mapModelCredentialError(err, {
      route: "GET /api/model-credentials/[name]",
      installationId,
      name,
    });
  }
}
