import { validateEnv } from "@/server/env";
import { generateAppJwt } from "@/server/github-auth";

const GITHUB_API_VERSION = "2022-11-28";

export const TASK_REPO_UNAVAILABLE_MESSAGE =
  "One or more requested repositories aren't available to the current Hivemoot installation.";
export const TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE =
  "Repository access checks are unavailable right now. Please retry shortly.";

type TaskRepoPreflightResult =
  | { ok: true }
  | { ok: false; reason: "repo_unavailable" | "server_error"; message: string };

export async function preflightTaskRepos(
  repos: string[],
  installationId: string,
): Promise<TaskRepoPreflightResult> {
  const env = validateEnv();
  if (!env.ok || !env.config.githubAppId || !env.config.githubAppPrivateKey) {
    console.error("[task-repo-preflight] GitHub App credentials are unavailable", {
      installationId,
      hasEnvConfig: env.ok,
    });
    return {
      ok: false,
      reason: "server_error",
      message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
    };
  }

  let appJwt: string;
  try {
    appJwt = generateAppJwt(env.config.githubAppId, env.config.githubAppPrivateKey);
  } catch (error) {
    console.error("[task-repo-preflight] GitHub App JWT generation failed", {
      installationId,
      error,
    });
    return {
      ok: false,
      reason: "server_error",
      message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
    };
  }

  for (const repo of repos) {
    const [owner, name] = repo.split("/");

    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${owner}/${name}/installation`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      });
    } catch (error) {
      console.error("[task-repo-preflight] GitHub installation lookup failed", {
        installationId,
        repo,
        error,
      });
      return {
        ok: false,
        reason: "server_error",
        message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
      };
    }

    if (response.status === 404) {
      return {
        ok: false,
        reason: "repo_unavailable",
        message: TASK_REPO_UNAVAILABLE_MESSAGE,
      };
    }

    if (!response.ok) {
      console.error("[task-repo-preflight] GitHub installation lookup returned unexpected status", {
        installationId,
        repo,
        status: response.status,
      });
      return {
        ok: false,
        reason: "server_error",
        message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
      };
    }

    let data: { id?: number };
    try {
      data = await response.json() as { id?: number };
    } catch (error) {
      console.error("[task-repo-preflight] GitHub installation lookup returned invalid JSON", {
        installationId,
        repo,
        error,
      });
      return {
        ok: false,
        reason: "server_error",
        message: TASK_REPO_PREFLIGHT_UNAVAILABLE_MESSAGE,
      };
    }

    if (String(data.id) !== installationId) {
      return {
        ok: false,
        reason: "repo_unavailable",
        message: TASK_REPO_UNAVAILABLE_MESSAGE,
      };
    }
  }

  return { ok: true };
}
