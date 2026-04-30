/**
 * POST /api/dashboard/agent-tokens/{name}/rotate — issue a fresh
 * bearer for an existing token (cookie-auth dashboard surface).
 *
 * Rotation preserves the envelope's name + capabilities + agent_role
 * + expiresAt; only the bearer (and its hash / fingerprint) change.
 * The new bearer is shown ONCE in the response — operators must
 * paste it into wherever the old bearer lived (queen agent config,
 * apiarist secrets, etc.) immediately.
 *
 * See ../../route.ts for the rationale on cookie-auth wrappers.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  rotateAgentToken,
  type IssuedAgentTokenV1,
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

interface RotateResponse {
  /** Raw bearer (`hmt_xxx...`). Shown ONCE — paste into target before
   * leaving this view. */
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  message: string;
}

export async function POST(
  request: NextRequest,
  context: PathParams,
): Promise<NextResponse> {
  const { name: rawName } = await context.params;
  if (typeof rawName !== "string" || rawName.length === 0) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_NAME,
      "Token name is required in the URL path.",
      400,
    );
  }
  try {
    validateName(rawName);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      return v1Error(AGENT_TOKENS_V1_ERROR.INVALID_NAME, err.message, 400, {
        field: err.field,
        value: err.value,
      });
    }
    throw err;
  }

  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  let rotated: IssuedAgentTokenV1;
  try {
    rotated = await rotateAgentToken({
      installationId,
      name: rawName,
      keyring: auth.keyring,
      keyVersion: auth.activeKeyVersion,
      redis: auth.redis,
      auditContext: {
        operator: { fingerprint: "", name: "dashboard" },
        detailExtras: { rotated_by: auth.session.userLogin },
      },
    });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "POST /api/dashboard/agent-tokens/{name}/rotate",
      installationId,
      name: rawName,
    });
  }

  const response: RotateResponse = {
    token: rotated.token,
    name: rotated.name,
    agent_role: rotated.agent_role,
    capabilities: [...rotated.capabilities],
    fingerprint: rotated.fingerprint,
    expiresAt: rotated.expiresAt,
    message:
      "New bearer — store it in the target (queen agent / apiarist secret / etc.) immediately. The previous bearer is now invalid.",
  };
  return NextResponse.json(response);
}
