/**
 * POST /api/byok/rotate
 *
 * Atomic key replacement — validates new key, encrypts, overwrites envelope.
 * The old key becomes unreachable immediately (no re-encrypt needed since the
 * provider-side key changed, not the master key).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { encrypt } from "@/server/crypto";
import { setByokEnvelope } from "@/server/byok-store";
import { validateProviderKey } from "@/server/provider-validation";
import { BYOK_ERROR, byokError } from "@/server/byok-error";
import type { ByokEnvelope } from "@/server/byok-store";

interface RotateRequestBody {
  provider: string;
  model: string;
  apiKey: string;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  let body: RotateRequestBody;
  try {
    body = (await request.json()) as RotateRequestBody;
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

  const validation = await validateProviderKey(provider, apiKey, model);
  if (!validation.valid) {
    return byokError(
      BYOK_ERROR.PROVIDER_INVALID,
      validation.reason ?? "Provider rejected API key",
      400,
    );
  }

  const encrypted = encrypt(apiKey, auth.activeKeyVersion, auth.keyring);
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
