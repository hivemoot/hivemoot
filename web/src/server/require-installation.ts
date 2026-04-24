import { NextResponse } from "next/server";
import type { SetupSessionPayload } from "@/server/setup-session";

export const INSTALLATION_REQUIRED_CODE = "installation_required";

export type RequireInstallationResult =
  | { ok: true; installationId: string }
  | { ok: false; response: NextResponse };

/**
 * Narrows `session.installationId` from `string | null` to `string`.
 *
 * Sessions with a null installation id come from the "skip install, just sign
 * me in" path. Reads that only surface shared UI state can return empty or
 * "not configured" responses without calling this helper. Endpoints that
 * write per-installation data (BYOK, tasks, roles, agent tokens) must reject
 * null-installation sessions so the client can prompt the user to install
 * the GitHub App on a repo.
 */
export function requireInstallation(
  session: SetupSessionPayload,
): RequireInstallationResult {
  if (session.installationId !== null) {
    return { ok: true, installationId: session.installationId };
  }
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: "Connect the Hivemoot Bot to a repo to use this feature.",
        code: INSTALLATION_REQUIRED_CODE,
      },
      { status: 409 },
    ),
  };
}
