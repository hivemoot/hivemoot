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

  // Storage builds the audit entry internally with both the OLD
  // and NEW fingerprints in detail (read inside the lock; new is
  // computed before the script runs). Closes #506 builder R1 #3
  // and gives investigators a clean correlation point.
  try {
    const issued = await rotateAgentToken({
      installationId: auth.installationId,
      name,
      keyring: keyringResult.keyring,
      keyVersion: keyringResult.keyVersion,
      redis: auth.redis,
      auditContext: {
        operator: { fingerprint: auth.envelope.fingerprint, name: auth.name },
      },
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

    // The preserved policy is now surfaced from `IssuedAgentTokenV1`
    // (closes #506 builder R1 #2 — was previously `null` regardless,
    // falsely advertising policy-narrowed tokens as legacy-permissive).
    // `issued.policy` is undefined for envelopes that genuinely had
    // no policy; `projectV1ResponsePolicy(undefined)` correctly
    // returns null in that case.
    const responseBody: RotateResponse = {
      token: issued.token,
      name: issued.name,
      agent_role: issued.agent_role,
      capabilities: issued.capabilities,
      fingerprint: issued.fingerprint,
      expiresAt: issued.expiresAt,
      policy: projectV1ResponsePolicy(issued.policy ?? null),
      message:
        "New bearer is shown ONCE — store it securely now. Old bearer is already invalid.",
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
