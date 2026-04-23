import { createOnboardingService } from "../lib/index.js";
import { listAccessibleInstallationRepositories } from "./installation-repos.js";
import type { InstallationPayload, InstallationRepoPayload } from "./installation-repos.js";
import type { Handler, HandlerEvent } from "./types.js";

interface OnboardingWebhookContext {
  octokit: unknown;
  log: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  payload: InstallationPayload;
}

function getOnboardingWebhookContext(event: HandlerEvent): OnboardingWebhookContext {
  return event.context as OnboardingWebhookContext;
}

function getOwner(repository: InstallationRepoPayload): string {
  const ownerFromFullName = repository.full_name.split("/")[0];
  return repository.owner?.login ?? ownerFromFullName ?? "";
}

async function createOnboardingForRepositories(
  context: OnboardingWebhookContext,
  repositories: readonly InstallationRepoPayload[] | undefined,
  eventName: string,
): Promise<void> {
  const payloadRepositories = repositories ?? [];
  let targetRepositories: readonly InstallationRepoPayload[] = payloadRepositories;

  if (targetRepositories.length === 0) {
    context.log.info(
      `[${eventName}] Repository list missing from payload; fetching installation repositories`,
    );
    targetRepositories = await listAccessibleInstallationRepositories(context.octokit, eventName);
  }

  if (targetRepositories.length === 0) {
    context.log.info(`[${eventName}] No installation repositories available; skipping onboarding PR creation`);
    return;
  }

  let service: ReturnType<typeof createOnboardingService>;
  try {
    service = createOnboardingService(context.octokit);
  } catch {
    context.log.info(`[${eventName}] Onboarding service unavailable; skipping onboarding PR creation`);
    return;
  }

  for (const repository of targetRepositories) {
    const owner = getOwner(repository);
    const { name: repo, full_name: fullName } = repository;
    try {
      const result = await service.createOnboardingPR(owner, repo);
      if (result.skipped) {
        context.log.info(`[${eventName}] Onboarding PR skipped for ${fullName}: ${result.reason}`);
      } else {
        context.log.info(
          `[${eventName}] Onboarding PR #${result.prNumber} created for ${fullName}: ${result.prUrl}`,
        );
      }
    } catch (error) {
      context.log.error({ err: error, repo: fullName }, `[${eventName}] Failed to create onboarding PR`);
    }
  }
}

function createOnboardingHandler(
  name: string,
  repositorySelector: (payload: InstallationPayload) => readonly InstallationRepoPayload[] | undefined,
): Handler {
  return {
    name,
    async handle(event) {
      const context = getOnboardingWebhookContext(event);
      await createOnboardingForRepositories(
        context,
        repositorySelector(context.payload),
        event.name,
      );
    },
  };
}

export const installationCreatedOnboardingHandler = createOnboardingHandler(
  "onboarding-installation-created",
  (payload) => payload.repositories,
);

export const installationRepositoriesAddedOnboardingHandler = createOnboardingHandler(
  "onboarding-installation-repositories-added",
  (payload) => payload.repositories_added,
);
