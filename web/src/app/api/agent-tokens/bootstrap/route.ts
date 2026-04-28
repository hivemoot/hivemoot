/**
 * POST /api/agent-tokens/bootstrap — issue the chain-root admin
 * token via dashboard cookie auth.
 *
 * **Why a separate endpoint, not POST /api/agent-tokens?** Bootstrap
 * is the ONLY path that doesn't require a pre-existing
 * `agent_tokens.manage` bearer — it's the recovery path AND the
 * cold-start path. Per CAPABILITIES_DESIGN.md §"Bootstrap path
 * (closes guard B — blocking)": a logged-in installation admin
 * (`authenticateByokRequest`) can issue an admin-preset token; all
 * subsequent admin operations chain off that one. If the operator
 * loses their admin token, this endpoint is the recovery — cookie
 * auth always works for the installation owner.
 *
 * **Hardcoded admin preset, capped 24h expiry**: per design, bootstrap
 * tokens are NOT a parameterized issuance path. The admin preset is
 * fixed (`*` + `agent_tokens.manage`) so an operator can't accidentally
 * bootstrap a non-admin token; the 24h cap (closes guard R2 N4) limits
 * exposure window after the one-time-display flow.
 *
 * **Vercel suspension safety** (closes #505 guard R1 carry-forward
 * #3): the auth.success audit emit is AWAITED here, not fire-and-
 * forget. Bootstrap is operator-driven, low-volume (~5x lifetime per
 * installation), so the extra ~50ms latency from one Redis XADD is
 * cheaper than a `request.waitUntil` shim and avoids the entire
 * serverless-suspension race surface for the audit row.
 *
 * The mutation event (`bootstrap` action on the `:audit` stream)
 * lands ATOMICALLY inside the storage script's EVAL — same atomicity
 * guarantee as issue/revoke/etc. via the `auditContext` plumbing.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { issueAgentToken } from "@/server/agent-token-v1";
import {
  resolvePreset,
  validateName,
  CapabilityValidationError,
} from "@/server/agent-token-capabilities";
import { auditAppend } from "@/server/agent-token-v1-audit";
import {
  parseExpiresIn,
  mapV1StorageErrorToResponse,
  readJsonObject,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
} from "@/server/agent-token-v1-routes";

/** Hardcoded admin agent_role on bootstrap envelopes. Distinct from
 * worker/queen so `/api/whoami` clearly identifies bootstrap-derived
 * tokens for operators reviewing the fleet. */
const BOOTSTRAP_AGENT_ROLE = "admin";
/** Per CAPABILITIES_DESIGN.md §Bootstrap path: 24h max so the one-
 * time-display flow's exposure window is bounded. Operator MUST
 * issue a longer-lived successor admin token within the window. */
const BOOTSTRAP_MAX_EXPIRES_IN = "24h";

interface BootstrapResponse {
  /** Raw bearer (`hmt_xxx...`). Shown ONCE — no GET-after-issue path. */
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  /** GitHub login of the dashboard operator who triggered the
   * bootstrap. Surfaced so the operator can confirm the audit
   * entry attribution matches their identity. */
  bootstrappedBy: string;
  /** Static reminder string. Not parsed by clients. */
  message: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Cookie auth — `requireFresh: true` mirrors the legacy /api/agent-token
  // POST: bootstrap is mutating (creates bearer + writes envelope), so a
  // valid-but-stale session must re-authenticate per the dashboard's
  // step-up gate.
  const auth = await authenticateByokRequest(request, { requireFresh: true });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  const parsedBody = await readJsonObject(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  // ----- name (required + format-validated at the boundary) -----
  if (typeof body.name !== "string") {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_NAME,
      "name (string) is required. Pick a unique name for this bootstrap admin token, e.g. 'bootstrap-admin' or 'bootstrap-2026-04-27'.",
      400,
    );
  }
  // Pre-validate the name format at the route boundary (closes
  // #508 builder R1 #2). Without this, malformed names (e.g.
  // "Bootstrap" — capital B violates the regex) fall through to
  // issueAgentToken which throws CapabilityValidationError, and
  // mapV1StorageErrorToResponse maps that to INVALID_CAPABILITIES
  // — semantically wrong (the bad input is name, not caps).
  // Pre-validation surfaces the correct stable code AND avoids the
  // wasteful audit-emit + lock-acquire path for a guaranteed-400.
  try {
    validateName(body.name);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_NAME,
        err.message,
        400,
        { field: err.field, value: err.value },
      );
    }
    throw err;
  }

  // ----- expiresIn (default to and capped at 24h) -----
  // Operator can pass a SHORTER expiresIn if they want (e.g., "1h"
  // for a quick recovery use); reject anything longer than 24h.
  // Both `undefined` AND `null` (key absent OR explicitly nulled)
  // default to 24h — bootstrap REQUIRES a bounded expiry, so the
  // null-is-no-expiry semantics from the regular issue path are
  // intentionally remapped here.
  const expiresIn = body.expiresIn ?? BOOTSTRAP_MAX_EXPIRES_IN;
  const expiresParse = parseExpiresIn(expiresIn);
  if (!expiresParse.ok) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_EXPIRES_IN,
      expiresParse.message,
      400,
    );
  }
  // Defensive: parseExpiresIn returns expiresAt:null only for null/undefined
  // inputs, which are remapped to "24h" above — so this branch is
  // unreachable today. Pin it as an invariant in case the default
  // logic changes later.
  if (expiresParse.expiresAt === null) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.SERVER_ERROR,
      "Internal invariant violated: bootstrap default expiry not applied.",
      500,
    );
  }
  // Verify the parsed expiresAt is within 24h. parseExpiresIn caps
  // at 365d — bootstrap caps tighter. Compare against now + 24h
  // (with a small slack to account for the round-trip latency).
  const expiresAtMs = new Date(expiresParse.expiresAt).getTime();
  const maxExpiresAtMs = Date.now() + 24 * 60 * 60 * 1000 + 1000; // +1s slack
  if (expiresAtMs > maxExpiresAtMs) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_EXPIRES_IN,
      "Bootstrap admin tokens are capped at 24h (closes design guard R2 N4 — bounds the one-time-display exposure window). Issue a longer-lived successor admin token AFTER bootstrap via POST /api/agent-tokens.",
      400,
    );
  }

  // ----- capabilities (hardcoded admin preset) -----
  // No operator override. Bootstrap = full admin token = `*` + agent_tokens.manage.
  // The wildcard guard at POST /api/agent-tokens doesn't apply here
  // because bootstrap is the deliberate-opt-in path BY DEFINITION.
  let capabilities: readonly string[];
  try {
    capabilities = resolvePreset("admin");
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      // Internal invariant — admin preset must always exist. This
      // branch only fires if PRESETS is corrupted at runtime.
      console.error("[agent-tokens/bootstrap] admin preset missing", { error: err });
      return v1Error(
        AGENT_TOKENS_V1_ERROR.SERVER_ERROR,
        "Server misconfiguration",
        500,
      );
    }
    throw err;
  }

  try {
    const issued = await issueAgentToken({
      installationId,
      name: body.name,
      agent_role: BOOTSTRAP_AGENT_ROLE,
      capabilities,
      createdBy: auth.session.userLogin, // GitHub user who clicked bootstrap
      expiresAt: expiresParse.expiresAt,
      keyring: auth.keyring,
      keyVersion: auth.activeKeyVersion,
      redis: auth.redis,
      auditContext: {
        // No bearer for cookie-auth path — fingerprint stays empty
        // (per the audit schema's "Empty for bootstrap" allowance).
        // `actor: "dashboard"` distinguishes cookie-auth from bearer-
        // auth in the forensic stream; the operator's GitHub login
        // goes in detailExtras for attribution.
        operator: { fingerprint: "", name: "dashboard" },
        actionOverride: "bootstrap",
        detailExtras: {
          bootstrapped_by: auth.session.userLogin,
        },
      },
    });

    // AWAITED audit emit (not fire-and-forget) — closes #505 guard
    // R1 carry-forward #3. Vercel may suspend the function after
    // the response is sent; awaiting guarantees the auth.success
    // audit row lands before we return. Bootstrap is operator-driven
    // (~5x lifetime per installation) so the latency cost is
    // immaterial relative to the reliability gain.
    await auditAppend({
      redis: auth.redis,
      installationId,
      entry: {
        ts: new Date().toISOString(),
        // Cookie auth — no bearer fingerprint to record. The
        // bootstrapped_by field on the mutation entry's detail is
        // the canonical attribution for the dashboard user.
        fingerprint: "",
        // The auth.success row represents the CREDENTIAL that
        // authenticated this request. Bootstrap authenticated with
        // the dashboard cookie session, NOT the new token (which
        // doesn't exist until issueAgentToken returned). Closes
        // #508 builder R1 #1: previously this was set to body.name,
        // making the auth stream look like the new token had
        // authenticated before it existed. Empty string is the
        // cookie-auth marker — the SUBJECT token's name is already
        // captured by the matching `bootstrap` row on the :audit
        // (mutation) stream.
        name: "",
        action: "auth.success",
        endpoint: "POST /api/agent-tokens/bootstrap",
        required_capability: null,
        outcome: "ok",
      },
    });

    const responseBody: BootstrapResponse = {
      token: issued.token,
      name: issued.name,
      agent_role: issued.agent_role,
      capabilities: issued.capabilities,
      fingerprint: issued.fingerprint,
      expiresAt: issued.expiresAt,
      bootstrappedBy: auth.session.userLogin,
      message:
        "Bearer is shown ONCE — store it securely now. There is no GET-after-issue path. Within 24h, issue a longer-lived successor admin token via POST /api/agent-tokens (using THIS bearer) and revoke this bootstrap one — the 24h cap exists to bound the one-time-display exposure window.",
    };
    return NextResponse.json(responseBody, { status: 201 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "POST /api/agent-tokens/bootstrap",
      installationId,
      name: body.name,
    });
  }
}
