/**
 * POST / GET / DELETE  /api/agent-token
 *
 * Manages per-installation agent bearer tokens used to authenticate health
 * reports. All three methods require a valid setup session (cookie auth).
 *
 * POST   — Generate a new token (rotates if one exists). Returns the raw
 *          token once — it cannot be retrieved again.
 * GET    — Return non-sensitive metadata (fingerprint, createdAt).
 * DELETE — Revoke the token.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import {
  generateAgentToken,
  getAgentTokenMeta,
  revokeAgentToken,
} from "@/server/agent-token";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

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
    message: "Store this token securely — it cannot be retrieved again.",
  });
}

export async function GET(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const meta = await getAgentTokenMeta(auth.session.installationId, auth.redis);
  if (!meta) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.TOKEN_NOT_FOUND,
      "No agent token configured for this installation",
      404,
    );
  }

  return NextResponse.json(meta);
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const revoked = await revokeAgentToken(auth.session.installationId, auth.redis);
  if (!revoked) {
    return agentHealthError(
      AGENT_HEALTH_ERROR.TOKEN_NOT_FOUND,
      "No agent token to revoke",
      404,
    );
  }

  return NextResponse.json({ revoked: true });
}
