/**
 * POST /api/agent-tokens/{name}/rotate — atomic bearer rotation
 * for an existing named token.
 *
 * Auth: bearer with `agent_tokens.manage`.
 *
 * No body required. The storage layer (`rotateAgentToken`) generates
 * a new bearer + token-hash, swaps the encrypted ciphertext on the
 * envelope, and DELes the OLD hash-index entry — all in one Lua
 * EVAL — so the previous bearer is invalid the moment this returns.
 *
 * Preserves: `name`, `agent_role`, `capabilities`, `expiresAt`,
 * `policy`. (Rotate ≠ extend; rotate ≠ re-cap. Operators wanting
 * to extend lifetime should issue a successor under a different
 * name with the desired `expiresIn`, then revoke the old one.)
 *
 * Response shape mirrors POST /api/agent-tokens (issue): the new
 * bearer is shown ONCE.
 *
 * **Self-rotate guard**: refuses to rotate the bearer's own token —
 * the in-flight request would 401 the operator on next call (the
 * old bearer's hash-index DEL kills any retry). Operators should
 * issue a fresh successor admin token via POST /api/agent-tokens
 * and revoke this one separately.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAgentRequestV1,
  loadV1MintKeyring,
} from "@/server/agent-token-v1-auth";
import { rotateAgentToken } from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";
import {
  buildMutationAuditEntry,
  projectV1ResponsePolicy,
  mapV1StorageErrorToResponse,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
  type V1ResponsePolicyView,
} from "@/server/agent-token-v1-routes";

const REQUIRED_CAPABILITY = "agent_tokens.manage";

interface RotateResponse {
  /** New raw bearer. Shown ONCE — same contract as POST /api/agent-tokens. */
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  /** New fingerprint (changes on rotation since fingerprint is
   * derived from the new tokenHash prefix per #503 R1 fix). */
  fingerprint: string;
  /** Preserved from the original envelope — rotate doesn't touch
   * expiresAt. Operators wanting to extend lifetime should issue
   * a successor + revoke. */
  expiresAt: string | null;
  /** Preserved from the original envelope. */
  policy: V1ResponsePolicyView | null;
  message: string;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await context.params;

  const auth = await authenticateAgentRequestV1(request, {
    requires: REQUIRED_CAPABILITY,
  });
  if (!auth.ok) return auth.response;

  if (auth.name === name) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.SELF_OP_REFUSED,
      "Refusing to rotate the bearer's own token — the old hash-index DEL would 401 your next call. Issue a successor via POST /api/agent-tokens, switch to it, then call rotate or revoke against this one.",
      409,
      { name },
    );
  }

  const keyringResult = loadV1MintKeyring();
  if (!keyringResult.ok) return keyringResult.response;

  // For audit detail, capture the OLD fingerprint so investigators
  // can correlate the rotation with prior `auth.success` entries
  // tied to that fingerprint. We don't have the new fingerprint
  // until inside the storage function — that lands in the response
  // payload (and can be reconstructed from the next auth.success
  // event for the same name).
  const auditEntry = buildMutationAuditEntry({
    action: "rotate",
    operator: { fingerprint: auth.envelope.fingerprint, name: auth.name },
    subjectName: name,
    // No `detail` — rotate is "swap bearer, preserve everything
    // else" and the new fingerprint is observable via the response
    // and the next auth.success in the same installation's :auth
    // stream. Empty detail keeps the audit row compact.
  });

  try {
    const issued = await rotateAgentToken({
      installationId: auth.installationId,
      name,
      keyring: keyringResult.keyring,
      keyVersion: keyringResult.keyVersion,
      redis: auth.redis,
      auditEntry,
    });

    void auditAppend({
      redis: auth.redis,
      installationId: auth.installationId,
      entry: {
        ts: new Date().toISOString(),
        fingerprint: auth.envelope.fingerprint,
        name: auth.name,
        action: "auth.success",
        endpoint: "POST /api/agent-tokens/{name}/rotate",
        required_capability: REQUIRED_CAPABILITY,
        outcome: "ok",
      },
    });

    // Preserved policy comes from the OLD envelope — rotate doesn't
    // mutate policy. Read it from the auth context's envelope view
    // by way of a separate read isn't worth it; the response just
    // omits policy on rotate (caller can GET /api/agent-tokens/{name}
    // afterwards if they want the full snapshot). For now we stage
    // policy: null — rotation doesn't claim to surface it.
    //
    // Actually — surface it for operator clarity. We can fetch the
    // post-rotate summary in the same call's wake. But that's an
    // extra Redis RTT for a frontend convenience. Compromise:
    // include it as null and document that callers wanting the full
    // post-rotate snapshot should call GET /api/agent-tokens/{name}.
    const responseBody: RotateResponse = {
      token: issued.token,
      name: issued.name,
      agent_role: issued.agent_role,
      capabilities: issued.capabilities,
      fingerprint: issued.fingerprint,
      expiresAt: issued.expiresAt,
      // IssuedAgentTokenV1 doesn't carry policy; surface null and
      // tell callers to fetch the show endpoint for the full picture.
      policy: projectV1ResponsePolicy(null),
      message:
        "New bearer is shown ONCE — store it securely now. Old bearer is already invalid. Call GET /api/agent-tokens/{name} for the full post-rotate snapshot (incl. policy).",
    };
    return NextResponse.json(responseBody, { status: 200 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "POST /api/agent-tokens/{name}/rotate",
      installationId: auth.installationId,
      name,
    });
  }
}
