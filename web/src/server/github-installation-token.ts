/**
 * Mints a short-lived GitHub installation access token narrowed to one
 * repo and the V1 hard-coded permission set. Used by
 * POST /api/github/installation-tokens to broker tokens for apiarist
 * (the host-side daemon described in `apiarist/DESIGN.md`).
 *
 * Two layers of trust on the way in:
 *
 * 1. Caller is authenticated by agent_token (the Bearer header), which
 *    `authenticateAgentRequest` resolves to an `installationId` via
 *    Redis. By the time we get here the caller has already been bound
 *    to a specific installation server-side.
 * 2. We sign an App JWT with the Hivemoot Bot's RSA private key (which
 *    only the backend holds — never on operator hardware) and exchange
 *    it at `POST /app/installations/{id}/access_tokens` for an
 *    installation token narrowed to a single `repo` and the V1
 *    permissions below.
 *
 * Errors are typed (subclasses of `MintError`) and carry the HTTP status
 * the API route should surface. Call sites translate them into the wire
 * shape apiarist's daemon expects (see `apiarist/DESIGN.md` §11).
 */

import { createHash } from "crypto";
import { generateAppJwt } from "@/server/github-auth";
import type { GitHubPermissionLevel } from "@/server/agent-token-v1";

// ---------------------------------------------------------------------------
// Default permission set
// ---------------------------------------------------------------------------
//
// Hard-coded ceiling per apiarist DESIGN.md §11 — every mint asks for at
// most this scope. V1.6 (`allowed_permissions` on the token policy) lets
// individual tokens NARROW from this default; nothing can EXCEED it.
// Apiarist's `_V1_PERMISSIONS` (in
// `apiarist/src/apiarist/features/tokens/plugin.py`) MUST be kept in sync
// with this — apiarist uses it as the cache-key hash, and a divergence
// would silently invalidate every cached entry on the client.

export const V1_PERMISSIONS: Readonly<Record<string, GitHubPermissionLevel>> =
  Object.freeze({
    contents: "read",
    pull_requests: "write",
    issues: "write",
    metadata: "read",
  });

// ---------------------------------------------------------------------------
// Permission intersection (V1.6)
// ---------------------------------------------------------------------------

const PERMISSION_LEVEL_RANK: Readonly<Record<GitHubPermissionLevel, number>> =
  Object.freeze({ read: 1, write: 2, admin: 3 });

// `InvalidPermissionLevelError` is declared further down (after `MintError`,
// which it extends — TypeScript classes are not hoisted, so it must be
// defined after its base class). Forward-declared here as a type-only
// import for the `intersectPermissions` JSDoc cross-reference.

function isValidPermissionLevel(value: unknown): value is GitHubPermissionLevel {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PERMISSION_LEVEL_RANK, value)
  );
}

const VALID_LEVELS = Object.freeze(
  Object.keys(PERMISSION_LEVEL_RANK) as GitHubPermissionLevel[],
);

/**
 * Compute the effective permission set: intersect the default ceiling
 * with an optional per-token narrowing map.
 *
 * Rules:
 *   1. If `narrow` is `undefined` → return defaults unchanged (V1.5
 *      behavior preserved for legacy / non-V1.6 tokens).
 *   2. For every key in `defaults`:
 *      - If `narrow` doesn't mention it → use the default level.
 *      - If `narrow` mentions it with a VALID level → take the LOWER
 *        of the two levels (read < write < admin). The token can
 *        narrow but never raise.
 *      - If `narrow` mentions it with an INVALID level (string that
 *        isn't "read"|"write"|"admin", or non-string) → throw
 *        {@link InvalidPermissionLevelError}. Fail closed.
 *   3. Keys present in `narrow` but absent from `defaults` are silently
 *      DROPPED (a token cannot grant scope the default doesn't have).
 *      A console warning is emitted so misconfigurations are visible
 *      in operator logs. Uses `hasOwnProperty` (not `in`) to avoid
 *      false positives on `Object.prototype` member names like
 *      `toString`/`hasOwnProperty` themselves.
 *
 * Exported for unit testing; production callers should let
 * `mintInstallationToken` apply this internally (which translates
 * thrown errors into structured 400 responses).
 */
export function intersectPermissions(
  defaults: Readonly<Record<string, GitHubPermissionLevel>>,
  narrow: Readonly<Record<string, unknown>> | undefined,
): Record<string, GitHubPermissionLevel> {
  if (narrow === undefined) {
    // No narrowing requested — caller wants defaults verbatim.
    return { ...defaults };
  }

  const out: Record<string, GitHubPermissionLevel> = {};
  for (const [key, defaultLevel] of Object.entries(defaults)) {
    const narrowLevel = narrow[key];
    if (narrowLevel === undefined) {
      out[key] = defaultLevel;
      continue;
    }
    if (!isValidPermissionLevel(narrowLevel)) {
      // Fail-closed: do NOT silently fall back to the default level.
      // For a narrowing primitive, the safer behavior is to reject
      // the mint entirely so the operator notices and fixes the
      // policy. Caller (route handler) maps this to a 400 with the
      // structured error code.
      throw new InvalidPermissionLevelError(
        key,
        String(narrowLevel),
        VALID_LEVELS,
      );
    }
    const defaultRank = PERMISSION_LEVEL_RANK[defaultLevel];
    const narrowRank = PERMISSION_LEVEL_RANK[narrowLevel];
    out[key] = narrowRank < defaultRank ? narrowLevel : defaultLevel;
  }

  // Surface (don't silently swallow) keys in `narrow` that aren't in
  // `defaults` — operator typo'd a permission name, or asked for a scope
  // V1_PERMISSIONS doesn't expose. The dropped keys still go to GitHub
  // through `out`, so the request is unaffected (those keys aren't there).
  // Use hasOwnProperty so prototype-chain members ("toString" etc.) don't
  // suppress legitimate warnings.
  for (const key of Object.keys(narrow)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      console.warn(
        `[mintInstallationToken] policy.allowed_permissions['${key}'] ignored — not in V1_PERMISSIONS`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MintOptions {
  /** Server-resolved installation ID (from agent_token → Redis lookup). */
  installationId: string;
  /** Caller-requested `owner/name`. Verified against the installation's covered repos. */
  repo: string;
  /** Hivemoot Bot's numeric App ID (from `GITHUB_APP_ID` env). */
  appId: string;
  /** Hivemoot Bot's RSA private key in PEM form (from `GITHUB_APP_PRIVATE_KEY` env). */
  appPrivateKeyPem: string;
  /**
   * V1.6+: per-token permission narrowing from the agent token's
   * `policy.allowed_permissions`. When set, the requested scope is
   * `intersectPermissions(V1_PERMISSIONS, allowedPermissions)` — the
   * token can only narrow the default; it cannot raise it.
   * Absence (undefined) preserves V1.5 behavior — request V1_PERMISSIONS
   * verbatim.
   */
  allowedPermissions?: Record<string, GitHubPermissionLevel>;
}

export interface InstallationAccessTokenResponse {
  /** The `ghs_`-prefixed installation access token. */
  token: string;
  /** ISO 8601 UTC. The cache eviction deadline is the source of truth. */
  expires_at: string;
  /** Echoed from the server-resolved installation. */
  installation_id: string;
  /** Granted permissions (may be a subset of {@link V1_PERMISSIONS} if the
   * installation grant narrows further). */
  permissions: Record<string, string>;
  /** Repos this token can act on. Always exactly one for V1 per the
   * single-repo narrow we requested. */
  repositories: Array<{ full_name: string; id: number }>;
  /**
   * Base64-encoded SHA-256 of `token`. Per DESIGN.md §11 audit-hash
   * pattern (mirrors `vault-plugin-secrets-github`): lets audit logs
   * correlate "this token was issued for this installation" without
   * ever logging the token itself. Apiarist treats this as opaque
   * pass-through metadata; the backend's audit log emits the same
   * hash so cross-system correlation is possible without either side
   * holding the secret value.
   */
  hashed_token: string;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------
//
// Each subclass carries the HTTP status the route should surface. The status
// mapping aligns with what apiarist's daemon expects (see DESIGN.md §11):
//
//   403 → BACKEND_FORBIDDEN  (repo not in installation, or App policy denied)
//   429 → BACKEND_RATE_LIMITED
//   502 → BACKEND_UNAVAILABLE  (GitHub 5xx, network error, malformed response)
//   503 → BACKEND_UNAVAILABLE  (App credential rejected — server misconfig)
//
// `MintError` is the base type the route catches uniformly. Errors
// that may carry detail an attacker could mine (App credential errors
// in particular — Node's createSign / GitHub's 401 body could in
// principle contain PEM bytes or other internal-only state in some
// future Node version) keep the detail server-side via the
// `internalDetail` field. The route logs `internalDetail` server-side
// (operator debugging) but emits only `.message` on the wire (apiarist
// debugging). Subclasses that don't accept arbitrary upstream strings
// can leave `internalDetail` as the same as `.message` — defense in
// depth, no harm.

export class MintError extends Error {
  public readonly httpStatus: number;
  public readonly errorCode: string;
  /** Server-side-only detail. Logged but never surfaced on the wire. */
  public readonly internalDetail: string;

  constructor(
    message: string,
    httpStatus: number,
    errorCode: string,
    internalDetail?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.internalDetail = internalDetail ?? message;
  }
}

export class InstallationNotCoverageError extends MintError {
  constructor(repo: string) {
    super(
      `Repo '${repo}' is not covered by the agent token's installation. ` +
        "Verify the Hivemoot Bot is installed on this repo " +
        "(https://github.com/apps/<bot-name> → Configure → Repository access).",
      403,
      "installation_not_coverage",
    );
  }
}

export class GitHubRateLimitedError extends MintError {
  constructor() {
    super(
      "GitHub installation-token rate limit hit; do not retry within the rate window.",
      429,
      "github_rate_limited",
    );
  }
}

export class AppCredentialError extends MintError {
  /**
   * @param detail Server-side-only context (e.g. raw error from
   *               createSign or GitHub's 401 body). Logged via
   *               `internalDetail`; NEVER surfaced on the wire.
   *               Defense in depth: even if a future Node openssl
   *               error puts PEM bytes in its `.message`, the wire
   *               response stays a fixed string.
   */
  constructor(detail: string) {
    super(
      "Hivemoot Bot App credential rejected; see backend logs for details.",
      503,
      "app_credential_invalid",
      `Hivemoot Bot App credential rejected by GitHub: ${detail}`,
    );
  }
}

export class GitHubUnavailableError extends MintError {
  constructor(detail: string) {
    super(`GitHub is unavailable: ${detail}`, 502, "github_unavailable");
  }
}

export class InvalidMintRequestError extends MintError {
  constructor(detail: string) {
    super(`Invalid mint request: ${detail}`, 400, "invalid_mint_request");
  }
}

/**
 * Thrown when `allowed_permissions` carries a level value that isn't
 * one of `"read" | "write" | "admin"`. The Redis-stored policy JSON
 * has no schema enforcement, so an operator typo or a corrupted
 * envelope could land here. Fail closed: better to refuse the mint
 * with a clear error than silently fall through to the default level
 * (R1 finding from PR #501 — fail-open on invalid levels would let a
 * typoed read-only worker token get write scope by accident, which
 * is the WORST possible failure direction for a narrowing primitive).
 */
export class InvalidPermissionLevelError extends MintError {
  constructor(permission: string, badValue: string, validLevels: readonly string[]) {
    super(
      `Token policy 'allowed_permissions.${permission}' has invalid value ` +
        `${JSON.stringify(badValue)} (expected one of ${validLevels.join(", ")}). ` +
        `Reissue the token via the dashboard's Capability Tokens UI ` +
        `(or POST /api/agent-tokens/{name}/rotate) with a corrected policy.`,
      400,
      "invalid_permission_level",
    );
  }
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

/**
 * Validates `repo` looks like `owner/name`.
 * GitHub's API accepts the short name; we split here so the request body
 * narrows to `repositories: [<short-name>]`. Both halves must be non-empty
 * and free of slashes themselves (no nested paths).
 */
function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidMintRequestError(
      `repo must be 'owner/name'; got '${repo}'`,
    );
  }
  return { owner: parts[0], name: parts[1] };
}

/**
 * Performs the actual GitHub call. Separated from {@link mintInstallationToken}
 * for unit-test ergonomics — tests inject a mock fetch via the optional
 * `fetcher` param and assert on the request shape.
 */
export type Fetcher = typeof fetch;

export async function mintInstallationToken(
  options: MintOptions,
  fetcher: Fetcher = fetch,
): Promise<InstallationAccessTokenResponse> {
  const { installationId, repo, appId, appPrivateKeyPem, allowedPermissions } =
    options;

  // Validate repo shape BEFORE generating the JWT so a malformed input
  // doesn't burn an RSA signing operation.
  const { name: repoShortName } = parseRepo(repo);

  // V1.6: compute the effective permission set. With no narrowing
  // (legacy/V1.5 tokens) this returns V1_PERMISSIONS unchanged; with
  // narrowing (V1.6 tokens) it returns the intersected map.
  const effectivePermissions = intersectPermissions(
    V1_PERMISSIONS,
    allowedPermissions,
  );

  // Generate the App JWT. This is purely CPU work (RS256 sign) — failures
  // here mean the App private key in env is malformed or missing, which is
  // a server misconfig we surface as 503 (so apiarist sees it as
  // BACKEND_UNAVAILABLE rather than BACKEND_FORBIDDEN).
  let jwt: string;
  try {
    jwt = generateAppJwt(appId, appPrivateKeyPem);
  } catch (err) {
    throw new AppCredentialError(
      err instanceof Error ? err.message : String(err),
    );
  }

  // Exchange the JWT for a narrowed installation token. GitHub's docs:
  // https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
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
        // GitHub's API requires a UA on POSTs; absent it can return 403.
        "User-Agent": "hivemoot-apiarist-broker",
      },
      body: JSON.stringify({
        // Narrow to the requested repo only. GitHub accepts the short
        // name (NOT owner/name); the installation provides the owner
        // context implicitly.
        repositories: [repoShortName],
        // Permission set: V1_PERMISSIONS by default, intersected with
        // `allowedPermissions` (V1.6) if the token's policy narrows
        // further. If the installation's policy grants less than what
        // we ask for, GitHub silently narrows further and the response
        // permissions reflect that.
        permissions: effectivePermissions,
      }),
    });
  } catch (err) {
    // Network-layer failure (DNS, connection refused, TLS error). Distinct
    // from any HTTP status; surface as upstream-unavailable.
    throw new GitHubUnavailableError(
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Status routing. GitHub returns 201 Created on success; everything else
  // maps to a typed error.
  if (response.status === 401) {
    // The App JWT was rejected. Either the private key is wrong/expired
    // or the App ID is wrong. Server misconfig — apiarist sees 503.
    throw new AppCredentialError(
      "GitHub returned 401 to the App JWT (private key or App ID mismatch?)",
    );
  }
  if (response.status === 403 || response.status === 404) {
    // 404 = installation or repo not found.
    // 403 = installation exists but doesn't grant access to this repo
    //       (or the App's permission policy doesn't allow what we asked
    //        for). Operationally these are the same failure: the agent
    //        is asking for a repo it can't get a token for. Surface
    //        as the same 403 with a clear remediation message.
    throw new InstallationNotCoverageError(repo);
  }
  if (response.status === 422) {
    // Validation error. With V1's hard-coded permissions and a
    // pre-validated repo this should be unreachable — if it fires it
    // indicates a code bug, so we surface the GitHub error verbatim
    // (truncated) to make debugging visible.
    const detail = await safeReadResponse(response);
    throw new InvalidMintRequestError(`GitHub 422: ${detail}`);
  }
  if (response.status === 429) {
    throw new GitHubRateLimitedError();
  }
  if (response.status >= 500) {
    throw new GitHubUnavailableError(`GitHub returned HTTP ${response.status}`);
  }
  if (response.status !== 201) {
    // Any other unexpected status is a code bug or GitHub API change.
    throw new GitHubUnavailableError(
      `unexpected HTTP ${response.status} from GitHub`,
    );
  }

  // Parse + validate response shape.
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new GitHubUnavailableError(
      `GitHub returned non-JSON 201: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isGitHubMintResponse(body)) {
    throw new GitHubUnavailableError(
      "GitHub 201 response is missing required fields (token / expires_at / permissions)",
    );
  }

  return {
    token: body.token,
    expires_at: body.expires_at,
    installation_id: installationId,
    permissions: body.permissions,
    repositories: (body.repositories ?? []).map((r) => ({
      full_name: r.full_name,
      id: r.id,
    })),
    // Audit-correlation hash. SHA-256 over the raw token bytes; base64
    // encoded for log readability. Computed here so the route can emit
    // it in audit logs without re-hashing — single source of truth.
    hashed_token: createHash("sha256")
      .update(body.token, "utf8")
      .digest("base64"),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface GitHubMintResponseShape {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repositories?: Array<{ id: number; full_name: string }>;
}

function isGitHubMintResponse(value: unknown): value is GitHubMintResponseShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || v.token.length === 0) return false;
  if (typeof v.expires_at !== "string" || v.expires_at.length === 0) return false;
  if (typeof v.permissions !== "object" || v.permissions === null) return false;
  // permissions: Record<string, string> — every value must be a string.
  for (const val of Object.values(v.permissions as Record<string, unknown>)) {
    if (typeof val !== "string") return false;
  }
  // repositories is OPTIONAL but if present every entry must have full_name + id.
  if (v.repositories !== undefined) {
    if (!Array.isArray(v.repositories)) return false;
    for (const entry of v.repositories) {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      if (typeof e.full_name !== "string") return false;
      if (typeof e.id !== "number") return false;
    }
  }
  return true;
}

/**
 * Reads a (probably-error) response body without throwing — used to
 * decorate error messages with GitHub's response when available, while
 * not letting a body-read failure mask the original HTTP error.
 */
async function safeReadResponse(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 200 ? text.slice(0, 200) + "…" : text;
  } catch {
    return "(body unreadable)";
  }
}
