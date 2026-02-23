/**
 * POST /api/byok/re-encrypt
 *
 * Re-encrypts the session installation's BYOK envelope with the current
 * active master key version. Used after master key rotation to migrate
 * the envelope forward.
 *
 * Always operates on the authenticated session's installation — no
 * installationId field is accepted from the client.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { encrypt, decrypt } from "@/server/crypto";
import { getByokEnvelope, setByokEnvelope } from "@/server/byok-store";

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const installationId = auth.session.installationId;

  let reEncrypted = 0;
  let skipped = 0;
  const failed: string[] = [];

  try {
    const envelope = await getByokEnvelope(installationId, auth.redis);
    if (!envelope) {
      skipped++;
    } else if (envelope.status === "revoked") {
      // Skip revoked envelopes — no ciphertext to re-encrypt
      skipped++;
    } else if (envelope.keyVersion === auth.activeKeyVersion) {
      // Skip if already on current key version (idempotent)
      skipped++;
    } else {
      // Decrypt with old key, re-encrypt with current active key
      const plaintext = decrypt(
        {
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          tag: envelope.tag,
          keyVersion: envelope.keyVersion,
        },
        auth.keyring,
      );

      const reEncryptedEnvelope = encrypt(plaintext, auth.activeKeyVersion, auth.keyring);

      await setByokEnvelope(
        installationId,
        {
          ...envelope,
          ciphertext: reEncryptedEnvelope.ciphertext,
          iv: reEncryptedEnvelope.iv,
          tag: reEncryptedEnvelope.tag,
          keyVersion: reEncryptedEnvelope.keyVersion,
          updatedAt: new Date().toISOString(),
          updatedBy: auth.session.userLogin,
        },
        auth.redis,
      );

      reEncrypted++;
    }
  } catch {
    failed.push(installationId);
  }

  return NextResponse.json({ reEncrypted, skipped, failed });
}
