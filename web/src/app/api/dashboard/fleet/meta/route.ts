/**
 * Form metadata for the agent config UI: the skills catalog, the engine catalog,
 * and the installation's accessible repos (for the github plugin's repo picker).
 *
 * Cookie-auth + installation required: `installation_repos` is per-installation,
 * and installationId is taken ONLY from the authenticated session — never input.
 * The repo list is BEST-EFFORT: if the installation lister fails (transient
 * GitHub/App error), we return `[]` rather than failing the whole form load. The
 * authoritative coverage check still happens fail-closed at create/patch time
 * (`resolveGithubRepos`), so a degraded `[]` here can only narrow the UI, never
 * let an agent be created against an uncovered repo.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { SKILLS_CATALOG } from "@/server/skills-catalog";
import { ENGINE_CATALOG } from "@/server/engine-catalog";
import { listInstallationRepos } from "@/server/github-installation-repos";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;
  const inst = requireInstallation(auth.session);
  if (!inst.ok) return inst.response;
  const installationId = inst.installationId;

  // Best-effort: a lister failure must not break the form — fall back to []
  // (the create/patch path re-checks coverage fail-closed, so an empty pre-fill
  // is safe). Log for ops; never surface the internal error to the client.
  let installation_repos: string[] = [];
  try {
    installation_repos = await listInstallationRepos(installationId);
  } catch (err) {
    console.warn("[fleet] meta: listInstallationRepos failed (returning [])", { installationId, error: err });
  }

  return NextResponse.json({
    skills_catalog: SKILLS_CATALOG,
    engine_catalog: ENGINE_CATALOG.map((e) => ({ id: e.id, label: e.label })),
    installation_repos,
  });
}
