/**
 * Dashboard cookie-auth wrappers around the V1 capability-token API.
 *
 * Why this exists separately from `/api/agent-tokens` (the admin-V1-bearer
 * surface): a browser dashboard operator authenticates via the
 * SETUP_SESSION_COOKIE, not via an Authorization Bearer header. The
 * existing `/api/agent-tokens` family requires a pre-existing
 * `agent_tokens.manage` bearer — a chicken-and-egg problem for
 * cold-start UX. These dashboard endpoints accept cookie auth
 * (proven installation ownership) and call the same V1 storage
 * primitives directly, so an operator can issue / list / rotate /
 * revoke V1 capability tokens entirely from the UI without ever
 * holding an admin bearer themselves.
 *
 * GET  — list tokens for the bearer's installation (metadata only,
 *        no raw bearers).
 * POST — issue a new token. Body: { name, preset?, capabilities?,
 *        expiresIn? }. Either `preset` (well-known role bundle) OR
 *        `capabilities` (explicit list); preset wins if both supplied.
 *        Response includes the raw token ONCE — no GET-after-issue.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import {
  issueAgentToken,
  listAgentTokens,
  type AgentTokenSummaryV1,
  type IssuedAgentTokenV1,
} from "@/server/agent-token-v1";
import {
  resolvePreset,
  validateName,
  validateAgentRole,
  validateCapabilityString,
  validateMintPolicyRequirement,
  expandCapabilities,
  CapabilityValidationError,
  PRESETS,
  KNOWN_CAPABILITIES,
} from "@/server/agent-token-capabilities";
import {
  parseExpiresIn,
  mapV1StorageErrorToResponse,
  readJsonObject,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
} from "@/server/agent-token-v1-routes";

// ---------------------------------------------------------------------------
// Admin-class deny list
// ---------------------------------------------------------------------------

/**
 * Presets disallowed via the dashboard issuance surface. Bypassing
 * this list would let any fresh dashboard cookie mint long-lived
 * admin-class bearers — defeating the designed split where:
 *   - `POST /api/agent-tokens/bootstrap` is the cookie-auth admin
 *     path, hardcoded to the admin preset with a 24h expiry cap
 *   - `POST /api/agent-tokens` is the chain-from-existing-admin path
 *     (admin-bearer auth, no expiry cap, can issue any preset)
 *
 * The dashboard wrapper here is intentionally non-admin so it can't
 * be confused with either of those. Closes #567 builder R1.
 */
const ADMIN_CLASS_PRESETS: ReadonlySet<string> = new Set(["admin"]);

/**
 * Presets the dashboard cannot issue because they grant
 * `installation_token.mint` and the dashboard wrapper has no
 * `policy` input surface (RFC D10 + G16; PR 645 builder pass-1).
 * Operators issuing these must go through POST /api/agent-tokens
 * with an admin bearer + explicit policy.allowedRepos.
 *
 * `apiarist` is grandfathered into the issuance gate (legacy
 * permissive) but the dashboard still hides it — apiarist tokens
 * are infrastructure-tier and shouldn't be issued from a cookie
 * session. local_queen is hidden for the same reason + the policy
 * requirement.
 */
const MINT_CAPABLE_PRESETS: ReadonlySet<string> = new Set([
  "apiarist",
  "local_queen",
]);

/**
 * Capabilities disallowed in explicit-capabilities issuance via the
 * dashboard surface. Same rationale as ADMIN_CLASS_PRESETS — minting
 * `*` (wildcard) or `agent_tokens.manage` from cookie auth with no
 * expiry cap would bypass the bootstrap/chain split.
 *
 * `installation_token.mint` is included as a defense-in-depth layer
 * on top of `validateMintPolicyRequirement` (PR 645 builder pass-2):
 * the dashboard wrapper has no policy input surface, so any mint-
 * capable token issued through it would be policy-less. Hard-deny
 * on the explicit-capabilities path closes the path entirely
 * regardless of agent_role label-laundering attempts; the policy
 * gate below is the secondary check.
 */
const ADMIN_CLASS_CAPABILITIES: ReadonlySet<string> = new Set([
  "*",
  "agent_tokens.manage",
  "installation_token.mint",
  "pull_requests.merge",
]);

// ---------------------------------------------------------------------------
// GET — list tokens for this installation
// ---------------------------------------------------------------------------

interface ListResponse {
  tokens: AgentTokenSummaryV1[];
  /** Available NON-ADMIN preset names so the UI can render an issuance
   * dropdown without round-tripping for the catalog. Admin-class
   * presets (`admin`) are filtered out — admin issuance must go
   * through `/api/agent-tokens/bootstrap` (cookie-auth, 24h cap) or
   * `/api/agent-tokens` (admin-bearer chain). */
  presets: string[];
  /** Capability vocabulary filtered to non-admin entries so the UI
   * can render a custom-selection mode (checkboxes per capability)
   * without the operator having to consult the source. The wire
   * order matches `KNOWN_CAPABILITIES` (subsystem-grouped:
   * `installation_token` → `agent_health` → `tasks` → `rooms`),
   * which is also the rendering order the UI uses for grouping
   * headers. Admin-class capabilities (`agent_tokens.manage`) are
   * excluded — same rationale as the preset filter. */
  capabilities: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;

  const installationCheck = requireInstallation(auth.session);
  if (!installationCheck.ok) return installationCheck.response;
  const installationId = installationCheck.installationId;

  try {
    const tokens = await listAgentTokens({
      installationId,
      redis: auth.redis,
    });
    const body: ListResponse = {
      tokens,
      presets: Object.keys(PRESETS).filter(
        (name) => !ADMIN_CLASS_PRESETS.has(name) && !MINT_CAPABLE_PRESETS.has(name),
      ),
      capabilities: KNOWN_CAPABILITIES.filter(
        (cap) => !ADMIN_CLASS_CAPABILITIES.has(cap),
      ),
    };
    return NextResponse.json(body);
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "GET /api/dashboard/agent-tokens",
      installationId,
    });
  }
}

// ---------------------------------------------------------------------------
// POST — issue a new token (cookie-auth)
// ---------------------------------------------------------------------------

interface IssueResponse {
  /** Raw bearer (`hmt_xxx...`). Shown ONCE — no GET-after-issue. */
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  message: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Mutating endpoint — `requireFresh: true` mirrors bootstrap and the
  // legacy /api/agent-token POST so a stale-but-valid session must
  // re-auth before issuing.
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
      "name (string) is required.",
      400,
    );
  }
  try {
    validateName(body.name);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      return v1Error(AGENT_TOKENS_V1_ERROR.INVALID_NAME, err.message, 400, {
        field: err.field,
        value: err.value,
      });
    }
    throw err;
  }

  // ----- capabilities (preset OR explicit list) -----
  // Preset wins when both are supplied. The dashboard's primary UX is
  // preset-based (operator picks a role); explicit-capabilities is
  // for power users / admin overrides.
  //
  // Admin-class is rejected on BOTH paths (preset name OR explicit
  // capability strings) — that route belongs to /api/agent-tokens/
  // bootstrap (cookie auth, 24h cap) or /api/agent-tokens (admin-
  // bearer chain). Closes #567 builder R1.
  let capabilities: readonly string[];
  let agent_role: string;
  if (typeof body.preset === "string") {
    if (ADMIN_CLASS_PRESETS.has(body.preset)) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        `Preset '${body.preset}' is admin-class and cannot be issued via the dashboard wrapper. Use POST /api/agent-tokens/bootstrap (cookie auth, 24h cap) or POST /api/agent-tokens with an existing admin bearer instead.`,
        400,
        { field: "preset", value: body.preset },
      );
    }
    if (MINT_CAPABLE_PRESETS.has(body.preset)) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        `Preset '${body.preset}' is mint-capable (grants installation_token.mint) and cannot be issued from the dashboard — the dashboard wrapper has no policy input surface, and RFC D10 / G16 require policy.allowedRepos for mint-capable tokens. Use POST /api/agent-tokens with an admin bearer + policy: { allowedRepos: ['owner/repo', ...] } instead.`,
        400,
        { field: "preset", value: body.preset },
      );
    }
    try {
      capabilities = resolvePreset(body.preset);
      agent_role = body.preset;
    } catch (err) {
      if (err instanceof CapabilityValidationError) {
        return v1Error(
          AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
          err.message,
          400,
          { field: err.field, value: err.value },
        );
      }
      throw err;
    }
  } else if (Array.isArray(body.capabilities)) {
    if (body.capabilities.length === 0) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        "capabilities must be a non-empty array (or supply `preset`).",
        400,
      );
    }
    try {
      for (const c of body.capabilities) validateCapabilityString(c);
    } catch (err) {
      if (err instanceof CapabilityValidationError) {
        return v1Error(
          AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
          err.message,
          400,
          { field: err.field, value: err.value },
        );
      }
      throw err;
    }
    // Admin-class capabilities (`*`, `agent_tokens.manage`,
    // `installation_token.mint`) blocked here too — explicit-list
    // path can't sneak past the preset filter.
    //
    // Order matters: detect bare-`*` FIRST (so error.value is `*`
    // rather than the first cap `*` would expand to). The dashboard
    // never wants to issue a bare-wildcard token regardless of
    // expansion semantics; surfacing `*` as the offending value is
    // the operator-readable signal.
    if ((body.capabilities as readonly string[]).includes("*")) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        "Capability '*' is admin-class and cannot be issued via the dashboard wrapper. Use POST /api/agent-tokens/bootstrap (cookie auth, 24h cap) or POST /api/agent-tokens with an existing admin bearer instead.",
        400,
        { field: "capabilities", value: "*" },
      );
    }
    // Wildcard-aware admin-class detection (PR 645 builder pass-3
    // follow-up B1): an earlier literal `.has(c)` check missed
    // wildcard forms like `installation_token.*` (which expands to
    // mint at request time). Now we expand the proposed capability
    // list and check whether any admin-class cap is reachable.
    const proposedExpanded = expandCapabilities(
      body.capabilities as readonly string[],
    );
    for (const denied of ADMIN_CLASS_CAPABILITIES) {
      if (proposedExpanded.has(denied)) {
        return v1Error(
          AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
          `Capability '${denied}' is admin-class and cannot be issued via the dashboard wrapper (this includes wildcard forms like 'installation_token.*' that expand to '${denied}'). Use POST /api/agent-tokens/bootstrap (cookie auth, 24h cap) or POST /api/agent-tokens with an existing admin bearer instead.`,
          400,
          { field: "capabilities", value: denied },
        );
      }
    }
    capabilities = body.capabilities as readonly string[];
    // When capabilities are supplied explicitly, default agent_role to
    // the name. Operators can still override via body.agent_role.
    agent_role = typeof body.agent_role === "string" ? body.agent_role : body.name;
  } else {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
      `Either \`preset\` (one of: ${Object.keys(PRESETS)
        .filter((name) => !ADMIN_CLASS_PRESETS.has(name))
        .join(", ")}) or \`capabilities\` (non-empty array) is required.`,
      400,
    );
  }

  try {
    validateAgentRole(agent_role);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      return v1Error(AGENT_TOKENS_V1_ERROR.INVALID_AGENT_ROLE, err.message, 400, {
        field: err.field,
        value: err.value,
      });
    }
    throw err;
  }

  // ----- expiresIn (optional; null = no expiry) -----
  const expiresParse = parseExpiresIn(body.expiresIn);
  if (!expiresParse.ok) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_EXPIRES_IN,
      expiresParse.message,
      400,
    );
  }

  // ----- mint-capable issuance gate (PR 645 builder pass-1 B1) -----
  // The dashboard wrapper does not accept a `policy` field — the
  // structured-policy UX is API-path only. Mint-capable presets
  // (today: local_queen) therefore cannot be issued from the
  // dashboard; operators must use POST /api/agent-tokens with an
  // admin bearer + explicit policy.allowedRepos.
  const dashboardMintGate = validateMintPolicyRequirement({
    capabilities,
    presetName: typeof body.preset === "string" ? body.preset : null,
    policy: null,
  });
  if (!dashboardMintGate.ok) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_POLICY,
      "The dashboard cannot issue mint-capable tokens (no policy " +
        "input surface). Use POST /api/agent-tokens with an admin " +
        "bearer and policy: { allowedRepos: ['owner/repo', ...] } " +
        "instead. " +
        dashboardMintGate.message,
      400,
    );
  }

  // ----- issue -----
  let issued: IssuedAgentTokenV1;
  try {
    issued = await issueAgentToken({
      installationId,
      name: body.name,
      agent_role,
      capabilities,
      createdBy: auth.session.userLogin,
      expiresAt: expiresParse.expiresAt,
      keyring: auth.keyring,
      keyVersion: auth.activeKeyVersion,
      redis: auth.redis,
      auditContext: {
        // Cookie-auth path — no bearer fingerprint to record, so the
        // operator slot uses the same `fingerprint: ""`, `name:
        // "dashboard"` convention as bootstrap. The GitHub login goes
        // in detailExtras so the forensic stream still attributes the
        // mutation to a human identity.
        operator: { fingerprint: "", name: "dashboard" },
        detailExtras: { issued_by: auth.session.userLogin },
      },
    });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "POST /api/dashboard/agent-tokens",
      installationId,
      name: body.name,
    });
  }

  // Audit row already landed atomically inside issueAgentToken via
  // auditContext above — no separate auditAppend needed here.

  const response: IssueResponse = {
    token: issued.token,
    name: issued.name,
    agent_role: issued.agent_role,
    capabilities: [...issued.capabilities],
    fingerprint: issued.fingerprint,
    expiresAt: issued.expiresAt,
    message:
      "Store this token securely — it will NOT be shown again. Rotate immediately if compromised.",
  };
  return NextResponse.json(response);
}
