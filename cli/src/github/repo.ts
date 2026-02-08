import { CliError, type RepoRef } from "../config/types.js";
import { gh } from "./client.js";

const GITHUB_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export async function resolveRepo(repoFlag?: string): Promise<RepoRef> {
  if (repoFlag) {
    const parts = repoFlag.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new CliError(
        `Invalid repo format: "${repoFlag}". Expected OWNER/REPO`,
        "GH_ERROR",
        1,
      );
    }
    if (!GITHUB_NAME_RE.test(parts[0]) || !GITHUB_NAME_RE.test(parts[1])) {
      throw new CliError(
        `Invalid repo name: "${repoFlag}". Owner and repo must match ${GITHUB_NAME_RE}`,
        "GH_ERROR",
        1,
      );
    }
    return { owner: parts[0], repo: parts[1] };
  }

  try {
    const json = await gh(["repo", "view", "--json", "owner,name"]);
    let data: { owner?: { login?: string } | string; name?: string };
    try {
      data = JSON.parse(json);
    } catch {
      throw new CliError(
        "Failed to parse repo info from gh CLI. Use --repo OWNER/REPO",
        "GH_ERROR",
        1,
      );
    }
    // gh returns owner as an object { login: "..." } not a plain string
    const owner =
      typeof data.owner === "object" && data.owner !== null
        ? data.owner.login
        : data.owner;
    const name = data.name;
    if (typeof owner !== "string" || !owner || typeof name !== "string" || !name) {
      throw new CliError(
        "Could not detect repo owner/name. Use --repo OWNER/REPO",
        "NOT_GIT_REPO",
        2,
      );
    }
    return { owner, repo: name };
  } catch (err) {
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(
      "Not in a git repository. Use --repo OWNER/REPO",
      "NOT_GIT_REPO",
      2,
    );
  }
}
