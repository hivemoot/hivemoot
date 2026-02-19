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
import type { ByokEnvelope } from "@/server/byok-store";

interface ConfigRequestBody {
  installationId: string;
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
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { installationId, provider, model, apiKey } = body;

  if (!installationId || !provider || !model || !apiKey) {
    return NextResponse.json(
      { error: "Missing required fields: installationId, provider, model, apiKey" },
      { status: 400 },
    );
  }

  // Cross-installation isolation
  if (auth.session.installationId !== installationId) {
    return NextResponse.json(
      { error: "Installation ID does not match session" },
      { status: 403 },
    );
  }

  // Validate the key with the provider
  const validation = await validateProviderKey(provider, apiKey, model);
  if (!validation.valid) {
    return NextResponse.json(
      { code: "byok_provider_invalid", reason: validation.reason },
      { status: 400 },
    );
  }

  // Encrypt and store
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
    fingerprintLast4: apiKey.slice(-4),
  };

  await setByokEnvelope(installationId, envelope, auth.redis);

  return NextResponse.json({
    status: "active",
    provider,
    model,
    fingerprintLast4: envelope.fingerprintLast4,
    updatedAt: envelope.updatedAt,
  });
}
