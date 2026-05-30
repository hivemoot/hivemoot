/**
 * GET /api/fleet/desired-state — the on-prem reconciler's poll endpoint.
 *
 * Bearer-auth, requires the `fleet.read` capability. installationId comes ONLY
 * from the resolved token envelope — the route never reads it from input, so a
 * caller cannot target another tenant. Returns only this installation's roster,
 * token NAMES (never bearer values), and no secrets. `If-None-Match` against the
 * roster ETag short-circuits with 304 so steady-state polling is cheap.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { listAgents, getRosterVersion } from "@/server/fleet-store";
import { buildDesiredState, rosterEtag } from "@/server/fleet-desired-state";

function normalizeEtag(headerValue: string | null): string | null {
  if (!headerValue) return null;
  return headerValue.replace(/^W\//, "").replace(/"/g, "").trim();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateAgentRequestV1(request, { requires: "fleet.read" });
  if (!auth.ok) return auth.response;
  const installationId = auth.installationId;

  try {
    const rosterVersion = await getRosterVersion(installationId, auth.redis);
    const etag = rosterEtag(rosterVersion);

    if (normalizeEtag(request.headers.get("if-none-match")) === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: `"${etag}"` } });
    }

    const agents = await listAgents({ installationId, redis: auth.redis });
    const body = buildDesiredState({
      agents,
      rosterVersion,
      generatedAt: new Date().toISOString(),
    });
    return NextResponse.json(body, { headers: { ETag: `"${etag}"` } });
  } catch (err) {
    console.error("[fleet] desired-state failed", { installationId, error: err });
    return NextResponse.json({ code: "fleet_server_error", message: "Internal server error." }, { status: 500 });
  }
}
