/**
 * POST /api/github/installation-tokens
 *
 * Mints a GitHub installation access token (the `ghs_`-prefixed kind from
 * `POST /app/installations/{id}/access_tokens`) on behalf of an apiarist
 * client. Authenticated via Bearer agent token (same primitive used by
 * /api/agent-health and /api/tasks/claim).
 *
 * Status: scaffolded. Auth + body validation are real; the actual GitHub
 * App handoff (sign JWT with .pem, exchange at api.github.com, return
 * the `ghs_` token) is intentionally not wired yet — a follow-up PR adds
 * `mintInstallationToken` + the installation→repos lookup. For now this
 * endpoint short-circuits to 501 Not Implemented after a valid request,
 * so the apiarist client's transport layer can be developed and tested
 * end-to-end against a real network endpoint with real auth.
 *
 * See apiarist/DESIGN.md §11 for the full contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequest } from "@/server/agent-health-auth";

const NOT_IMPLEMENTED_BODY = {
  error: "not_implemented",
  message:
    "GitHub installation-token minting is scaffolded but the GitHub App " +
    "handoff (JWT signing + api.github.com exchange) is not yet wired. " +
    "See apiarist/DESIGN.md §11.",
} as const;

const BAD_REQUEST_BODY = {
  error: "bad_request",
  message: "Field 'repo' is required and must be a non-empty string.",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Bearer auth — same path used by /api/agent-health POST. 401 on
  // missing/invalid bearer; the underlying helper has its own response
  // shape we pass through unchanged for consistency.
  const auth = await authenticateAgentRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  // Body validation. We require `repo` even though the installation is
  // server-determined from the bearer — `repo` is required-and-verified
  // server-side per DESIGN.md §11 (defense in depth against apiary-side
  // misrouting). The membership check itself ships in the follow-up
  // along with the actual minting.
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

  // Stub response. The 501 lets the apiarist client distinguish "endpoint
  // present but not active" from "endpoint hosed" (which would surface as
  // 5xx → BACKEND_UNAVAILABLE). Once the App handoff lands, replace this
  // branch with the real mintInstallationToken call.
  return NextResponse.json(NOT_IMPLEMENTED_BODY, { status: 501 });
}
