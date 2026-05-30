/**
 * Repo-coverage authorization for agent registration.
 *
 * A tenant may only register an agent for a repo their GitHub App installation
 * actually covers. We verify this server-side at create time and FAIL CLOSED:
 * if the App is not installed on the repo (or we can't prove coverage), no
 * agent is created and no token is issued.
 *
 * The check uses an App JWT against `GET /repos/{owner}/{repo}/installation`,
 * which returns the installation that covers the repo (or 404 when the App is
 * not installed there). We compare its id to the caller's installation id so a
 * repo covered by a DIFFERENT installation is also rejected.
 */

import { validateEnv } from "@/server/env";
import { generateAppJwt } from "@/server/github-auth";

const GITHUB_API_BASE = "https://api.github.com";

export type RepoCoverageResult =
  | { ok: true }
  /** App is not installed on this repo for the caller's installation. → 403 */
  | { ok: false; reason: "not_covered"; message: string }
  /** We could not prove coverage (misconfig / GitHub error). Fail closed. → 503 */
  | { ok: false; reason: "check_failed"; message: string };

type Fetcher = typeof fetch;

interface InstallationRef {
  id?: number;
}

/**
 * Returns `{ ok: true }` only when the caller's installation provably covers
 * `repo`. Never fail-open: any uncertainty maps to `check_failed` (503 at the
 * route), and a missing/foreign installation maps to `not_covered` (403).
 */
export async function assertRepoCoveredByInstallation(args: {
  installationId: string;
  repo: string;
  fetcher?: Fetcher;
}): Promise<RepoCoverageResult> {
  const slash = args.repo.indexOf("/");
  if (slash <= 0 || slash === args.repo.length - 1) {
    return { ok: false, reason: "not_covered", message: `Malformed repo '${args.repo}'.` };
  }
  const owner = args.repo.slice(0, slash);
  const name = args.repo.slice(slash + 1);

  const env = validateEnv();
  if (!env.ok || !env.config.githubAppId || !env.config.githubAppPrivateKey) {
    return { ok: false, reason: "check_failed", message: "GitHub App is not configured." };
  }

  let jwt: string;
  try {
    jwt = generateAppJwt(env.config.githubAppId, env.config.githubAppPrivateKey);
  } catch (err) {
    console.error("[fleet] generateAppJwt failed during repo-coverage check", err);
    return { ok: false, reason: "check_failed", message: "Could not sign the App JWT." };
  }

  const fetcher = args.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
  } catch (err) {
    console.error("[fleet] repo-coverage GitHub fetch failed", err);
    return { ok: false, reason: "check_failed", message: "Could not reach GitHub to verify repo access." };
  }

  if (response.status === 404) {
    return {
      ok: false,
      reason: "not_covered",
      message: `The Hivemoot Bot is not installed on '${args.repo}'. Install it on that repo, then try again.`,
    };
  }
  if (response.status !== 200) {
    // 401/403/5xx — never interpret as "covered". Fail closed.
    console.warn("[fleet] repo-coverage check non-200", { repo: args.repo, status: response.status });
    return { ok: false, reason: "check_failed", message: "Could not verify repo access right now. Try again shortly." };
  }

  let body: InstallationRef;
  try {
    body = (await response.json()) as InstallationRef;
  } catch {
    return { ok: false, reason: "check_failed", message: "Unexpected response while verifying repo access." };
  }

  if (typeof body.id !== "number" || String(body.id) !== args.installationId) {
    // Repo is covered by a different installation than the caller's.
    return {
      ok: false,
      reason: "not_covered",
      message: `'${args.repo}' is covered by a different installation than yours.`,
    };
  }

  return { ok: true };
}
