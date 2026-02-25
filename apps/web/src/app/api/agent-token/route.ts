/**
 * /api/agent-token — Agent credential management
 *
 * POST   — Generate or rotate the agent-token for this installation
 * GET    — View the current agent-token (decrypted, one-time display)
 * DELETE — Revoke the current agent-token
 *
 * All endpoints require a valid setup session cookie (same auth as BYOK routes).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { generateAgentToken, getAgentToken, revokeAgentToken } from "@/server/agent-token";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

/**
 * POST /api/agent-token
 *
 * Generates a new token (201) or rotates an existing one (200).
 * Returns the raw token — the only moment it is available in plaintext.
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { installationId, userLogin } = auth.session;

  // Check if a token already exists (determines 201 vs 200)
  const existing = await getAgentToken(installationId, auth.keyring, auth.redis);
  const isRotation = existing !== null;

  let result: { token: string; fingerprint: string; createdAt: string };
  try {
    result = await generateAgentToken(
      installationId,
      userLogin,
      auth.activeKeyVersion,
      auth.keyring,
      auth.redis,
    );
  } catch (err) {
    console.error("[agent-token] Failed to generate token", { installationId, error: err });
    return agentHealthError(AGENT_HEALTH_ERROR.SERVER_ERROR, "Failed to generate agent token", 500);
  }

  return NextResponse.json(
    {
      token: result.token,
      fingerprint: result.fingerprint,
      created_at: result.createdAt,
    },
    { status: isRotation ? 200 : 201 },
  );
}

/**
 * GET /api/agent-token
 *
 * Returns the decrypted token for the current installation.
 * 404 if none has been generated yet.
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { installationId } = auth.session;

  let result: { token: string; fingerprint: string; createdAt: string } | null;
  try {
    result = await getAgentToken(installationId, auth.keyring, auth.redis);
  } catch (err) {
    console.error("[agent-token] Failed to retrieve token", { installationId, error: err });
    return agentHealthError(AGENT_HEALTH_ERROR.SERVER_ERROR, "Failed to retrieve agent token", 500);
  }

  if (!result) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.NOT_FOUND,
      "No agent token configured",
      404,
    );
  }

  return NextResponse.json({
    token: result.token,
    fingerprint: result.fingerprint,
    created_at: result.createdAt,
  });
}

/**
 * DELETE /api/agent-token
 *
 * Revokes the current agent-token. Immediately invalidates Bearer auth.
 * 404 if none exists.
 */
export async function DELETE(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { installationId } = auth.session;

  let revoked: boolean;
  try {
    revoked = await revokeAgentToken(installationId, auth.keyring, auth.redis);
  } catch (err) {
    console.error("[agent-token] Failed to revoke token", { installationId, error: err });
    return agentHealthError(AGENT_HEALTH_ERROR.SERVER_ERROR, "Failed to revoke agent token", 500);
  }

  if (!revoked) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.NOT_FOUND,
      "No agent token configured",
      404,
    );
  }

  return NextResponse.json({ revoked: true });
}
