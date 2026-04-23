/**
 * GET /api/repos/[owner]/[repo]/roles
 *
 * Returns the list of agent roles defined in `.github/hivemoot.yml` for the
 * given repository, along with the file SHA for optimistic concurrency on
 * subsequent writes.
 *
 * Also checks for an open role-edit PR so the UI can surface the correct
 * "Editing: pending PR #N" badge instead of "Editing: main".
 *
 * PUT /api/repos/[owner]/[repo]/roles
 *
 * Updates a single role's description and instructions in `.github/hivemoot.yml`
 * by writing to a `hivemoot-role-edits` branch and opening a PR if one doesn't
 * exist. Accepts `fileSha` for optimistic concurrency conflict detection.
 */

import { NextRequest, NextResponse } from "next/server";
import { parse as parseYaml, parseDocument } from "yaml";
import { authenticateByokRequest } from "@/server/byok-auth";
import { validateEnv } from "@/server/env";
import { generateAppJwt, generateInstallationToken } from "@/server/github-auth";
import {
  readRepoFile,
  getBranchSha,
  getDefaultBranch,
  createBranch,
  resetBranchToSha,
  writeFileToBranch,
  listOpenPRsForBranch,
  createPullRequest,
} from "@/server/github-contents";

const HIVEMOOT_CONFIG_PATH = ".github/hivemoot.yml";

/** Branch name for role-edit PRs created by the web UI. */
const ROLE_EDIT_BRANCH = "hivemoot-role-edits";

/** Maximum number of characters allowed per role field (mirrors CLI guards). */
const MAX_FIELD_LENGTH = 10_000;

interface RoleEntry {
  name: string;
  description: string;
  instructions: string;
}

interface RolesResponse {
  roles: RoleEntry[];
  /** Blob SHA of `.github/hivemoot.yml` at `source`. Pass back on PUT to detect conflicts. */
  fileSha: string;
  /** "main" or "pending-pr:{number}" */
  source: string;
}

function repoError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ code, message }, { status });
}

function extractOwnerRepo(pathname: string): { owner: string; repo: string } | null {
  // /api/repos/{owner}/{repo}/roles
  const match = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/roles(?:\/.*)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function sanitizeString(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
  if (typeof value !== "string") return "";
  return value.slice(0, maxLength);
}

function parseRoles(configContent: string): RoleEntry[] | null {
  let config: unknown;
  try {
    config = parseYaml(configContent);
  } catch {
    return null;
  }

  if (!config || typeof config !== "object") return null;
  const top = config as Record<string, unknown>;
  if (!top.team || typeof top.team !== "object") return null;
  const team = top.team as Record<string, unknown>;
  if (!team.roles || typeof team.roles !== "object" || Array.isArray(team.roles)) return null;

  const rolesMap = team.roles as Record<string, unknown>;
  return Object.entries(rolesMap).map(([name, roleValue]) => {
    const role =
      roleValue && typeof roleValue === "object" ? (roleValue as Record<string, unknown>) : {};
    return {
      name,
      description: sanitizeString(role.description),
      instructions: sanitizeString(role.instructions),
    };
  });
}

interface PutRoleBody {
  /** The role key to update (must match an existing role in the config). */
  roleName: string;
  description: string;
  instructions: string;
  /**
   * Blob SHA of the file returned by GET. Used for optimistic concurrency:
   * if the file has changed since the GET, PUT returns 409 Conflict.
   */
  fileSha: string;
}

interface PutRolesResponse {
  prNumber: number;
  prUrl: string;
  /** Always "pending-pr:{number}" after a successful write. */
  source: string;
}

function isValidRoleName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 100;
}

/**
 * Updates a single role in the YAML document while preserving comments and
 * structure. Uses yaml v2's `parseDocument` / `setIn` for lossless round-trips.
 *
 * Returns `null` if the role key doesn't exist in the document.
 */
function applyRoleEdit(
  configContent: string,
  roleName: string,
  description: string,
  instructions: string,
): string | null {
  const doc = parseDocument(configContent);

  // Verify the role exists before mutating.
  const existing = doc.getIn(["team", "roles", roleName]);
  if (existing === undefined || existing === null) return null;

  doc.setIn(["team", "roles", roleName, "description"], description);
  doc.setIn(["team", "roles", roleName, "instructions"], instructions);

  return doc.toString();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const parsed = extractOwnerRepo(pathname);
  if (!parsed) {
    return repoError("invalid_path", "Invalid repository path", 400);
  }
  const { owner, repo } = parsed;

  const env = validateEnv();
  if (!env.ok) {
    return repoError("server_misconfiguration", "Server misconfiguration", 503);
  }

  const { githubAppId, githubAppPrivateKey } = env.config;
  if (!githubAppId || !githubAppPrivateKey) {
    return repoError("server_misconfiguration", "GitHub App not configured", 503);
  }

  try {
    const appJwt = generateAppJwt(githubAppId, githubAppPrivateKey);
    const installationToken = await generateInstallationToken(
      auth.session.installationId,
      appJwt,
    );

    // Check for an open role-edit PR; if found, read from that branch.
    const openPRs = await listOpenPRsForBranch(owner, repo, ROLE_EDIT_BRANCH, installationToken);
    const editPR = openPRs.length > 0 ? openPRs[0] : null;
    const ref = editPR ? ROLE_EDIT_BRANCH : undefined;

    const file = await readRepoFile(owner, repo, HIVEMOOT_CONFIG_PATH, installationToken, ref);
    if (!file) {
      return repoError(
        "config_not_found",
        `${HIVEMOOT_CONFIG_PATH} not found in ${owner}/${repo}`,
        404,
      );
    }

    const roles = parseRoles(file.content);
    if (roles === null) {
      return repoError(
        "config_parse_error",
        `Could not parse roles from ${HIVEMOOT_CONFIG_PATH} in ${owner}/${repo}`,
        422,
      );
    }

    const defaultBranch = await getDefaultBranch(owner, repo, installationToken);
    const source = editPR ? `pending-pr:${editPR.number}` : defaultBranch;
    const body: RolesResponse = { roles, fileSha: file.sha, source };
    return NextResponse.json(body);
  } catch (error) {
    console.error("[repos/roles] Failed to fetch roles", {
      installationId: auth.session.installationId,
      owner,
      repo,
      error,
    });
    return repoError("server_error", "Failed to fetch roles", 500);
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request);
  if (!auth.ok) return auth.response;

  const { pathname } = new URL(request.url);
  const parsed = extractOwnerRepo(pathname);
  if (!parsed) {
    return repoError("invalid_path", "Invalid repository path", 400);
  }
  const { owner, repo } = parsed;

  let body: PutRoleBody;
  try {
    body = (await request.json()) as PutRoleBody;
  } catch {
    return repoError("invalid_body", "Request body must be JSON", 400);
  }

  const { roleName, description, instructions, fileSha } = body;

  if (!isValidRoleName(roleName)) {
    return repoError("invalid_role_name", "roleName must be a non-empty string (max 100 chars)", 400);
  }
  if (typeof description !== "string") {
    return repoError("invalid_description", "description must be a string", 400);
  }
  if (typeof instructions !== "string") {
    return repoError("invalid_instructions", "instructions must be a string", 400);
  }
  if (typeof fileSha !== "string" || !fileSha) {
    return repoError("invalid_file_sha", "fileSha is required for conflict detection", 400);
  }

  const sanitizedDescription = sanitizeString(description);
  const sanitizedInstructions = sanitizeString(instructions);

  const env = validateEnv();
  if (!env.ok) {
    return repoError("server_misconfiguration", "Server misconfiguration", 503);
  }

  const { githubAppId, githubAppPrivateKey } = env.config;
  if (!githubAppId || !githubAppPrivateKey) {
    return repoError("server_misconfiguration", "GitHub App not configured", 503);
  }

  try {
    const appJwt = generateAppJwt(githubAppId, githubAppPrivateKey);
    const installationToken = await generateInstallationToken(
      auth.session.installationId,
      appJwt,
    );

    // Determine base branch: use the existing role-edit PR branch if open.
    const openPRs = await listOpenPRsForBranch(owner, repo, ROLE_EDIT_BRANCH, installationToken);
    const editPR = openPRs.length > 0 ? openPRs[0] : null;
    const readRef = editPR ? ROLE_EDIT_BRANCH : undefined;

    // Read the current file (from the edit branch if one exists, else main).
    const file = await readRepoFile(owner, repo, HIVEMOOT_CONFIG_PATH, installationToken, readRef);
    if (!file) {
      return repoError(
        "config_not_found",
        `${HIVEMOOT_CONFIG_PATH} not found in ${owner}/${repo}`,
        404,
      );
    }

    // Optimistic concurrency: reject if the file changed since the GET.
    if (file.sha !== fileSha) {
      return repoError(
        "conflict",
        "The configuration file has changed since you loaded it. Reload and reapply your edits.",
        409,
      );
    }

    // Apply the edit with structure-preserving YAML round-trip.
    const updatedContent = applyRoleEdit(
      file.content,
      roleName,
      sanitizedDescription,
      sanitizedInstructions,
    );
    if (updatedContent === null) {
      return repoError(
        "role_not_found",
        `Role "${roleName}" not found in ${HIVEMOOT_CONFIG_PATH}`,
        404,
      );
    }

    // Ensure the edit branch exists. Only create/reset it when there's no existing PR;
    // if a PR is already open, the branch exists and may be ahead of the default branch.
    let defaultBranch: string | undefined;
    if (!editPR) {
      defaultBranch = await getDefaultBranch(owner, repo, installationToken);
      const baseSha = await getBranchSha(owner, repo, defaultBranch, installationToken);
      if (!baseSha) {
        return repoError("server_error", `Could not resolve ${defaultBranch} branch SHA`, 500);
      }
      // Try to force-reset the branch to the default branch first. If it doesn't exist
      // yet, resetBranchToSha returns null and we create it fresh. This handles the
      // stale-branch case where a previous hivemoot-role-edits PR was merged/closed
      // but the branch was not deleted: createBranch would throw because the stale
      // branch tip diverges from baseSha.
      const reset = await resetBranchToSha(owner, repo, ROLE_EDIT_BRANCH, baseSha, installationToken);
      if (reset === null) {
        await createBranch(owner, repo, ROLE_EDIT_BRANCH, baseSha, installationToken);
      }
    }

    // Write the updated config to the edit branch.
    await writeFileToBranch(
      owner,
      repo,
      HIVEMOOT_CONFIG_PATH,
      updatedContent,
      `chore(roles): update ${roleName} via hivemoot.dev`,
      ROLE_EDIT_BRANCH,
      installationToken,
      file.sha,
    );

    // Open a PR if one doesn't exist yet.
    let prNumber: number;
    let prUrl: string;
    if (editPR) {
      prNumber = editPR.number;
      prUrl = editPR.url;
    } else {
      const newPR = await createPullRequest(
        owner,
        repo,
        "chore(roles): update agent role instructions via hivemoot.dev",
        ROLE_EDIT_BRANCH,
        `This PR was opened automatically by hivemoot.dev.\n\nUpdates role instructions in \`${HIVEMOOT_CONFIG_PATH}\`. Review and merge to apply.`,
        installationToken,
        defaultBranch!,
      );
      prNumber = newPR.number;
      prUrl = newPR.url;
    }

    const responseBody: PutRolesResponse = {
      prNumber,
      prUrl,
      source: `pending-pr:${prNumber}`,
    };
    return NextResponse.json(responseBody, { status: editPR ? 200 : 201 });
  } catch (error) {
    console.error("[repos/roles] Failed to write role edit", {
      installationId: auth.session.installationId,
      owner,
      repo,
      roleName,
      error,
    });
    return repoError("server_error", "Failed to write role edit", 500);
  }
}
