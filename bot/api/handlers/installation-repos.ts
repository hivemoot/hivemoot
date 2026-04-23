export interface InstallationRepoPayload {
  owner?: { login?: string } | null;
  name: string;
  full_name: string;
}

export interface InstallationPayload {
  repositories?: readonly InstallationRepoPayload[];
  repositories_added?: readonly InstallationRepoPayload[];
}

interface InstallationRepoListClient {
  rest: {
    apps: {
      listReposAccessibleToInstallation: (params: {
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: {
          repositories?: InstallationRepoPayload[];
        };
      }>;
    };
  };
}

const INSTALLATION_REPO_PAGE_SIZE = 100;

export function hasInstallationRepoListClient(octokit: unknown): octokit is InstallationRepoListClient {
  if (typeof octokit !== "object" || octokit === null) {
    return false;
  }

  const client = octokit as {
    rest?: {
      apps?: {
        listReposAccessibleToInstallation?: unknown;
      };
    };
  };

  return typeof client.rest?.apps?.listReposAccessibleToInstallation === "function";
}

export async function listAccessibleInstallationRepositories(
  octokit: unknown,
  eventName: string,
): Promise<InstallationRepoPayload[]> {
  if (!hasInstallationRepoListClient(octokit)) {
    throw new Error(
      `[${eventName}] Unable to list installation repositories: missing apps.listReposAccessibleToInstallation`,
    );
  }

  const repositories: InstallationRepoPayload[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({
      per_page: INSTALLATION_REPO_PAGE_SIZE,
      page,
    });

    const pageRepositories = Array.isArray(data.repositories) ? data.repositories : [];
    repositories.push(...pageRepositories);

    if (pageRepositories.length < INSTALLATION_REPO_PAGE_SIZE) {
      break;
    }
    page += 1;
  }

  return repositories;
}
