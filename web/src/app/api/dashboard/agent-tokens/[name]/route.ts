/**
 * Dashboard cookie-auth wrappers for per-token V1 capability operations.
 *
 * GET    /api/dashboard/agent-tokens/{name}  → summary metadata
 *                                              (no raw bearer; that's
 *                                              one-time-display at
 *                                              issue/rotate)
 * DELETE /api/dashboard/agent-tokens/{name}  → revoke (idempotent
 *                                              storage-side, surfaces
 *                                              404 if name was never
 *                                              issued)
 *
 * See ../route.ts for the rationale on cookie-auth vs the
 * `/api/agent-tokens` admin-bearer surface.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  getAgentTokenSummary,
  revokeAgentToken,
  type AgentTokenSummaryV1,
} from "@/server/agent-token-v1";
import {
  validateName,
  CapabilityValidationError,
} from "@/server/agent-token-capabilities";
import {
  mapV1StorageErrorToResponse,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
} from "@/server/agent-token-v1-routes";

interface PathParams {
  params: Promise<{ name: string }>;
}

function validatePathName(
  rawName: string,
): { ok: true; name: string } | { ok: false; response: NextResponse } {
  if (typeof rawName !== "string" || rawName.length === 0) {
    return {
      ok: false,
      response: v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_NAME,
        "Token name is required in the URL path.",
        400,
      ),
    };
  }
  try {
    validateName(rawName);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      return {
        ok: false,
        response: v1Error(AGENT_TOKENS_V1_ERROR.INVALID_NAME, err.message, 400, {
          field: err.field,
          value: err.value,
        }),
      };
    }
    throw err;
  }
  return { ok: true, name: rawName };
}

export async function GET(
  request: NextRequest,
  context: PathParams,
): Promise<NextResponse> {
  const { name: rawName } = await context.params;
  const nameCheck = validatePathName(rawName);
  if (!nameCheck.ok) return nameCheck.response;

  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  try {
    const summary: AgentTokenSummaryV1 = await getAgentTokenSummary({
      installationId,
      name: nameCheck.name,
      redis: auth.redis,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "GET /api/dashboard/agent-tokens/{name}",
      installationId,
      name: nameCheck.name,
    });
  }
}

export async function DELETE(
  request: NextRequest,
  context: PathParams,
): Promise<NextResponse> {
  const { name: rawName } = await context.params;
  const nameCheck = validatePathName(rawName);
  if (!nameCheck.ok) return nameCheck.response;

  // Mutating — `requireFresh: true` matches the issuance and bootstrap
  // surfaces.
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  // No self-revoke guard needed here — cookie auth means the operator
  // doesn't hold a bearer that could be the subject of revocation.
  // (The bearer-auth surface at `/api/agent-tokens/{name}` keeps the
  // self-revoke 409 for operators using V1 admin bearers there.)

  try {
    const revoked = await revokeAgentToken({
      installationId,
      name: nameCheck.name,
      redis: auth.redis,
      auditContext: {
        operator: { fingerprint: "", name: "dashboard" },
        detailExtras: { revoked_by: auth.session.userLogin },
      },
    });
    if (!revoked) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.TOKEN_NOT_FOUND,
        `No agent token named '${nameCheck.name}' found for this installation (already revoked or never existed).`,
        404,
        { name: nameCheck.name },
      );
    }
    return NextResponse.json(
      { revoked: true, name: nameCheck.name },
      { status: 200 },
    );
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "DELETE /api/dashboard/agent-tokens/{name}",
      installationId,
      name: nameCheck.name,
    });
  }
}
