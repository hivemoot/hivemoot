/**
 * GET /api/whoami — agent-token introspection.
 *
 * Returns the bearer's identity + capability snapshot for
 * debugging / agent-startup logging. Per CAPABILITIES_DESIGN.md
 * §`/api/whoami` introspection endpoint, this is a SNAPSHOT for
 * debugging — agents MUST NOT cache this and skip the per-call
 * middleware capability check on subsequent requests, because
 * capabilities are mutable server-side via `set-capabilities`.
 *
 * Auth model: any valid bearer is accepted (`requires: null`).
 * No capability is required to introspect oneself; that's the
 * point. The endpoint does NOT update `lastUsedAt` (passes
 * `skipLastUsedAtWrite: true`) — introspection should not have a
 * side effect that bumps usage state and skews unused-token
 * cleanup signals.
 *
 * Read side-effects:
 *   - One additional Redis read for the `:meta` hash to surface
 *     `lastUsedAt` in the response. Acceptable for an
 *     introspection endpoint that's not on a hot path.
 *
 * Write side-effects:
 *   - Audit log: emits `auth.success` to the per-installation
 *     `:auth` stream (best-effort, fire-and-forget).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAgentRequestV1,
  AGENT_AUTH_V1_ERROR,
} from "@/server/agent-token-v1-auth";
import { envelopeMetaKey } from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";

interface WhoamiResponse {
  name: string;
  agent_role: string;
  installationId: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: null,
    // /whoami is a snapshot endpoint — introspecting one's own
    // identity should NOT bump lastUsedAt (closes hivemoot reviewer
    // R2 #2 issue 4: a snapshot endpoint shouldn't have a side
    // effect on usage state).
    skipLastUsedAtWrite: true,
  });
  if (!auth.ok) return auth.response;

  // Read lastUsedAt from the separate :meta hash. This is the
  // canonical observability value — the middleware (when not
  // skipped) writes here. /whoami specifically opts out of the
  // write so the displayed value reflects the LAST authenticating
  // request (not this introspection call).
  let lastUsedAt: string | null = null;
  try {
    const metaKey = envelopeMetaKey(auth.installationId, auth.name);
    lastUsedAt = await auth.redis.hget<string>(metaKey, "lastUsedAt");
  } catch (err) {
    // Best-effort — meta read failure shouldn't fail /whoami. The
    // operator can still inspect everything else.
    console.warn("[whoami] meta read failed", err);
  }

  // Best-effort audit emit (fire-and-forget). Doesn't await — a
  // slow Redis XADD shouldn't extend the response.
  void auditAppend({
    redis: auth.redis,
    installationId: auth.installationId,
    entry: {
      ts: new Date().toISOString(),
      fingerprint: auth.envelope.fingerprint,
      name: auth.name,
      action: "auth.success",
      endpoint: "GET /api/whoami",
      required_capability: null,
      outcome: "ok",
    },
  });

  const body: WhoamiResponse = {
    name: auth.name,
    agent_role: auth.agent_role,
    installationId: auth.installationId,
    capabilities: auth.capabilities,
    fingerprint: auth.envelope.fingerprint,
    expiresAt: auth.envelope.expiresAt,
    lastUsedAt,
  };

  return NextResponse.json(body, { status: 200 });
}

// Suppress the "Method Not Allowed" default by explicitly
// rejecting non-GET methods. Helps operator triage when a script
// accidentally POSTs a /whoami probe.
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      code: AGENT_AUTH_V1_ERROR.MISSING_BEARER,
      message: "GET /api/whoami only — POST not supported",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
