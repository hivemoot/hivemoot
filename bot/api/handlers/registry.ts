import type { HandlerEventMap } from "./types.js";
import {
  installationCreatedLabelBootstrapHandler,
  installationRepositoriesAddedLabelBootstrapHandler,
} from "./label-bootstrap.handler.js";
import {
  installationCreatedOnboardingHandler,
  installationRepositoriesAddedOnboardingHandler,
} from "./onboarding.handler.js";

export const handlerEventMap: HandlerEventMap = {
  "installation.created": [
    installationCreatedLabelBootstrapHandler,
    installationCreatedOnboardingHandler,
  ],
  "installation_repositories.added": [
    installationRepositoriesAddedLabelBootstrapHandler,
    installationRepositoriesAddedOnboardingHandler,
  ],
};
