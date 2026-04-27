/**
 * GET    /api/agent-tokens/{name} — fetch a single token's summary
 * DELETE /api/agent-tokens/{name} — revoke a token by name
 *
 * Both require `agent_tokens.manage` (admin/operator capability).
 *
 * Revoke is idempotent at the storage layer (`revokeAgentToken`
 * returns false if the token was already gone). The route surfaces
 * the same 404 the GET-miss path uses for the missing case so
 * clients don't need a separate code path. Hard-stop semantics
 * per CAPABILITIES_DESIGN.md §"Graceful revocation": in-flight
 * calls 401 on next read; current task fails / orphans; queen
 * handles via the existing task watchdog.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import {
  getAgentTokenSummary,
  revokeAgentToken,
} from "@/server/agent-token-v1";
import {
  validateName,
  CapabilityValidationError,
} from "@/server/agent-token-capabilities";
import { auditAppend } from "@/server/agent-token-v1-audit";
import {
  buildMutationAuditEntry,
  projectV1TokenSummary,
  mapV1StorageErrorToResponse,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
  type V1TokenSummaryView,
} from "@/server/agent-token-v1-routes";

const REQUIRED_CAPABILITY = "agent_tokens.manage";

/** Validate the `[name]` path param at the boundary so route handlers
 * don't pass random strings to the storage layer. Throws are mapped
 * to a 400 INVALID_NAME response. */
function validatePathName(rawName: string): { ok: true; name: string } | { ok: false; response: NextResponse } {
  try {
    validateName(rawName);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      return {
        ok: false,
        response: v1Error(
          AGENT_TOKENS_V1_ERROR.INVALID_NAME,
          err.message,
          400,
          { field: err.field, value: err.value },
        ),
      };
    }
    throw err;
  }
  return { ok: true, name: rawName };
}

// ---------------------------------------------------------------------------
// GET /api/agent-tokens/{name}
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name: rawName } = await context.params;
  const nameCheck = validatePathName(rawName);
  if (!nameCheck.ok) return nameCheck.response;

  const auth = await authenticateAgentRequestV1(request, {
    requires: REQUIRED_CAPABILITY,
  });
  if (!auth.ok) return auth.response;

  try {
    const summary = await getAgentTokenSummary({
      installationId: auth.installationId,
      name: nameCheck.name,
      redis: auth.redis,
    });

    void auditAppend({
      redis: auth.redis,
      installationId: auth.installationId,
      entry: {
        ts: new Date().toISOString(),
        fingerprint: auth.envelope.fingerprint,
        name: auth.name,
        action: "auth.success",
        endpoint: "GET /api/agent-tokens/{name}",
        required_capability: REQUIRED_CAPABILITY,
        outcome: "ok",
      },
    });

    const responseBody: V1TokenSummaryView = projectV1TokenSummary(summary);
    return NextResponse.json(responseBody, { status: 200 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "GET /api/agent-tokens/{name}",
      installationId: auth.installationId,
      name: nameCheck.name,
    });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/agent-tokens/{name}
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name: rawName } = await context.params;
  const nameCheck = validatePathName(rawName);
  if (!nameCheck.ok) return nameCheck.response;

  const auth = await authenticateAgentRequestV1(request, {
    requires: REQUIRED_CAPABILITY,
  });
  if (!auth.ok) return auth.response;

  // **Self-revoke guard**: an admin token revoking ITSELF would
  // 401 in-flight requests including any retry by the operator.
  // The bootstrap path (B.1.d-iv) is the recovery, but we make the
  // trap explicit by returning 409 with a clear message rather than
  // silently completing. Note: this only catches name-equality;
  // operators could still revoke OTHER admin tokens that they
  // happened to also hold (and lock themselves out via that path,
  // which is intentional per the design's "deliberate-rotation"
  // discipline).
  if (auth.name === nameCheck.name) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.SELF_OP_REFUSED,
      "Refusing to revoke the bearer's own token — would lock you out mid-flight. Issue a successor admin token, switch to it, then revoke this one.",
      409,
      { name: nameCheck.name },
    );
  }

  const auditEntry = buildMutationAuditEntry({
    action: "revoke",
    operator: { fingerprint: auth.envelope.fingerprint, name: auth.name },
    subjectName: nameCheck.name,
  });

  try {
    const revoked = await revokeAgentToken({
      installationId: auth.installationId,
      name: nameCheck.name,
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
        endpoint: "DELETE /api/agent-tokens/{name}",
        required_capability: REQUIRED_CAPABILITY,
        outcome: "ok",
      },
    });

    if (!revoked) {
      // Idempotent at storage layer, but surface 404 to API clients
      // — operators want to know if their `revoke` was a no-op so
      // they can investigate (typo? already revoked?).
      return v1Error(
        AGENT_TOKENS_V1_ERROR.TOKEN_NOT_FOUND,
        `No agent token named '${nameCheck.name}' found for this installation (already revoked or never existed).`,
        404,
        { name: nameCheck.name },
      );
    }
    return NextResponse.json({ revoked: true, name: nameCheck.name }, { status: 200 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "DELETE /api/agent-tokens/{name}",
      installationId: auth.installationId,
      name: nameCheck.name,
    });
  }
}
