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
import { requireInstallation } from "@/server/require-installation";
import {
  generateAgentToken,
  getAgentToken,
  LockTimeoutError,
  revokeAgentToken,
} from "@/server/agent-token";
import { AGENT_HEALTH_ERROR, agentHealthError } from "@/server/agent-health-error";

const EXPIRES_IN_PATTERN = /^([1-9]\d*)([mhd])$/;
const EXPIRES_IN_UNITS_MS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
} as const;
const MAX_EXPIRES_IN_MS = 365 * EXPIRES_IN_UNITS_MS.d;

type ParsedBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

function parseExpiresAt(expiresIn: unknown): { ok: true; expiresAt: string | null } | { ok: false; message: string } {
  if (expiresIn == null) return { ok: true, expiresAt: null };
  if (typeof expiresIn !== "string") {
    return { ok: false, message: "expiresIn must be a duration string like '90d'." };
  }

  const match = EXPIRES_IN_PATTERN.exec(expiresIn.trim().toLowerCase());
  if (!match) {
    return { ok: false, message: "expiresIn must use a positive integer plus m, h, or d." };
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof EXPIRES_IN_UNITS_MS;
  const durationMs = amount * EXPIRES_IN_UNITS_MS[unit];
  if (!Number.isSafeInteger(durationMs) || durationMs > MAX_EXPIRES_IN_MS) {
    return { ok: false, message: "expiresIn must be no more than 365 days." };
  }

  return { ok: true, expiresAt: new Date(Date.now() + durationMs).toISOString() };
}

async function readOptionalJsonObject(request: NextRequest): Promise<ParsedBodyResult> {
  if (request.body === null) return { ok: true, body: {} };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: agentHealthError(AGENT_HEALTH_ERROR.INVALID_JSON, "Invalid JSON body", 400),
    };
  }

  if (body == null) return { ok: true, body: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: agentHealthError(
        AGENT_HEALTH_ERROR.VALIDATION_FAILED,
        "Request body must be a JSON object.",
        400,
      ),
    };
  }

  return { ok: true, body: body as Record<string, unknown> };
}

export async function POST(request: NextRequest) {
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  try {
    const parsedBody = await readOptionalJsonObject(request);
    if (!parsedBody.ok) return parsedBody.response;

    const expiry = parseExpiresAt(parsedBody.body.expiresIn);
    if (!expiry.ok) {
      return agentHealthError(AGENT_HEALTH_ERROR.VALIDATION_FAILED, expiry.message, 400);
    }

    const token = await generateAgentToken(
      installationId,
      auth.session.userLogin,
      auth.activeKeyVersion,
      auth.keyring,
      auth.redis,
      expiry.expiresAt,
    );

    return NextResponse.json({
      token,
      fingerprint: token.slice(-8),
      expiresAt: expiry.expiresAt,
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
      installationId,
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

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  try {
    const record = await getAgentToken(installationId, auth.keyring, auth.redis);
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
      installationId,
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

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  try {
    const revoked = await revokeAgentToken(installationId, auth.redis);
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
      installationId,
      error: err,
    });
    return agentHealthError(
      AGENT_HEALTH_ERROR.SERVER_MISCONFIGURATION,
      "Failed to revoke agent token. Please try again.",
      500,
    );
  }
}
