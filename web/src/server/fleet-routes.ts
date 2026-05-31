/**
 * Shared helpers for the fleet (agent registry) route handlers. Mirrors
 * `agent-token-v1-routes.ts` but with a fleet-namespaced error vocabulary so a
 * fleet route never leaks a token-namespaced error code.
 */

import { NextResponse } from "next/server";
import { type Redis } from "@upstash/redis";
import { LockTimeoutError } from "@hivemoot/war-room/redis-lock";
import {
  AgentNameTakenError,
  AgentNotFoundError,
  AgentLimitReachedError,
  validateRepo,
} from "@/server/fleet-store";
import { getAgentTokenSummary, TokenNotFoundError } from "@/server/agent-token-v1";
import {
  listInstallationRepos,
  InstallationReposError,
  type Fetcher,
} from "@/server/github-installation-repos";

export const FLEET_ERROR = {
  INVALID_BODY: "fleet_invalid_body",
  VALIDATION: "fleet_validation",
  INVALID_TOKEN: "fleet_invalid_token",
  REPO_NOT_COVERED: "fleet_repo_not_covered",
  /** Couldn't enumerate the installation's repos (fail-closed; no agent). */
  REPOS_UNAVAILABLE: "fleet_repos_unavailable",
  COVERAGE_CHECK_FAILED: "fleet_coverage_check_failed",
  NAME_TAKEN: "fleet_name_taken",
  NOT_FOUND: "fleet_not_found",
  AGENT_LIMIT_REACHED: "fleet_agent_limit_reached",
  RATE_LIMITED: "fleet_rate_limited",
  QUEEN_NOT_SUPPORTED: "fleet_queen_not_supported",
  LOCK_TIMEOUT: "fleet_lock_timeout",
  SERVER_ERROR: "fleet_server_error",
} as const;

export type FleetErrorCode = (typeof FLEET_ERROR)[keyof typeof FLEET_ERROR];

export function fleetError(
  code: FleetErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ code, message, ...(details ?? {}) }, { status });
}

export type ReadJsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/** Parse a JSON body that must be a non-array object (empty body → {}). */
export async function readJsonObject(request: Request): Promise<ReadJsonObjectResult> {
  if (request.body === null) return { ok: true, body: {} };
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: fleetError(FLEET_ERROR.INVALID_BODY, "Request body must be valid JSON.", 400) };
  }
  if (body == null) return { ok: true, body: {} };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: fleetError(FLEET_ERROR.INVALID_BODY, "Request body must be a JSON object.", 400) };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * Map a fleet storage-layer error to an HTTP response. Never echoes raw error
 * messages for the unexpected case (avoids internal leakage; the real error is
 * logged for ops — matches web/AGENTS.md security boundary).
 */
export function mapFleetStorageError(
  err: unknown,
  context: { route: string; installationId: string; name?: string },
): NextResponse {
  if (err instanceof AgentNameTakenError) {
    return fleetError(FLEET_ERROR.NAME_TAKEN, err.message, 409, context.name ? { name: context.name } : undefined);
  }
  if (err instanceof AgentNotFoundError) {
    return fleetError(FLEET_ERROR.NOT_FOUND, err.message, 404, context.name ? { name: context.name } : undefined);
  }
  if (err instanceof AgentLimitReachedError) {
    return fleetError(FLEET_ERROR.AGENT_LIMIT_REACHED, err.message, 409);
  }
  if (err instanceof LockTimeoutError) {
    return fleetError(FLEET_ERROR.LOCK_TIMEOUT, "Another operation is in progress for this agent. Retry in a moment.", 503);
  }
  console.error("[fleet] unexpected error", { route: context.route, installationId: context.installationId, name: context.name, error: err });
  return fleetError(FLEET_ERROR.SERVER_ERROR, "Internal server error.", 500);
}

// ---------------------------------------------------------------------------
// Create rate limit (per installation+user, per minute) — mirrors task-store.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Linked-token validation (existence only — the token carries CAPABILITIES, not
// repo scope; the dashboard cannot issue repo-scoped tokens).
// ---------------------------------------------------------------------------

export type ValidateLinkedTokenResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Verify a linked capability token EXISTS for this installation. Existence-only:
 * the token is the agent's capability bearer, decoupled from repo scope (repos
 * come from `plugins.github.repos`, resolved against the installation). A missing
 * token → INVALID_TOKEN. installationId is supplied by the route from the
 * session — a guessed token name from another tenant resolves to a miss here.
 */
export async function validateLinkedToken(
  installationId: string,
  tokenName: string,
  redis: Redis,
): Promise<ValidateLinkedTokenResult> {
  try {
    await getAgentTokenSummary({ installationId, name: tokenName, redis });
  } catch (err) {
    if (err instanceof TokenNotFoundError) {
      return {
        ok: false,
        response: fleetError(
          FLEET_ERROR.INVALID_TOKEN,
          `No capability token named '${tokenName}' exists. Create it on the Credentials screen first.`,
          400,
          { field: "agent_token_name" },
        ),
      };
    }
    throw err;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// GitHub repo resolution (run whenever a github plugin block is PRESENT —
// enabled or not — so an uncovered repo can never be persisted/shipped).
// ---------------------------------------------------------------------------

export type ResolveGithubReposResult =
  | { ok: true; repos: string[] }
  | { ok: false; response: NextResponse };

export interface ResolveGithubReposOptions {
  /**
   * Behavior when `requested` is empty/undefined:
   * - `true` (use when the github plugin is ENABLED): default to ALL installed
   *   repos (and 400 REPO_NOT_COVERED if the installation has none — an enabled
   *   github agent with zero repos has nothing to operate on).
   * - `false` (use when the plugin is DISABLED): return `[]` WITHOUT calling the
   *   lister at all (no repos requested, none to cover — nothing to fetch).
   */
  defaultAllWhenEmpty: boolean;
  /** Injected only for tests; production uses the global `fetch`. */
  fetcher?: Fetcher;
}

/**
 * Resolve a github plugin's repo set against the installation's accessible
 * repos. Fail-closed throughout — an agent is NEVER stored against repos the
 * installation can't see, whether or not the plugin is enabled.
 *
 * - `requested` NON-EMPTY: each entry must be well-formed (`validateRepo`, else
 *   VALIDATION) AND covered by the installation (case-insensitive match; the
 *   installation's canonical casing is returned); results are deduped. Any
 *   uncovered entry → 400 REPO_NOT_COVERED. (This path runs the coverage check
 *   regardless of `defaultAllWhenEmpty` / enabled state.)
 * - `requested` EMPTY/undefined: when `defaultAllWhenEmpty` is true, return ALL
 *   installed repos (empty installation → 400 REPO_NOT_COVERED); when false,
 *   return `[]` without touching the lister.
 * - The lister throwing `InstallationReposError` → 503 REPOS_UNAVAILABLE
 *   (fail-closed; no agent; never default to "all" on error).
 */
export async function resolveGithubRepos(
  installationId: string,
  requested: string[] | undefined,
  opts: ResolveGithubReposOptions,
): Promise<ResolveGithubReposResult> {
  const hasRequested = Array.isArray(requested) && requested.length > 0;

  // Disabled + nothing requested: nothing to cover, so don't even call the
  // lister — return an empty set (the stored disabled block keeps repos: []).
  if (!hasRequested && !opts.defaultAllWhenEmpty) {
    return { ok: true, repos: [] };
  }

  let installed: string[];
  try {
    installed = opts.fetcher
      ? await listInstallationRepos(installationId, opts.fetcher)
      : await listInstallationRepos(installationId);
  } catch (err) {
    if (err instanceof InstallationReposError) {
      return {
        ok: false,
        response: fleetError(
          FLEET_ERROR.REPOS_UNAVAILABLE,
          "Couldn't read the repositories this installation can access. Try again in a moment.",
          503,
          { field: "plugins.github.repos" },
        ),
      };
    }
    throw err;
  }

  if (installed.length === 0) {
    return {
      ok: false,
      response: fleetError(
        FLEET_ERROR.REPO_NOT_COVERED,
        "The Hivemoot Bot isn't installed on any repository. Install it on a repo, then try again.",
        400,
        { field: "plugins.github.repos" },
      ),
    };
  }

  // Case-insensitive lookup → canonical casing as the installation reports it.
  const canonicalByLower = new Map<string, string>();
  for (const r of installed) canonicalByLower.set(r.toLowerCase(), r);

  if (hasRequested) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of requested as string[]) {
      const v = validateRepo(r);
      if (!v.ok) {
        return {
          ok: false,
          response: fleetError(FLEET_ERROR.VALIDATION, v.message, 400, { field: "plugins.github.repos" }),
        };
      }
      const canonical = canonicalByLower.get(v.value.toLowerCase());
      if (!canonical) {
        return {
          ok: false,
          response: fleetError(
            FLEET_ERROR.REPO_NOT_COVERED,
            `Repository '${v.value}' isn't accessible to this installation. Pick a repo the Hivemoot Bot is installed on.`,
            400,
            { field: "plugins.github.repos" },
          ),
        };
      }
      if (!seen.has(canonical)) {
        seen.add(canonical);
        out.push(canonical);
      }
    }
    return { ok: true, repos: out };
  }

  // Empty request + defaultAllWhenEmpty: every repo the installation can access.
  return { ok: true, repos: [...installed] };
}

// ---------------------------------------------------------------------------
// Create rate limit
// ---------------------------------------------------------------------------

export const FLEET_CREATE_RATE_LIMIT_PER_MINUTE = 10;

export async function checkFleetCreateRateLimit(
  installationId: string,
  userId: number,
  redis: Redis,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const key = `hive:v1:fleet:create-ratelimit:${installationId}:${userId}:${minuteBucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  if (count > FLEET_CREATE_RATE_LIMIT_PER_MINUTE) return { allowed: false, retryAfterSeconds: 60 };
  return { allowed: true, retryAfterSeconds: 0 };
}
