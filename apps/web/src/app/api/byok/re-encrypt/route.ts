/**
 * POST /api/byok/re-encrypt
 *
 * Re-encrypts BYOK envelopes with the current active master key version.
 * Used after master key rotation to migrate old envelopes forward.
 *
 * Accepts either a single installationId or no body for batch mode
 * (processes all installations the session has access to).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { encrypt, decrypt } from "@/server/crypto";
import {
  getByokEnvelope,
  setByokEnvelope,
  listByokInstallationIds,
} from "@/server/byok-store";

interface ReEncryptRequestBody {
  installationId?: string;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  let body: ReEncryptRequestBody = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as ReEncryptRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let installationIds: string[];

  if (body.installationId) {
    // Single mode — verify cross-installation isolation
    if (auth.session.installationId !== body.installationId) {
      return NextResponse.json(
        { error: "Installation ID does not match session" },
        { status: 403 },
      );
    }
    installationIds = [body.installationId];
  } else {
    // Batch mode — only process the session's own installation
    installationIds = [auth.session.installationId];
  }

  let reEncrypted = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const id of installationIds) {
    try {
      const envelope = await getByokEnvelope(id, auth.redis);
      if (!envelope) {
        skipped++;
        continue;
      }

      // Skip revoked envelopes — no ciphertext to re-encrypt
      if (envelope.status === "revoked") {
        skipped++;
        continue;
      }

      // Skip if already on current key version (idempotent)
      if (envelope.keyVersion === auth.activeKeyVersion) {
        skipped++;
        continue;
      }

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

      await setByokEnvelope(id, {
        ...envelope,
        ciphertext: reEncryptedEnvelope.ciphertext,
        iv: reEncryptedEnvelope.iv,
        tag: reEncryptedEnvelope.tag,
        keyVersion: reEncryptedEnvelope.keyVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.session.userLogin,
      }, auth.redis);

      reEncrypted++;
    } catch {
      failed.push(id);
    }
  }

  // Also batch-scan all installations if the caller is doing a full migration
  // This only applies when no specific installationId was given and we want
  // to handle orphaned envelopes. For security, we list all IDs but only
  // process them if they match the session's installation.
  if (!body.installationId) {
    try {
      const allIds = await listByokInstallationIds(auth.redis);
      for (const id of allIds) {
        // Only process installations we haven't already handled
        if (installationIds.includes(id)) continue;
        // In single-session scope, skip other installations
        skipped++;
      }
    } catch {
      // SCAN failure is non-fatal for the core operation
    }
  }

  return NextResponse.json({ reEncrypted, skipped, failed });
}
