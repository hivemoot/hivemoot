/**
 * POST /api/model-credentials/[name]/rotate  (MODEL_AUTH_DESIGN.md §5.3)
 *
 * Swap a credential's secret VALUE: re-validate (live probe for api_key),
 * re-encrypt, update fingerprint + rotatedAt, preserve provider/kind.
 * requireFresh:true (mutation). Never returns/logs the secret value.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { validateProviderKey } from "@/server/provider-validation";
import {
  getModelCredential,
  rotateModelCredential,
} from "@/server/model-credential-store";
import {
  MODEL_CREDENTIAL_ERROR,
  mcError,
  readJsonObject,
  mapModelCredentialError,
} from "@/server/model-credential-routes";

const LIVE_VALIDATABLE_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "openrouter",
]);

interface RotateBody {
  value?: unknown;
  expiresAt?: unknown;
}

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

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as RotateBody;

  if (typeof body.value !== "string" || body.value.length === 0) {
    return mcError(
      MODEL_CREDENTIAL_ERROR.VALIDATION,
      "Missing or invalid 'value'.",
      400,
    );
  }
  let expiresAt: string | null | undefined;
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      expiresAt = null;
    } else if (
      typeof body.expiresAt !== "string" ||
      Number.isNaN(new Date(body.expiresAt).getTime())
    ) {
      return mcError(
        MODEL_CREDENTIAL_ERROR.VALIDATION,
        "'expiresAt' must be an ISO 8601 timestamp or null.",
        400,
      );
    } else {
      expiresAt = body.expiresAt;
    }
  }
  const value: string = body.value;

  try {
    // Read the existing envelope (404 if absent / not yours) to learn the
    // provider+kind, which are fixed at create and govern re-validation.
    const existing = await getModelCredential({
      installationId,
      name,
      redis: auth.redis,
    });

    if (
      existing.kind === "api_key" &&
      LIVE_VALIDATABLE_PROVIDERS.has(existing.provider)
    ) {
      const validation = await validateProviderKey(existing.provider, value);
      if (!validation.valid) {
        return mcError(
          MODEL_CREDENTIAL_ERROR.VALIDATION,
          validation.reason ?? "Provider rejected the API key.",
          400,
        );
      }
    }

    const summary = await rotateModelCredential({
      installationId,
      name,
      value,
      rotatedBy: auth.session.userLogin,
      expiresAt,
      keyring: auth.keyring,
      keyVersion: auth.activeKeyVersion,
      redis: auth.redis,
      auditContext: { operator: auth.session.userLogin },
    });
    return NextResponse.json(summary);
  } catch (err) {
    return mapModelCredentialError(err, {
      route: "POST /api/model-credentials/[name]/rotate",
      installationId,
      name,
    });
  }
}
