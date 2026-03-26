/**
 * GitHub Contents API helpers.
 *
 * Thin wrappers around the GitHub REST Contents API for reading and writing
 * files in repositories. All functions take a pre-acquired installation access
 * token (see `generateInstallationToken` in `github-auth.ts`).
 *
 * Design notes:
 * - `readRepoFile` returns the decoded UTF-8 content and the blob SHA needed
 *   for subsequent writes (optimistic concurrency via the `sha` field).
 * - `writeFileToBranch` creates or updates a file on a named branch. Callers
 *   are responsible for creating the branch first via `createBranch`.
 * - `createBranch` is idempotent: returns without error if the branch already
 *   exists at the expected base SHA.
 * - `listOpenPRsForBranch` finds open PRs where head matches a given branch,
 *   so callers can check for an existing edit PR before opening a new one.
 */

const GH_API = "https://api.github.com";

function ghHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoFile {
  /** Decoded UTF-8 content of the file. */
  content: string;
  /** Blob SHA required for subsequent writes to this path. */
  sha: string;
}

export interface BranchInfo {
  /** The full ref name (e.g. "refs/heads/my-branch"). */
  ref: string;
  /** The commit SHA the branch points to. */
  sha: string;
}

export interface OpenPR {
  number: number;
  title: string;
  /** The full head ref (e.g. "owner:branch-name"). */
  headRef: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads a file from a repository at the default branch (or a named ref).
 *
 * Returns `null` when the path does not exist (404). Throws on other errors.
 */
export async function readRepoFile(
  owner: string,
  repo: string,
  path: string,
  token: string,
  ref?: string,
): Promise<RepoFile | null> {
  const url = new URL(`${GH_API}/repos/${owner}/${repo}/contents/${path}`);
  if (ref) url.searchParams.set("ref", ref);

  const response = await fetch(url.toString(), { headers: ghHeaders(token) });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub contents read failed: ${response.status} on ${owner}/${repo}/${path}`);
  }

  const data = (await response.json()) as {
    content: string;
    sha: string;
    encoding: string;
    type: string;
  };

  if (data.type !== "file") {
    throw new Error(`Expected a file at ${path}, got ${data.type}`);
  }
  if (data.encoding !== "base64") {
    throw new Error(`Unexpected encoding from GitHub Contents API: ${data.encoding}`);
  }

  // GitHub base64-encodes with embedded newlines; strip them before decoding.
  const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
  return { content, sha: data.sha };
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

/**
 * Resolves the current HEAD SHA of a branch.
 *
 * Returns `null` when the branch does not exist.
 */
export async function getBranchSha(
  owner: string,
  repo: string,
  branch: string,
  token: string,
): Promise<string | null> {
  const response = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
    { headers: ghHeaders(token) },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub ref lookup failed: ${response.status} on ${owner}/${repo} heads/${branch}`);
  }

  const data = (await response.json()) as { object: { sha: string } };
  return data.object.sha;
}

/**
 * Creates a new branch pointing to `baseSha`.
 *
 * Idempotent: returns without error if the branch already exists at `baseSha`.
 * Throws if the branch exists but points to a different commit.
 */
export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  baseSha: string,
  token: string,
): Promise<BranchInfo> {
  const response = await fetch(`${GH_API}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  if (response.status === 422) {
    // Branch already exists. Verify it's at the expected SHA.
    const existingSha = await getBranchSha(owner, repo, branch, token);
    if (existingSha === baseSha) {
      return { ref: `refs/heads/${branch}`, sha: baseSha };
    }
    throw new Error(
      `Branch ${branch} already exists at ${existingSha}, expected ${baseSha}`,
    );
  }

  if (!response.ok) {
    throw new Error(`GitHub create branch failed: ${response.status} on ${owner}/${repo} ${branch}`);
  }

  const data = (await response.json()) as { ref: string; object: { sha: string } };
  return { ref: data.ref, sha: data.object.sha };
}

/**
 * Force-resets a branch to `targetSha`.
 *
 * Use this to reclaim a stale branch (e.g. one left over from a previously
 * merged edit PR) without deleting and recreating it. Sets `force: true`
 * so the update succeeds even when `targetSha` is not a descendant of the
 * current branch tip.
 *
 * Returns `null` when the branch does not exist (treat as a no-op and call
 * `createBranch` instead).
 */
export async function resetBranchToSha(
  owner: string,
  repo: string,
  branch: string,
  targetSha: string,
  token: string,
): Promise<BranchInfo | null> {
  const response = await fetch(
    `${GH_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: "PATCH",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ sha: targetSha, force: true }),
    },
  );

  if (response.status === 422) {
    // 422 from PATCH means the ref doesn't exist.
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub reset branch failed: ${response.status} on ${owner}/${repo} heads/${branch}`,
    );
  }

  const data = (await response.json()) as { ref: string; object: { sha: string } };
  return { ref: data.ref, sha: data.object.sha };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Creates or updates a file on a specific branch.
 *
 * `fileSha` must be the current blob SHA of the file (from `readRepoFile`) to
 * update an existing file. Omit it to create a new file.
 */
export async function writeFileToBranch(
  owner: string,
  repo: string,
  path: string,
  content: string,
  commitMessage: string,
  branch: string,
  token: string,
  fileSha?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    message: commitMessage,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (fileSha) body.sha = fileSha;

  const response = await fetch(`${GH_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `GitHub contents write failed: ${response.status} on ${owner}/${repo}/${path} — ${detail}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * Returns the default branch name for a repository (e.g. "main", "master", "trunk").
 *
 * Uses the GitHub Repos API so we never assume a hardcoded branch name.
 * Throws on API errors.
 */
export async function getDefaultBranch(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const response = await fetch(`${GH_API}/repos/${owner}/${repo}`, {
    headers: ghHeaders(token),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub repo lookup failed: ${response.status} on ${owner}/${repo}`,
    );
  }

  const data = (await response.json()) as { default_branch: string };
  return data.default_branch;
}

/**
 * Lists open PRs where the head branch matches `headBranch`.
 *
 * `headBranch` should be the unqualified branch name (e.g. "my-edits"),
 * not the full ref. GitHub matches it as `{owner}:{branch}` internally.
 */
export async function listOpenPRsForBranch(
  owner: string,
  repo: string,
  headBranch: string,
  token: string,
): Promise<OpenPR[]> {
  const url = new URL(`${GH_API}/repos/${owner}/${repo}/pulls`);
  url.searchParams.set("state", "open");
  url.searchParams.set("head", `${owner}:${headBranch}`);

  const response = await fetch(url.toString(), { headers: ghHeaders(token) });

  if (!response.ok) {
    throw new Error(`GitHub PR list failed: ${response.status} on ${owner}/${repo}`);
  }

  const data = (await response.json()) as Array<{
    number: number;
    title: string;
    head: { label: string };
    html_url: string;
  }>;

  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRef: pr.head.label,
    url: pr.html_url,
  }));
}

/**
 * Opens a pull request from `headBranch` into `base`.
 *
 * `base` must be the repo's actual default branch name — use `getDefaultBranch`
 * to resolve it rather than assuming "main".
 */
export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  headBranch: string,
  body: string,
  token: string,
  base: string,
): Promise<OpenPR> {
  const response = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title, head: headBranch, base, body }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `GitHub create PR failed: ${response.status} on ${owner}/${repo} — ${detail}`,
    );
  }

  const data = (await response.json()) as {
    number: number;
    title: string;
    head: { label: string };
    html_url: string;
  };

  return {
    number: data.number,
    title: data.title,
    headRef: data.head.label,
    url: data.html_url,
  };
}
