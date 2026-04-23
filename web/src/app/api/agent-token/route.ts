/**
 * POST / GET / DELETE  /api/agent-token
 *
 * Manages per-installation agent bearer tokens used to authenticate health
 * reports. All three methods require a valid setup session (cookie auth).
 *
 * POST   — Generate a new token (rotates if one exists).
 * GET    — Return the current token and metadata so admins can copy/recover it.
 * DELETE — Revoke the token.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import {
  generateAgentToken,
  getAgentToken,
  LockTimeoutError,
  revokeAgentToken,
} from "@/server/agent-token";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  try {
    const token = await generateAgentToken(
      auth.session.installationId,
      auth.session.userLogin,
      auth.activeKeyVersion,
      auth.keyring,
      auth.redis,
    );

    return NextResponse.json({
      token,
      fingerprint: token.slice(-8),
      message: "Store this token securely and rotate it immediately if compromised.",
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.LOCK_TIMEOUT,
        "Another token operation is already in progress. Retry in a moment.",
        503,
      );
    }
    console.error("[agent-token] Failed to generate token", {
      installationId: auth.session.installationId,
      error: err,
    });
    return agentHealthError(
      AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
      "Failed to generate agent token. Please try again.",
      500,
    );
  }
}

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  try {
    const record = await getAgentToken(auth.session.installationId, auth.keyring, auth.redis);
    if (!record) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.TOKEN_NOT_FOUND,
        "No agent token configured for this installation",
        404,
      );
    }

    return NextResponse.json(record);
  } catch (err) {
    console.error("[agent-token] Failed to retrieve token", {
      installationId: auth.session.installationId,
      error: err,
    });
    return agentHealthError(
      AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
      "Failed to retrieve agent token. Please try again.",
      500,
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  try {
    const revoked = await revokeAgentToken(auth.session.installationId, auth.redis);
    if (!revoked) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.TOKEN_NOT_FOUND,
        "No agent token to revoke",
        404,
      );
    }

    return NextResponse.json({ revoked: true });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      return agentHealthError(
        AGENT_HEALTH_ERROR.LOCK_TIMEOUT,
        "Another token operation is already in progress. Retry in a moment.",
        503,
      );
    }
    console.error("[agent-token] Failed to revoke token", {
      installationId: auth.session.installationId,
      error: err,
    });
    return agentHealthError(
      AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
      "Failed to revoke agent token. Please try again.",
      500,
    );
  }
}
