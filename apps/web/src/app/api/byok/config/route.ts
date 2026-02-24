/**
 * POST /api/byok/config
 *
 * Creates or updates the BYOK configuration for an installation.
 * Validates the provider API key via a test call before encrypting and storing.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { encrypt } from "@/server/crypto";
import { setByokEnvelope } from "@/server/byok-store";
import { validateProviderKey } from "@/server/provider-validation";
import { BYOK_ERROR, byokError } from "@/server/byok-error";
import type { ByokEnvelope } from "@/server/byok-store";

interface ConfigRequestBody {
  provider: string;
  model: string;
  apiKey: string;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  let body: ConfigRequestBody;
  try {
    body = (await request.json()) as ConfigRequestBody;
  } catch {
    return byokError(BYOK_ERROR.INVALID_JSON, "Invalid JSON body", 400);
  }

  const { provider, model, apiKey } = body;
  const installationId = auth.session.installationId;

  if (!provider || !model || !apiKey) {
    return byokError(
      BYOK_ERROR.MISSING_FIELDS,
      "Missing required fields: provider, model, apiKey",
      400,
    );
  }

  // Validate the key with the provider
  const validation = await validateProviderKey(provider, apiKey, model);
  if (!validation.valid) {
    return byokError(
      BYOK_ERROR.PROVIDER_INVALID,
      validation.reason ?? "Provider rejected API key",
      400,
    );
  }

  // Encrypt the full payload so provider and model are GCM-authenticated
  const encrypted = encrypt(
    JSON.stringify({ apiKey, provider, model }),
    auth.activeKeyVersion,
    auth.keyring,
  );
  const envelope: ByokEnvelope = {
    provider,
    model,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: encrypted.keyVersion,
    status: "active",
    updatedAt: new Date().toISOString(),
    updatedBy: auth.session.userLogin,
    fingerprint: apiKey.slice(-4),
  };

  await setByokEnvelope(installationId, envelope, auth.redis);

  return NextResponse.json({
    status: "active",
    provider,
    model,
    fingerprint: envelope.fingerprint,
    updatedAt: envelope.updatedAt,
  });
}
