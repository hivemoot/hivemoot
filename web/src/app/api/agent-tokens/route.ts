/**
 * POST /api/agent-tokens — issue a new agent token (V1 envelope)
 * GET  /api/agent-tokens — list this installation's tokens
 *
 * Auth: bearer token with `agent_tokens.manage` capability (admin
 * preset, or explicit `--capabilities` including that string). The
 * bootstrap admin token (B.1.d-iv) is the chain root; subsequent
 * admin tokens are issued from that one.
 *
 * **Wire shape**: camelCase on request + response (`allowedRepos`,
 * `allowedPermissions`); storage stays snake_case. Translation
 * happens in `agent-token-v1-routes.ts` helpers.
 *
 * **Audit**: issue mutations land atomically in the `:audit` stream
 * via the storage script's `auditEntry` slot — no fire-and-forget
 * gap. Auth events (success/failure) emit fire-and-forget via
 * `auditAppend` to the `:auth` stream, mirroring the /whoami pattern.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAgentRequestV1,
  loadV1MintKeyring,
} from "@/server/agent-token-v1-auth";
import {
  issueAgentToken,
  listAgentTokens,
} from "@/server/agent-token-v1";
import {
  isKnownPreset,
  resolvePreset,
  validateName,
  validateAgentRole,
  validateMintPolicyRequirement,
  CapabilityValidationError,
} from "@/server/agent-token-capabilities";
import { auditAppend } from "@/server/agent-token-v1-audit";
import {
  parseExpiresIn,
  parseV1RequestPolicy,
  projectV1ResponsePolicy,
  projectV1TokenSummary,
  mapV1StorageErrorToResponse,
  readJsonObject,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
  type V1ResponsePolicyView,
  type V1TokenSummaryView,
} from "@/server/agent-token-v1-routes";

const REQUIRED_CAPABILITY = "agent_tokens.manage";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface IssueResponse {
  /** Raw bearer (`hmt_xxx...`). Shown ONCE — operators MUST persist
   * it now; storage holds only the encrypted ciphertext + a SHA-256
   * hash for reverse lookup. There's no GET-after-issue path. */
  token: string;
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  expiresAt: string | null;
  policy: V1ResponsePolicyView | null;
  /** Operator reminder. Static string; not parsed by clients. */
  message: string;
}

interface ListResponse {
  tokens: V1TokenSummaryView[];
}

// ---------------------------------------------------------------------------
// POST /api/agent-tokens — issue
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: REQUIRED_CAPABILITY,
  });
  if (!auth.ok) return auth.response;

  const keyringResult = loadV1MintKeyring();
  if (!keyringResult.ok) return keyringResult.response;

  const parsedBody = await readJsonObject(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  // ----- name + agent_role -----
  if (typeof body.name !== "string") {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_NAME,
      "name (string) is required.",
      400,
    );
  }
  if (typeof body.agent_role !== "string") {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_AGENT_ROLE,
      "agent_role (string) is required. Per CAPABILITIES_DESIGN.md, agent_role is REQUIRED on issue — no implicit default.",
      400,
    );
  }
  try {
    validateName(body.name);
    validateAgentRole(body.agent_role);
  } catch (err) {
    if (err instanceof CapabilityValidationError) {
      const code =
        err.field === "name"
          ? AGENT_TOKENS_V1_ERROR.INVALID_NAME
          : AGENT_TOKENS_V1_ERROR.INVALID_AGENT_ROLE;
      return v1Error(code, err.message, 400, {
        field: err.field,
        value: err.value,
      });
    }
    throw err;
  }
  const name = body.name;
  const agent_role = body.agent_role;

  // ----- capabilities (preset OR explicit list) -----
  let capabilities: readonly string[];
  if (body.preset !== undefined) {
    if (body.capabilities !== undefined) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        "preset and capabilities are mutually exclusive — pass one or the other.",
        400,
      );
    }
    if (typeof body.preset !== "string" || !isKnownPreset(body.preset)) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_PRESET,
        `preset must be one of the known names (got ${JSON.stringify(body.preset)}).`,
        400,
      );
    }
    capabilities = resolvePreset(body.preset);
  } else if (Array.isArray(body.capabilities)) {
    if (body.capabilities.length === 0) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        "capabilities must contain ≥1 entry — refusing to issue an empty-capability token (would be permanently 401).",
        400,
      );
    }
    for (const c of body.capabilities) {
      if (typeof c !== "string") {
        return v1Error(
          AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
          "capabilities entries must be strings.",
          400,
        );
      }
    }
    capabilities = body.capabilities as string[];
  } else {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
      "Pass either preset (named bundle) or capabilities (string[]).",
      400,
    );
  }

  // ----- bare-`*` opt-in (closes design § Wildcard) -----
  // Bare `*` granted by accident is the most dangerous shape; the
  // CLI defaults to rejecting it and the API mirrors that here.
  // Operators who want a true admin token must set
  // `allowWildcards: true` AND list `*` explicitly. `agent_tokens.manage`
  // is NOT included by `*` — they're separate caps for a reason.
  const allowWildcards = body.allowWildcards === true;
  if (!allowWildcards) {
    for (const c of capabilities) {
      if (c === "*") {
        return v1Error(
          AGENT_TOKENS_V1_ERROR.WILDCARD_NOT_ALLOWED,
          "Bare '*' capability requires allowWildcards: true (deliberate opt-in per design — bare wildcards are the most dangerous shape).",
          400,
        );
      }
    }
  }

  // ----- expiresIn → expiresAt -----
  const expiresParse = parseExpiresIn(body.expiresIn);
  if (!expiresParse.ok) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_EXPIRES_IN,
      expiresParse.message,
      400,
    );
  }

  // ----- policy (camelCase wire → snake_case storage) -----
  const policyParse = parseV1RequestPolicy(body.policy);
  if (!policyParse.ok) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_POLICY,
      policyParse.message,
      400,
    );
  }

  // ----- mint-capable issuance gate (PR 645 builder pass-1 B1) -----
  // Tokens granting installation_token.mint for the new local_queen
  // role must ship with policy.allowedRepos. Legacy apiarist is
  // exempt. See `validateMintPolicyRequirement` rationale.
  const mintGate = validateMintPolicyRequirement({
    capabilities,
    agentRole: agent_role,
    presetName: typeof body.preset === "string" ? body.preset : null,
    policy: policyParse.policy ?? null,
  });
  if (!mintGate.ok) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.INVALID_POLICY,
      mintGate.message,
      400,
    );
  }

  // Storage builds the audit entry internally now (closes #506
  // builder R1 #3 — entry construction inside the lock window so
  // the new token's fingerprint can be included in detail and the
  // entry lands atomically with the envelope write).
  try {
    const issued = await issueAgentToken({
      installationId: auth.installationId,
      name,
      agent_role,
      capabilities,
      createdBy: auth.name, // operator's token name as createdBy
      expiresAt: expiresParse.expiresAt,
      ...(policyParse.policy ? { policy: policyParse.policy } : {}),
      keyring: keyringResult.keyring,
      keyVersion: keyringResult.keyVersion,
      redis: auth.redis,
      auditContext: {
        operator: {
          fingerprint: auth.envelope.fingerprint,
          name: auth.name,
        },
      },
    });

    // Auth-success audit (fire-and-forget; same pattern as /whoami).
    void auditAppend({
      redis: auth.redis,
      installationId: auth.installationId,
      entry: {
        ts: new Date().toISOString(),
        fingerprint: auth.envelope.fingerprint,
        name: auth.name,
        action: "auth.success",
        endpoint: "POST /api/agent-tokens",
        required_capability: REQUIRED_CAPABILITY,
        outcome: "ok",
      },
    });

    const responseBody: IssueResponse = {
      token: issued.token,
      name: issued.name,
      agent_role: issued.agent_role,
      capabilities: issued.capabilities,
      fingerprint: issued.fingerprint,
      expiresAt: issued.expiresAt,
      policy: projectV1ResponsePolicy(policyParse.policy ?? null),
      message:
        "Bearer is shown ONCE — store it securely now. There is no GET-after-issue path.",
    };
    return NextResponse.json(responseBody, { status: 201 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "POST /api/agent-tokens",
      installationId: auth.installationId,
      name,
    });
  }
}

// ---------------------------------------------------------------------------
// GET /api/agent-tokens — list
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, {
    requires: REQUIRED_CAPABILITY,
  });
  if (!auth.ok) return auth.response;

  try {
    const summaries = await listAgentTokens({
      installationId: auth.installationId,
      redis: auth.redis,
    });

    void auditAppend({
      redis: auth.redis,
      installationId: auth.installationId,
      entry: {
        ts: new Date().toISOString(),
        fingerprint: auth.envelope.fingerprint,
        name: auth.name,
        action: "auth.success",
        endpoint: "GET /api/agent-tokens",
        required_capability: REQUIRED_CAPABILITY,
        outcome: "ok",
      },
    });

    const responseBody: ListResponse = {
      tokens: summaries.map(projectV1TokenSummary),
    };
    return NextResponse.json(responseBody, { status: 200 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "GET /api/agent-tokens",
      installationId: auth.installationId,
    });
  }
}
