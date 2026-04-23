/**
 * Onboarding PR Service
 *
 * Auto-creates a "Configure Hivemoot" PR when the app is installed on a
 * repository. Follows the Renovate pattern for immediate visible feedback.
 *
 * Three-layer idempotency:
 *   1. Config file already exists → skip
 *   2. Open onboarding PR already exists → skip
 *   3. Branch already exists (422) → continue to PR creation
 */

import { validateClient } from "./client-validation.js";
import { getErrorStatus } from "./github-client.js";

export const ONBOARDING_BRANCH = "hivemoot/configure";
const ONBOARDING_CONFIG_PATH = ".github/hivemoot.yml";
const ONBOARDING_COMMIT_MESSAGE = "Add Hivemoot configuration";

const ONBOARDING_CONFIG_CONTENT = `# Hivemoot Configuration
# Docs: https://github.com/hivemoot/hivemoot-bot#configuration
#
# Merging this PR activates Hivemoot governance on this repository.
# Close without merging to opt out of auto-governance for now.

version: 1

# ── Team ────────────────────────────────────────────────────────────
# Roles define agent personas — who they are, not what they do.
# Customize the roles below or add your own.

team:
  # onboarding: |
  #   Read CONTRIBUTING.md before starting work.

  roles:
    pm:
      description: "Product manager focused on user value and clarity"
      instructions: |
        You think from the user's perspective.
        Evaluate ideas by the problem they solve and who benefits.
        Push for clear requirements and well-scoped proposals.

    engineer:
      description: "Software engineer focused on clean implementation"
      instructions: |
        You care about code quality, patterns, and maintainability.
        Favor simple, proven approaches over clever solutions.
        Write clean code with good test coverage.

    reviewer:
      description: "Code reviewer focused on correctness and edge cases"
      instructions: |
        You think about what can go wrong.
        Find edge cases, race conditions, and failure modes others miss.
        Push for thorough error handling and defensive design.

# ── Governance ──────────────────────────────────────────────────────

governance:
  proposals:
    # Discussion phase — open conversation before a decision
    discussion:
      exits:
        - type: manual
        # Uncomment for automatic progression after 24 hours:
        # - type: auto
        #   afterMinutes: 1440

    # Resolution phase — the group decides whether to proceed
    voting:
      exits:
        - type: manual
        # Uncomment for automatic resolution after 24 hours:
        # - type: auto
        #   afterMinutes: 1440
        #   requires: majority   # "majority" or "unanimous"
        #   minVoters: 3

    # Extended resolution — second round for ties/inconclusive results
    extendedVoting:
      exits:
        - type: manual
        # Uncomment for automatic resolution:
        # - type: auto
        #   afterMinutes: 1440
        #   requires: majority
        #   minVoters: 3

  # Uncomment the pr: section to enable PR automation (stale warnings, intake, merge-readiness).
  # When commented out, Hivemoot does not manage PRs at all.
  # pr:
  #   staleDays: 3            # Days of inactivity before a PR is marked stale
  #   maxPRsPerIssue: 3       # Max competing implementations per issue
  #   trustedReviewers: []    # GitHub usernames whose approvals count for intake/merge-ready
  #   intake:
  #     - method: auto        # Pre-ready PRs activate immediately when issue becomes ready (default)
  #   mergeReady:             # Omit to disable merge-ready automation
  #     minApprovals: 1

# standup:
#   enabled: true
#   category: "Hivemoot Reports"
`;

const ONBOARDING_PR_TITLE = "Configure Hivemoot";
const ONBOARDING_PR_BODY = `Welcome to Hivemoot! 🐝

This PR adds a default \`.github/hivemoot.yml\` configuration file.

## What merging this PR does

- Issues automatically enter the governance lifecycle: discussion → voting → implementation
- PRs linked to approved issues are tracked for implementation competition
- Stale PR warnings run on a schedule

## What closing this PR (without merging) does

Nothing. Hivemoot stays installed but runs no automations until a config file exists.

## Customize before merging

Edit \`.github/hivemoot.yml\` in this PR to adjust timing, PR limits, or trusted reviewers. See the [configuration reference](https://github.com/hivemoot/hivemoot-bot#configuration) for all options.`;

export interface OnboardingClient {
  rest: {
    repos: {
      get: (params: {
        owner: string;
        repo: string;
      }) => Promise<{
        data: {
          default_branch: string;
          archived: boolean;
          disabled: boolean;
        };
      }>;
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<unknown>;
      createOrUpdateFileContents: (params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        branch: string;
      }) => Promise<unknown>;
    };
    git: {
      getRef: (params: {
        owner: string;
        repo: string;
        ref: string;
      }) => Promise<{
        data: {
          object: { sha: string };
        };
      }>;
      createRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        sha: string;
      }) => Promise<unknown>;
    };
    pulls: {
      list: (params: {
        owner: string;
        repo: string;
        state: string;
        head: string;
        per_page?: number;
      }) => Promise<{
        data: Array<{ number: number; html_url: string; state: string }>;
      }>;
      create: (params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
      }) => Promise<{
        data: { number: number; html_url: string };
      }>;
    };
  };
}

function isValidOnboardingClient(obj: unknown): obj is OnboardingClient {
  return validateClient(obj, [
    {
      path: "rest.repos",
      requiredMethods: ["get", "getContent", "createOrUpdateFileContents"],
    },
    {
      path: "rest.git",
      requiredMethods: ["getRef", "createRef"],
    },
    {
      path: "rest.pulls",
      requiredMethods: ["list", "create"],
    },
  ]);
}

export interface OnboardingResult {
  skipped: boolean;
  reason?: string;
  prNumber?: number;
  prUrl?: string;
}

export class OnboardingService {
  constructor(private client: OnboardingClient) {}

  async createOnboardingPR(owner: string, repo: string): Promise<OnboardingResult> {
    const { data: repoData } = await this.client.rest.repos.get({ owner, repo });
    if (repoData.archived) {
      return { skipped: true, reason: "archived" };
    }
    if (repoData.disabled) {
      return { skipped: true, reason: "disabled" };
    }

    const defaultBranch = repoData.default_branch;

    const configExists = await this.checkConfigExists(owner, repo);
    if (configExists) {
      return { skipped: true, reason: "config-exists" };
    }

    const existingPR = await this.findExistingOnboardingPR(owner, repo, owner);
    if (existingPR) {
      if (existingPR.state === "closed") {
        return { skipped: true, reason: "pr-dismissed", prNumber: existingPR.number, prUrl: existingPR.html_url };
      }
      return { skipped: true, reason: "pr-exists", prNumber: existingPR.number, prUrl: existingPR.html_url };
    }

    let headSha: string;
    try {
      const { data: refData } = await this.client.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${defaultBranch}`,
      });
      headSha = refData.object.sha;
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return { skipped: true, reason: "empty-repo" };
      }
      throw error;
    }

    try {
      await this.client.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${ONBOARDING_BRANCH}`,
        sha: headSha,
      });
    } catch (error) {
      if (getErrorStatus(error) !== 422) {
        throw error;
      }
    }

    const content = Buffer.from(ONBOARDING_CONFIG_CONTENT).toString("base64");
    try {
      await this.client.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: ONBOARDING_CONFIG_PATH,
        message: ONBOARDING_COMMIT_MESSAGE,
        content,
        branch: ONBOARDING_BRANCH,
      });
    } catch (error) {
      if (getErrorStatus(error) !== 422) {
        throw error;
      }
    }

    try {
      const { data: pr } = await this.client.rest.pulls.create({
        owner,
        repo,
        title: ONBOARDING_PR_TITLE,
        body: ONBOARDING_PR_BODY,
        head: ONBOARDING_BRANCH,
        base: defaultBranch,
      });
      return { skipped: false, prNumber: pr.number, prUrl: pr.html_url };
    } catch (error) {
      if (getErrorStatus(error) !== 422) {
        throw error;
      }
      const existingPR = await this.findExistingOnboardingPR(owner, repo, owner);
      if (existingPR) {
        const reason = existingPR.state === "closed" ? "pr-dismissed" : "pr-exists";
        return { skipped: true, reason, prNumber: existingPR.number, prUrl: existingPR.html_url };
      }
      throw error;
    }
  }

  private async checkConfigExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.client.rest.repos.getContent({ owner, repo, path: ONBOARDING_CONFIG_PATH });
      return true;
    } catch (error) {
      if (getErrorStatus(error) === 404) {
        return false;
      }
      throw error;
    }
  }

  private async findExistingOnboardingPR(
    owner: string,
    repo: string,
    repoOwner: string,
  ): Promise<{ number: number; html_url: string; state: string } | null> {
    const { data: prs } = await this.client.rest.pulls.list({
      owner,
      repo,
      state: "all",
      head: `${repoOwner}:${ONBOARDING_BRANCH}`,
      per_page: 1,
    });
    return prs[0] ?? null;
  }
}

export function createOnboardingService(octokit: unknown): OnboardingService {
  if (!isValidOnboardingClient(octokit)) {
    throw new Error(
      "Invalid GitHub client: expected an Octokit-like object with rest.repos.get, rest.repos.getContent, rest.repos.createOrUpdateFileContents, rest.git.getRef, rest.git.createRef, rest.pulls.list, and rest.pulls.create"
    );
  }
  return new OnboardingService(octokit);
}
