/**
 * Lists every repository a GitHub App installation can access, as
 * `owner/name` strings. This is the source of truth for an agent's default
 * repo set: the fleet "create agent" flow defaults an agent to ALL repos the
 * installation covers (and lets the operator narrow from there).
 *
 * Flow:
 *   1. Mint an installation access token covering the WHOLE installation (no
 *      `repositories` narrowing in the request body — an install token with no
 *      repo narrowing is scoped to every repo the installation can see).
 *   2. Page `GET /installation/repositories` with that token, aggregating each
 *      page's `repositories[].full_name` until we've collected `total_count`.
 *
 * SECURITY / FAIL-CLOSED: every failure path (mint error, non-2xx HTTP,
 * malformed body, pagination that can't make progress) throws
 * {@link InstallationReposError}. We NEVER return a partial or empty list to
 * signal an error — a silent empty list at the create call site would let an
 * agent be created against "all repos = none", or (worse, if the caller treated
 * empty as "all") against repos the operator never intended. The minted token
 * is used only inside this module and is never returned or logged.
 *
 * The installation token is read with the same App credentials helper and JWT
 * signer the single-repo broker uses (`github-installation-token.ts`), and all
 * GitHub I/O goes through `fetch` to match this codebase's convention (no
 * GitHub call site here uses an octokit client). The optional `fetcher`
 * parameter exists purely for unit-test injection, mirroring
 * `mintInstallationToken`'s `Fetcher` seam.
 */

import { generateAppJwt } from "@/server/github-auth";
import { validateEnv } from "@/server/env";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const PER_PAGE = 100;
/** Defensive upper bound on pages so a misbehaving API can't loop forever. At
 * 100/page this covers 10k repos, far above any realistic installation. */
const MAX_PAGES = 100;

/** 60s in-memory TTL. Short enough that newly-granted repos appear promptly on
 * the next form load; long enough to absorb the create/meta burst of a single
 * dashboard session without re-minting a token + paging on every request. */
const CACHE_TTL_MS = 60_000;

/** Fail-closed error for any inability to enumerate the installation's repos. */
export class InstallationReposError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationReposError";
  }
}

/** Test seam — same shape as `github-installation-token.ts`'s `Fetcher`. */
export type Fetcher = typeof fetch;

interface CacheEntry {
  repos: string[];
  expiresAt: number;
}

// Module-scoped cache keyed by installationId. Only SUCCESSFUL results are
// cached (failures must always re-attempt, never be remembered).
const cache = new Map<string, CacheEntry>();

/** Test-only: clear the in-memory cache between cases. */
export function __clearInstallationReposCache(): void {
  cache.clear();
}

/**
 * Mint an installation access token scoped to the ENTIRE installation (no
 * `repositories` narrowing). Returns the raw `ghs_` token — caller must keep it
 * server-side. Throws {@link InstallationReposError} on any failure.
 */
async function mintInstallationWideToken(
  installationId: string,
  fetcher: Fetcher,
): Promise<string> {
  // App credentials live in env (server-only). validateEnv() returns the full
  // config in dev (vars optional) or `{ ok: false }` in prod when required vars
  // are missing — we additionally guard the two we need so a dev run without
  // them fails closed here rather than producing a malformed JWT.
  const env = validateEnv();
  const appId = env.ok ? env.config.githubAppId : undefined;
  const privateKeyPem = env.ok ? env.config.githubAppPrivateKey : undefined;
  if (!appId || !privateKeyPem) {
    throw new InstallationReposError(
      "GitHub App credentials unavailable (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).",
    );
  }

  let jwt: string;
  try {
    jwt = generateAppJwt(appId, privateKeyPem);
  } catch (err) {
    throw new InstallationReposError(
      `failed to sign App JWT: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "hivemoot-fleet-installation-repos",
      },
      // Intentionally NO `repositories` field — yields a token covering every
      // repo the installation can access, which is exactly what we enumerate.
      body: JSON.stringify({}),
    });
  } catch (err) {
    throw new InstallationReposError(
      `network error minting installation token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status !== 201) {
    throw new InstallationReposError(
      `unexpected HTTP ${response.status} minting installation token`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new InstallationReposError(
      `installation token response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { token?: unknown }).token !== "string" ||
    (body as { token: string }).token.length === 0
  ) {
    throw new InstallationReposError("installation token response missing 'token'");
  }
  return (body as { token: string }).token;
}

interface InstallationReposPage {
  total_count: number;
  repositories: Array<{ full_name: string }>;
}

/** Validate one page of `GET /installation/repositories`. Throws on any shape
 * violation (fail-closed — never page past a malformed response). */
function parseReposPage(value: unknown): InstallationReposPage {
  if (typeof value !== "object" || value === null) {
    throw new InstallationReposError("installation repositories page is not an object");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.total_count !== "number" || !Number.isFinite(v.total_count) || v.total_count < 0) {
    throw new InstallationReposError("installation repositories page missing numeric 'total_count'");
  }
  if (!Array.isArray(v.repositories)) {
    throw new InstallationReposError("installation repositories page missing 'repositories' array");
  }
  const repositories: Array<{ full_name: string }> = [];
  for (const entry of v.repositories) {
    if (typeof entry !== "object" || entry === null) {
      throw new InstallationReposError("installation repository entry is not an object");
    }
    const fullName = (entry as { full_name?: unknown }).full_name;
    if (typeof fullName !== "string" || fullName.length === 0) {
      throw new InstallationReposError("installation repository entry missing 'full_name'");
    }
    repositories.push({ full_name: fullName });
  }
  return { total_count: v.total_count, repositories };
}

/**
 * Returns `owner/name` for every repo the installation can access.
 *
 * Successful results are cached per installationId for {@link CACHE_TTL_MS}.
 * Any failure throws {@link InstallationReposError} (fail-closed) and is NOT
 * cached.
 *
 * @param fetcher injected only for tests; production uses the global `fetch`.
 */
export async function listInstallationRepos(
  installationId: string,
  fetcher: Fetcher = fetch,
): Promise<string[]> {
  const now = Date.now();
  const cached = cache.get(installationId);
  if (cached && cached.expiresAt > now) {
    return [...cached.repos];
  }

  const token = await mintInstallationWideToken(installationId, fetcher);

  const fullNames: string[] = [];
  let totalCount: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${GITHUB_API_BASE}/installation/repositories?per_page=${PER_PAGE}&page=${page}`;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          // The minted installation token authenticates these reads. `token`
          // (not `Bearer`) is GitHub's scheme for installation access tokens.
          Authorization: `token ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": "hivemoot-fleet-installation-repos",
        },
      });
    } catch (err) {
      throw new InstallationReposError(
        `network error listing installation repositories: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (response.status !== 200) {
      throw new InstallationReposError(
        `unexpected HTTP ${response.status} listing installation repositories`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new InstallationReposError(
        `installation repositories response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = parseReposPage(body);
    if (totalCount === null) totalCount = parsed.total_count;
    for (const repo of parsed.repositories) fullNames.push(repo.full_name);

    // Stop once we've collected the advertised total. An empty page before
    // reaching the total means the API can't make progress — treat the data
    // we have as complete rather than looping (we never silently *expand*).
    if (fullNames.length >= totalCount) break;
    if (parsed.repositories.length === 0) break;
  }

  // Defense in depth: drop accidental duplicates while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const name of fullNames) {
    if (!seen.has(name)) {
      seen.add(name);
      deduped.push(name);
    }
  }

  cache.set(installationId, { repos: deduped, expiresAt: Date.now() + CACHE_TTL_MS });
  return [...deduped];
}
