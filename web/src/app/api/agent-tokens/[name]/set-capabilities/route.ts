/**
 * POST /api/agent-tokens/{name}/set-capabilities — replace the
 * capability list on an existing token.
 *
 * Auth: bearer token with `agent_tokens.manage`.
 *
 * Body modes (mutually exclusive):
 *   1. `{ capabilities: [...] }` — full-replace with the given list.
 *   2. `{ preset: "worker" }` — replace with the named preset's
 *      bundled caps (looked up via `resolvePreset`).
 *
 * **Why API doesn't support add/remove**: the design doc shows
 * `--add` / `--remove` CLI flags, but the API takes only the FULL
 * new list. The CLI computes the new list locally (GET-then-POST)
 * before calling the API. This avoids a TOCTOU window where a
 * concurrent set-capabilities elsewhere would make the add/remove
 * math operate on stale state. Closes design § "set-capabilities
 * — `--add` / `--remove` supported" by clarifying that the
 * incremental ergonomics live in the CLI, not the API.
 *
 * **Self-modify guard**: refuses to change capabilities on the
 * bearer's own token — losing `agent_tokens.manage` mid-flight
 * locks the operator out (the same trap as self-revoke).
 *
 * **Bare-`*` opt-in**: same as POST /api/agent-tokens — bare `*`
 * needs `allowWildcards: true`. Operators rotating an admin
 * token's caps must still pass the wildcard gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { setAgentTokenCapabilities } from "@/server/agent-token-v1";
import {
  isKnownPreset,
  resolvePreset,
  bearerHasCapability,
} from "@/server/agent-token-capabilities";
import { auditAppend } from "@/server/agent-token-v1-audit";
import {
  projectV1TokenSummary,
  mapV1StorageErrorToResponse,
  readJsonObject,
  v1Error,
  AGENT_TOKENS_V1_ERROR,
  type V1TokenSummaryView,
} from "@/server/agent-token-v1-routes";

const REQUIRED_CAPABILITY = "agent_tokens.manage";

interface SetCapabilitiesResponse {
  /** Updated summary view of the token. Caller can compare
   * `capabilities` here against what they sent to confirm the
   * canonical post-mutation state. */
  token: V1TokenSummaryView;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name: rawName } = await context.params;

  const auth = await authenticateAgentRequestV1(request, {
    requires: REQUIRED_CAPABILITY,
  });
  if (!auth.ok) return auth.response;

  // Path-name validation runs as part of `setAgentTokenCapabilities`
  // (it calls `validateName` internally), so we skip duplicating it
  // here — but the self-op guard NEEDS the raw name to compare against
  // `auth.name` before storage validation.
  const name = rawName;

  if (auth.name === name) {
    return v1Error(
      AGENT_TOKENS_V1_ERROR.SELF_OP_REFUSED,
      "Refusing to modify capabilities on the bearer's own token — could lock you out mid-flight (e.g. by removing 'agent_tokens.manage'). Issue a successor with the new caps, switch to it, then revoke this one.",
      409,
      { name },
    );
  }

  const parsedBody = await readJsonObject(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

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
        "capabilities must contain ≥1 entry — refusing to set empty caps (would be permanently 401).",
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

  // Bare-`*` opt-in (same shape as POST /api/agent-tokens).
  const allowWildcards = body.allowWildcards === true;
  if (!allowWildcards) {
    for (const c of capabilities) {
      if (c === "*") {
        return v1Error(
          AGENT_TOKENS_V1_ERROR.WILDCARD_NOT_ALLOWED,
          "Bare '*' capability requires allowWildcards: true.",
          400,
        );
      }
    }
  }

  // Mint-capable transition gate (PR 645 builder pass-1 B1, pass-3
  // wildcard-aware).
  //
  // set-capabilities only changes capabilities, not policy. If the
  // operation transitions a token INTO a mint-capable shape, we
  // can't validate the policy without a separate fetch — and even
  // then there's a race vs concurrent policy edits. Refuse the
  // transition entirely; operators must issue a NEW token with the
  // right policy + revoke the old one.
  //
  // Wildcard-aware (pass-3 follow-up): use bearerHasCapability
  // instead of literal `.includes`. Otherwise an operator could
  // submit `capabilities: ["installation_token.*"]` or `["*"]` to
  // transition a token into mint-capable shape without tripping
  // the gate, but still satisfy the request-time auth check.
  //
  // Legacy apiarist + admin presets are exempt to mirror the
  // issue-time gate's carve-outs.
  const transitionsToMint = bearerHasCapability(
    capabilities,
    "installation_token.mint",
  );
  if (transitionsToMint) {
    const isLegacyPreset =
      body.preset === "apiarist" || body.preset === "admin";
    if (!isLegacyPreset) {
      return v1Error(
        AGENT_TOKENS_V1_ERROR.INVALID_CAPABILITIES,
        "Refusing to transition a token to a mint-capable shape via " +
          "set-capabilities — set-capabilities does not accept a " +
          "policy field, so the resulting token would lack the D10 " +
          "policy bound required by RFC D10 / G16. Issue a new token " +
          "via POST /api/agent-tokens with policy: { allowedRepos, " +
          "allowedPermissions } and revoke this one instead. (This " +
          "applies to wildcard forms like 'installation_token.*' and " +
          "'*' too — they expand to 'installation_token.mint' at " +
          "request time.)",
        400,
      );
    }
  }

  // Storage builds the audit entry internally with `from` taken
  // from the LOCKED envelope state. Closes #506 builder R1 #3:
  // a previous pattern that pre-read `from` at the route layer
  // could race a concurrent set-capabilities and produce a
  // misleading `from: A, to: C` row when actual change was B → C.
  try {
    const updated = await setAgentTokenCapabilities({
      installationId: auth.installationId,
      name,
      capabilities,
      redis: auth.redis,
      auditContext: {
        operator: { fingerprint: auth.envelope.fingerprint, name: auth.name },
      },
    });

    void auditAppend({
      redis: auth.redis,
      installationId: auth.installationId,
      entry: {
        ts: new Date().toISOString(),
        fingerprint: auth.envelope.fingerprint,
        name: auth.name,
        action: "auth.success",
        endpoint: "POST /api/agent-tokens/{name}/set-capabilities",
        required_capability: REQUIRED_CAPABILITY,
        outcome: "ok",
      },
    });

    const responseBody: SetCapabilitiesResponse = {
      token: projectV1TokenSummary(updated),
    };
    return NextResponse.json(responseBody, { status: 200 });
  } catch (err) {
    return mapV1StorageErrorToResponse(err, {
      route: "POST /api/agent-tokens/{name}/set-capabilities",
      installationId: auth.installationId,
      name,
    });
  }
}
