/**
 * POST /api/github/installation-tokens
 *
 * Mints a GitHub installation access token (the `ghs_`-prefixed kind from
 * `POST /app/installations/{id}/access_tokens`) on behalf of an apiarist
 * client. Authenticated via Bearer agent token (same primitive used by
 * /api/agent-health and /api/tasks/claim).
 *
 * The actual GitHub handoff lives in `@/server/github-installation-token`;
 * this route is just request validation, error mapping to wire codes, and
 * audit logging. See `apiarist/DESIGN.md` §11 for the full contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequest } from "@/server/agent-health-auth";
import { validateEnv } from "@/server/env";
import {
  mintInstallationToken,
  MintError,
} from "@/server/github-installation-token";

const BAD_REQUEST_BODY = {
  error: "bad_request",
  message: "Field 'repo' is required and must be a non-empty string.",
} as const;

const SERVER_MISCONFIG_BODY = {
  error: "server_misconfiguration",
  message:
    "Backend GitHub App credential not configured. " +
    "Set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY env vars.",
} as const;

const INTERNAL_BODY = {
  error: "internal_error",
  message: "Unexpected error during mint; see backend logs for details.",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Bearer auth — same path used by /api/agent-health POST. 401 on
  // missing/invalid bearer; the underlying helper has its own response
  // shape we pass through unchanged for consistency. Auth runs BEFORE
  // any body inspection so an unauthenticated caller learns nothing
  // about the body-validation contract.
  const auth = await authenticateAgentRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  // Body validation. We require `repo` even though the installation is
  // server-determined from the bearer — `repo` is required-and-verified
  // server-side per DESIGN.md §11 (defense in depth against apiary-side
  // misrouting). The actual coverage check happens at GitHub on mint:
  // a repo not in the installation surfaces as 403 from
  // mintInstallationToken (InstallationNotCoverageError).
  //
  // `agent_id` is OPTIONAL and audit-only in V1: a caller-asserted
  // identifier the backend logs but does not trust for authorization.
  // The future strong-security model (DESIGN.md §11 "Future hardening:
  // host-attested agent identity binding") will make this mandatory
  // and host-attested, but until then it's a forward-compatible field
  // that adds telemetry without changing the trust model.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(BAD_REQUEST_BODY, { status: 400 });
  }
  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { repo?: unknown }).repo !== "string" ||
    (body as { repo: string }).repo.trim() === ""
  ) {
    return NextResponse.json(BAD_REQUEST_BODY, { status: 400 });
  }
  const repo = (body as { repo: string }).repo.trim();

  // Optional agent_id: type-check only. Backend doesn't trust the
  // value; logs it for audit. Reject only on wrong TYPE so a typo
  // (`agent_id: 123`) surfaces fast; absent is fine.
  const agentIdRaw = (body as { agent_id?: unknown }).agent_id;
  if (agentIdRaw !== undefined && typeof agentIdRaw !== "string") {
    return NextResponse.json(BAD_REQUEST_BODY, { status: 400 });
  }
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw : null;

  // ---------------------------------------------------------------------
  // Token-policy enforcement (V1.5)
  //
  // Per apiarist DESIGN.md §10's "V1 token-policy gap" row: the agent
  // token's policy (if set) constrains which repos this token may mint
  // for. Three cases:
  //
  //   1. policy === undefined (legacy token, created pre-V1.5) →
  //      log a warning so operators see we're running with a
  //      legacy-permissive token, then defer to GitHub's installation
  //      grant for the coverage check (current V1 behavior). Preserves
  //      compatibility with existing tokens during the migration window.
  //
  //   2. policy.allowed_repos includes `repo` → proceed with mint.
  //
  //   3. policy.allowed_repos does NOT include `repo` → reject 403
  //      with policy_violation so apiarist's daemon surfaces it as
  //      BACKEND_FORBIDDEN with a clear remediation message.
  //
  // Request scope ⊆ token policy is enforced HERE; the
  // (token policy) ⊆ (installation grant) check still happens at
  // GitHub (mint endpoint will return 403 if the policy somehow grants
  // more than the installation does — defense in depth, not expected
  // in practice if policies are set sensibly).
  if (auth.policy === undefined) {
    console.warn("[installation-tokens] legacy-permissive token used (no policy)", {
      installationId: auth.installationId,
      repo,
      agentId,
      remediation:
        "set a per-token policy via setAgentTokenPolicy to enforce request ⊆ policy ⊆ installation grant",
    });
  } else if (!auth.policy.allowed_repos.includes(repo)) {
    console.warn("[installation-tokens] policy violation: repo not in allowed_repos", {
      installationId: auth.installationId,
      repo,
      agentId,
      allowedReposCount: auth.policy.allowed_repos.length,
    });
    return NextResponse.json(
      {
        error: "policy_violation",
        message:
          `Repo '${repo}' is not in the agent token's allowed_repos policy. ` +
          "Either add it to the token's policy via setAgentTokenPolicy, " +
          "or rotate to a token whose policy includes this repo.",
      },
      { status: 403 },
    );
  }

  // Verify backend credentials are present BEFORE attempting the mint
  // so a server misconfig surfaces as 503 (apiarist sees it as
  // BACKEND_UNAVAILABLE) rather than as a 502 from the upstream call.
  const env = validateEnv();
  if (!env.ok) {
    console.error("[installation-tokens] env validation failed", {
      missing: env.missing,
    });
    return NextResponse.json(SERVER_MISCONFIG_BODY, { status: 503 });
  }
  const { githubAppId, githubAppPrivateKey } = env.config;
  if (!githubAppId || !githubAppPrivateKey) {
    console.error("[installation-tokens] App credential env missing", {
      hasAppId: Boolean(githubAppId),
      hasPrivateKey: Boolean(githubAppPrivateKey),
    });
    return NextResponse.json(SERVER_MISCONFIG_BODY, { status: 503 });
  }

  // The actual mint. Errors are typed (subclasses of MintError); each
  // carries the HTTP status we should surface and a `errorCode` field
  // for structured logging + machine-readable error envelopes on the
  // wire (apiarist's daemon parses `error` as the discriminator).
  const start = Date.now();
  try {
    const tokenResponse = await mintInstallationToken({
      installationId: auth.installationId,
      repo,
      appId: githubAppId,
      appPrivateKeyPem: githubAppPrivateKey,
    });
    // Audit log: success. Token VALUE never logged — only metadata.
    // hashed_token is the audit-correlation handle (sha256/base64 of
    // the token); operators can match this log line to apiarist's
    // mint logs without either side holding the secret. expires_at
    // is logged so operators can correlate with cache TTL observations
    // downstream.
    console.log("[installation-tokens] minted", {
      installationId: auth.installationId,
      repo,
      agentId,
      hashedToken: tokenResponse.hashed_token,
      expiresAt: tokenResponse.expires_at,
      latencyMs: Date.now() - start,
    });
    return NextResponse.json(tokenResponse, { status: 200 });
  } catch (err) {
    if (err instanceof MintError) {
      // Audit log: typed mint failure. Structured fields make it easy
      // to alert on specific failure classes (e.g. spike in
      // installation_not_coverage = an operator misconfigured an agent).
      // Logs `internalDetail` (server-side context — may carry raw
      // upstream error text including, in principle, PEM bytes if a
      // future Node openssl error puts them in `.message`) rather
      // than `message` (the sanitized wire-safe string emitted in
      // the response below). Defense in depth: even if the upstream
      // error grows a sensitive field, the wire response stays a
      // fixed string and only the backend journal sees the detail.
      console.warn("[installation-tokens] mint failed", {
        installationId: auth.installationId,
        repo,
        agentId,
        errorCode: err.errorCode,
        internalDetail: err.internalDetail,
        httpStatus: err.httpStatus,
        latencyMs: Date.now() - start,
      });
      return NextResponse.json(
        { error: err.errorCode, message: err.message },
        { status: err.httpStatus },
      );
    }
    // Unexpected — neither a MintError nor an auth/validation issue.
    // Log full stack for debugging; surface as 500 so apiarist sees it
    // as BACKEND_UNAVAILABLE-with-retry rather than as a typed code.
    console.error("[installation-tokens] unexpected error", {
      installationId: auth.installationId,
      repo,
      agentId,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    });
    return NextResponse.json(INTERNAL_BODY, { status: 500 });
  }
}
