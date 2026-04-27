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
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { envelopeMetaKey } from "@/server/agent-token-v1";
import { auditAppend } from "@/server/agent-token-v1-audit";

/**
 * Sanitized policy projection on the public wire shape.
 *
 * **Naming convention** — wire shape is **camelCase** (`allowedRepos`,
 * `allowedPermissions`) per CAPABILITIES_DESIGN.md §`/api/whoami`
 * introspection endpoint, while the underlying envelope storage is
 * **snake_case** (`allowed_repos`, `allowed_permissions`) for backward
 * compat with the V1.5 envelope shape. The handler is the translation
 * layer — operators see camelCase, storage stays snake_case.
 *
 * Defined LOCALLY (not imported from `AgentTokenPolicy`) so that future
 * additions to the storage type aren't auto-leaked through /whoami. The
 * projection below is the only path to populate this type — adding a
 * field here MUST be paired with an explicit copy + rename in the handler.
 *
 * Returned as `null` on the response when the envelope has no `policy`
 * field at all (legacy / V1.5-pre tokens). When the policy field IS
 * present, `allowedRepos` is always defined (empty `[]` is the
 * intentional reject-all marker, per `AgentTokenPolicy`). The
 * `allowedPermissions` field is V1.6+ and is omitted from the wire
 * shape entirely when absent — operators see "no narrowing" rather
 * than "narrowing: undefined".
 */
/**
 * GitHub permission level union. Inlined (not imported from
 * agent-token.ts) to keep the wire type self-contained and decoupled
 * from the storage type — same defense-in-depth rationale as
 * `WhoamiPolicyView` itself. The values are a stable, well-known
 * GitHub-permission set; if the storage union ever expands at
 * `agent-token.ts:GitHubPermissionLevel`, the projection here
 * intentionally still narrows what the wire promises until this
 * file is updated explicitly.
 *
 * Carry-forward from #505 guard R2 N1: was `Record<string, string>`,
 * but if storage drifts (CLI bug, manual envelope edit), the
 * introspection signal would mislead operators reading /whoami.
 * Narrowing the wire type catches drift at the type boundary even
 * though GitHub rejects malformed values at mint time.
 */
type WhoamiPermissionLevel = "read" | "write" | "admin";

interface WhoamiPolicyView {
  allowedRepos: string[];
  allowedPermissions?: Record<string, WhoamiPermissionLevel>;
}

interface WhoamiResponse {
  name: string;
  agent_role: string;
  installationId: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  policy: WhoamiPolicyView | null;
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

  // Build sanitized policy projection. ONLY copy known V1.5/V1.6
  // policy fields — never let the entire envelope leak through.
  // Closes builder R1 on PR #505: the design doc requires policy
  // visibility on /whoami so operators can verify token narrowing
  // (allowedRepos for V1.5 mint scope, allowedPermissions for
  // V1.6 GitHub-permission narrowing).
  //
  // **Snake_case → camelCase translation** is intentional and
  // load-bearing. Storage shape is snake_case (envelope on Redis);
  // wire shape is camelCase (per design doc §`/api/whoami`). Don't
  // remove this rename or the public API drifts from the contract.
  //
  // `allowed_repos` is always defined when policy is set (empty []
  // is the canonical reject-all marker), so it's copied directly.
  // `allowed_permissions` is V1.6+ and conditionally spread to
  // omit the key entirely when absent rather than emit
  // `"allowedPermissions": null`.
  const policy: WhoamiPolicyView | null = auth.envelope.policy
    ? {
        allowedRepos: auth.envelope.policy.allowed_repos,
        ...(auth.envelope.policy.allowed_permissions !== undefined
          ? { allowedPermissions: auth.envelope.policy.allowed_permissions }
          : {}),
      }
    : null;

  const body: WhoamiResponse = {
    name: auth.name,
    agent_role: auth.agent_role,
    installationId: auth.installationId,
    capabilities: auth.capabilities,
    fingerprint: auth.envelope.fingerprint,
    expiresAt: auth.envelope.expiresAt,
    lastUsedAt,
    policy,
  };

  return NextResponse.json(body, { status: 200 });
}

// Suppress the "Method Not Allowed" default by explicitly
// rejecting non-GET methods. Helps operator triage when a script
// accidentally POSTs a /whoami probe.
//
// The code is `method_not_allowed` (not an auth error code) — using
// `agent_auth_v1_missing_bearer` here would be misleading since the
// failure mode is wrong-verb, not wrong-credentials. Closes drone R1
// non-blocking observation D1 on PR #505.
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      code: "method_not_allowed",
      message: "GET /api/whoami only — POST not supported",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
