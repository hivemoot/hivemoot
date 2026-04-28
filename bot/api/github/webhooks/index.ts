import { createNodeMiddleware, createProbot, Probot } from "probot";
import type { IncomingMessage, ServerResponse } from "http";
import {
  LABELS,
  MESSAGES,
  PR_MESSAGES,
  isLabelMatch,
} from "../../config.js";
import {
  createIssueOperations,
  createPROperations,
  createGovernanceService,
  loadRepositoryConfig,
  getOpenPRsForIssue,
  evaluateMergeReadiness,
  evaluateAutomerge,
} from "../../lib/index.js";
import {
  getLinkedIssues,
  disablePullRequestAutoMerge,
} from "../../lib/graphql-queries.js";
import { isAutoMergeNotEnabledError } from "../../lib/transient-error.js";
import { hasSameRepoClosingKeywordRef } from "../../lib/closing-keywords.js";
import { filterByLabel } from "../../lib/types.js";
import { validateEnv, getAppId } from "../../lib/env-validation.js";
import {
  processImplementationIntake,
  recalculateLeaderboardForPR,
} from "../../lib/implementation-intake.js";
import { parseCommand, executeCommand, retryQueuedSquash, autoGatherIfEligible } from "../../lib/commands/index.js";
import { getLLMReadiness } from "../../lib/llm/provider.js";
import { registerHandlerDispatcher } from "../../handlers/dispatcher.js";
import { handlerEventMap } from "../../handlers/registry.js";
import { maybeCreatePrReviewRoom, maybeEmitSubjectUpdated } from "../../lib/war-room-routing.js";

/**
 * Hivemoot Bot - Governance Automation
 *
 * Handles GitHub webhooks for AI agent community governance:
 * - New issues: Add `hivemoot:discussion` label + welcome message
 * - New PRs: Link validation, implementation intake, and leaderboard tracking
 * - Issue/PR comments: @mention + /command dispatch and PR intake updates
 * - PR lifecycle: Merge outcomes, competing PR closure, stale management
 * - Reviews & CI: Leaderboard recalculation, merge-readiness evaluation
 * - Installation: Label bootstrapping for new repositories
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** GitHub review states */
const REVIEW_STATE = {
  APPROVED: "approved",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Repository context extracted from webhook payloads */
interface RepoContext {
  owner: string;
  repo: string;
  fullName: string;
}

interface RepoPayload {
  owner?: { login?: string } | null;
  name: string;
  full_name: string;
}
const PR_OPENED_LINK_RETRY_DELAY_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/** Check if a PR targets the repository's default branch */
function targetsDefaultBranch(
  pullRequest: { base: { ref: string } },
  repository: { default_branch?: string },
): boolean {
  return !repository.default_branch || pullRequest.base.ref === repository.default_branch;
}

/** Extract repository context from webhook payload */
function getRepoContext(repository: RepoPayload): RepoContext {
  const ownerFromFullName = repository.full_name.split("/")[0];
  const owner = repository.owner?.login ?? ownerFromFullName;
  if (!owner) {
    throw new Error(`Unable to determine repository owner from '${repository.full_name}'`);
  }
  return {
    owner,
    repo: repository.name,
    fullName: repository.full_name,
  };
}

export function app(probotApp: Probot): void {
  probotApp.log.info("Queen bot initialized");
  registerHandlerDispatcher(probotApp, { eventMap: handlerEventMap });

  probotApp.on("issues.opened", async (context) => {
    const { number } = context.payload.issue;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing issue #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const governance = createGovernanceService(issues);
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping issue automation`);
        return;
      }
      const hasAutomaticDiscussion = repoConfig.governance.proposals.discussion.exits.some(
        (exit) => exit.type === "auto"
      );
      const issueWelcomeMessage =
        hasAutomaticDiscussion ? MESSAGES.ISSUE_WELCOME_VOTING : MESSAGES.ISSUE_WELCOME_MANUAL;
      const installationId = context.payload.installation?.id;

      await governance.startDiscussion(
        { owner, repo, issueNumber: number, installationId },
        issueWelcomeMessage
      );
    } catch (error) {
      context.log.error({ err: error, issue: number, repo: fullName }, "Failed to process issue");
      throw error;
    }
  });

  probotApp.on("pull_request.opened", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR #${number} in ${fullName}`);

    // Skip governance processing for PRs targeting non-default branches (stacked PRs)
    if (!targetsDefaultBranch(context.payload.pull_request, context.payload.repository)) {
      context.log.info(
        { owner, repo, pr: number, base: context.payload.pull_request.base.ref },
        "Skipping PR intake — targets non-default branch"
      );
      return;
    }

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [initialLinkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping PR automation`);
        return;
      }
      let linkedIssues = initialLinkedIssues;
      const hasBodyClosingKeyword = linkedIssues.length === 0
        ? hasSameRepoClosingKeywordRef(context.payload.pull_request.body, { owner, repo })
        : false;
      let didRetry = false;

      if (linkedIssues.length === 0 && hasBodyClosingKeyword) {
        context.log.info(
          {
            owner,
            repo,
            pr: number,
            retryDelayMs: PR_OPENED_LINK_RETRY_DELAY_MS,
          },
          "PR opened with closing keywords but no linked issues; retrying lookup"
        );
        await delay(PR_OPENED_LINK_RETRY_DELAY_MS);
        linkedIssues = await getLinkedIssues(context.octokit, owner, repo, number);
        didRetry = true;
      }

      // Unlinked PRs get a warning; linked PRs are handled by processImplementationIntake
      if (linkedIssues.length === 0) {
        if (hasBodyClosingKeyword) {
          context.log.warn(
            { owner, repo, pr: number, resolutionSource: "heuristic-suppressed" },
            "PR opened with closing keywords but linked issues remained empty after retry; suppressing warning"
          );
        } else {
          await issues.comment({ owner, repo, issueNumber: number }, MESSAGES.PR_NO_LINKED_ISSUE);
          context.log.info(
            { owner, repo, pr: number, resolutionSource: "none" },
            "PR opened with no linked issues and no closing keywords; posted warning"
          );
        }
      } else {
        const resolutionSource = didRetry ? "retry" : "initial";
        context.log.info(
          { owner, repo, pr: number, linkedIssueCount: linkedIssues.length, resolutionSource },
          "Resolved linked issues for opened PR"
        );
      }

      if (repoConfig.governance.pr) {
        await processImplementationIntake({
          octokit: context.octokit,
          issues,
          prs,
          log: context.log,
          owner,
          repo,
          prNumber: number,
          linkedIssues,
          trigger: "opened",
          maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          intake: repoConfig.governance.pr.intake,
        });

        await evaluateAutomerge({
          prs,
          ref: { owner, repo, prNumber: number },
          config: repoConfig.governance.pr.automerge,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          nodeId: context.payload.pull_request.node_id,
          draft: context.payload.pull_request.draft,
          mergeable: context.payload.pull_request.mergeable,
          log: context.log,
          graphql: context.octokit,
        });
      }

      // Phase E.1 — war-room routing. Non-fatal: a failure here
      // never breaks the existing intake / governance flow; the
      // routing helper logs + returns gracefully on errors. Gated
      // on `HIVEMOOT_BOT_AGENT_TOKEN` env var so the integration
      // is opt-in until Phase H fleet migration. Idempotent on
      // webhook re-delivery (server returns 409 subject_already_open
      // → routing helper reuses existingRoomId).
      await maybeCreatePrReviewRoom({
        owner,
        repo,
        prNumber: number,
        log: context.log,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR");
      throw error;
    }
  });

  /**
   * Handle PR updates (new commits) to activate pre-ready PRs.
   * Also clears transient merge automation labels since new commits reset CI and queued squash intent.
   */
  probotApp.on("pull_request.synchronize", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR update #${number} in ${fullName}`);

    if (!targetsDefaultBranch(context.payload.pull_request, context.payload.repository)) {
      context.log.info(
        { owner, repo, pr: number, base: context.payload.pull_request.base.ref },
        "Skipping PR update intake — targets non-default branch"
      );
      return;
    }

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping PR update automation`);
        return;
      }

      // New commits invalidate CI — optimistically remove merge-ready and automerge labels
      const prRef = { owner, repo, prNumber: number };
      const currentLabels = context.payload.pull_request.labels?.map((label: { name?: string }) => label.name ?? "") ?? [];
      const hadQueuedSquash = currentLabels.some((label) => isLabelMatch(label, LABELS.SQUASH_QUEUED));
      const hadAutomerge = currentLabels.some((label) => isLabelMatch(label, LABELS.AUTOMERGE));
      await prs.removeLabel(prRef, LABELS.MERGE_READY);
      await prs.removeLabel(prRef, LABELS.SQUASH_QUEUED);
      // Phase 2: disable native auto-merge before stripping the label so the two stay in sync.
      // On unexpected error, retain the label (matching removeIfLabeled's fail-closed contract).
      let skipAutomergeRemoval = false;
      if (hadAutomerge && repoConfig.governance.pr?.automerge && !repoConfig.governance.pr.automerge.dryRun) {
        try {
          await disablePullRequestAutoMerge(context.octokit, context.payload.pull_request.node_id);
        } catch (err) {
          if (isAutoMergeNotEnabledError(err)) {
            // auto-merge was never enabled — proceed with label removal
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            context.log.warn(`[PR #${number}] Failed to disable GitHub auto-merge on synchronize, retaining label for retry: ${msg}`);
            skipAutomergeRemoval = true;
          }
        }
      }
      if (!skipAutomergeRemoval) {
        await prs.removeLabel(prRef, LABELS.AUTOMERGE);
      }

      if (hadQueuedSquash) {
        await prs.comment(
          prRef,
          "Queued squash cancelled because new commits were pushed. Run `/squash` again when the branch is ready."
        );
      }

      if (repoConfig.governance.pr) {
        await processImplementationIntake({
          octokit: context.octokit,
          issues,
          prs,
          log: context.log,
          owner,
          repo,
          prNumber: number,
          linkedIssues,
          trigger: "updated",
          maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          intake: repoConfig.governance.pr.intake,
        });

        await evaluateAutomerge({
          prs,
          ref: prRef,
          config: repoConfig.governance.pr.automerge,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          nodeId: context.payload.pull_request.node_id,
          draft: context.payload.pull_request.draft,
          mergeable: context.payload.pull_request.mergeable,
          log: context.log,
          graphql: context.octokit,
        });
      }

      // Phase E.2 — emit subject_updated event for war-room workers.
      // Same non-fatal contract as E.1: failures log + return; never
      // break the existing intake flow. The deterministic roomId
      // derivation (derivePrRoomId) means we hit the same room as
      // the E.1 create call without any lookup.
      await maybeEmitSubjectUpdated({
        owner,
        repo,
        prNumber: number,
        changeKind: "synchronize",
        headSha: context.payload.pull_request.head?.sha,
        log: context.log,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR update");
      throw error;
    }
  });

  /**
   * Handle draft -> ready transition.
   * Re-runs merge-readiness/automerge evaluation when an author marks a PR ready.
   */
  probotApp.on("pull_request.ready_for_review", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    context.log.info(`Processing ready_for_review for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping ready_for_review automation`);
        return;
      }

      if (repoConfig.governance.pr) {
        const currentLabels = context.payload.pull_request.labels?.map(
          (l: { name: string }) => l.name
        );
        const prRef = { owner, repo, prNumber: number };

        await evaluateMergeReadiness({
          prs,
          ref: prRef,
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          currentLabels,
          draft: false,
          log: context.log,
        });

        await evaluateAutomerge({
          prs,
          ref: prRef,
          config: repoConfig.governance.pr.automerge,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          nodeId: context.payload.pull_request.node_id,
          currentLabels,
          draft: false,
          mergeable: context.payload.pull_request.mergeable,
          log: context.log,
          graphql: context.octokit,
        });
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process ready_for_review");
      throw error;
    }
  });

  /**
   * Handle ready -> draft transition.
   * Draft PRs cannot be merge-ready/automerge, so remove both labels immediately.
   */
  probotApp.on("pull_request.converted_to_draft", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    context.log.info(`Processing converted_to_draft for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping converted_to_draft automation`);
        return;
      }

      if (!repoConfig.governance.pr) return;

      const currentLabels = context.payload.pull_request.labels?.map((l: { name: string }) => l.name) ?? [];
      const hadMergeReady = currentLabels.some((label) => isLabelMatch(label, LABELS.MERGE_READY));
      const hadAutomerge = currentLabels.some((label) => isLabelMatch(label, LABELS.AUTOMERGE));

      if (!hadMergeReady && !hadAutomerge) return;

      const prRef = { owner, repo, prNumber: number };
      const removedLabels: string[] = [];

      if (hadMergeReady) {
        await prs.removeLabel(prRef, LABELS.MERGE_READY);
        removedLabels.push(LABELS.MERGE_READY);
      }
      if (hadAutomerge) {
        // Phase 2: disable native auto-merge before stripping the label so the two stay in sync.
        // On unexpected error, retain the label (matching removeIfLabeled's fail-closed contract).
        let skipAutomergeRemoval = false;
        if (repoConfig.governance.pr.automerge && !repoConfig.governance.pr.automerge.dryRun) {
          try {
            await disablePullRequestAutoMerge(context.octokit, context.payload.pull_request.node_id);
          } catch (err) {
            if (isAutoMergeNotEnabledError(err)) {
              // auto-merge was never enabled — proceed with label removal
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              context.log.warn(`[PR #${number}] Failed to disable GitHub auto-merge on converted_to_draft, retaining label for retry: ${msg}`);
              skipAutomergeRemoval = true;
            }
          }
        }
        if (!skipAutomergeRemoval) {
          await prs.removeLabel(prRef, LABELS.AUTOMERGE);
          removedLabels.push(LABELS.AUTOMERGE);
        }
      }

      if (hadMergeReady) {
        await prs.comment(prRef, PR_MESSAGES.prConvertedToDraft(removedLabels));
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process converted_to_draft");
      throw error;
    }
  });

  /**
   * Handle PR description edits to pick up newly added closing keywords.
   */
  probotApp.on("pull_request.edited", async (context) => {
    // Only body edits can change closing keywords — skip title/base changes
    if (!context.payload.changes?.body) {
      return;
    }

    if (!targetsDefaultBranch(context.payload.pull_request, context.payload.repository)) {
      return;
    }

    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(`Processing PR edit #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping PR edit automation`);
        return;
      }

      if (repoConfig.governance.pr) {
        await processImplementationIntake({
          octokit: context.octokit,
          issues,
          prs,
          log: context.log,
          owner,
          repo,
          prNumber: number,
          linkedIssues,
          trigger: "edited",
          maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          intake: repoConfig.governance.pr.intake,
          editedAt: new Date(context.payload.pull_request.updated_at),
        });
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR edit");
      throw error;
    }
  });

  /**
   * Handle comments on issues and PRs.
   *
   * Routes to either:
   * 1. Command handler — @mention + /command on issues or PRs
   * 2. PR intake processing — non-command comments on PRs
   */
  probotApp.on("issue_comment.created", async (context) => {
    const { issue, comment } = context.payload;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    try {
      const appId = getAppId();

      // Skip bot's own comments
      if (comment.performed_via_github_app?.id === appId) {
        return;
      }

      // Parse for @mention + /command before the PR-only filter,
      // so commands work on both issues and PRs
      const parsed = parseCommand(comment.body ?? "");
      if (parsed) {
        await executeCommand({
          octokit: context.octokit as Parameters<typeof executeCommand>[0]["octokit"],
          owner,
          repo,
          issueNumber: issue.number,
          installationId: context.payload.installation?.id,
          commentId: comment.id,
          senderLogin: comment.user.login,
          verb: parsed.verb,
          freeText: parsed.freeText,
          issueLabels: issue.labels?.map((l) =>
            typeof l === "string" ? { name: l } : { name: l.name ?? "" },
          ) ?? [],
          isPullRequest: !!issue.pull_request,
          appId,
          log: context.log,
        });
        return;
      }

      // Non-command comments on issues: check auto-gather eligibility (discussion issues only)
      if (!issue.pull_request) {
        const issueLabels = (issue.labels ?? []).map((l) =>
          typeof l === "string" ? { name: l } : { name: l.name ?? "" },
        );
        // Gate on discussion label from webhook payload — no API call needed.
        // Non-discussion issues account for the vast majority of comment events
        // and should fast-exit here without loading config.
        const isDiscussion = issueLabels.some((l) => isLabelMatch(l.name, LABELS.DISCUSSION));
        if (isDiscussion) {
          const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
          if (repoConfig?.governance.proposals.discussion.autoGather.enabled) {
            await autoGatherIfEligible({
              octokit: context.octokit as Parameters<typeof autoGatherIfEligible>[0]["octokit"],
              owner,
              repo,
              issueNumber: issue.number,
              installationId: context.payload.installation?.id,
              issueLabels,
              autoGatherConfig: repoConfig.governance.proposals.discussion.autoGather,
              appId,
              log: context.log,
            });
          }
        }
        return;
      }

      const prNumber = issue.number;
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });
      const [linkedIssues, repoConfig] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, prNumber),
        loadRepositoryConfig(context.octokit, owner, repo),
      ]);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping PR comment intake`);
        return;
      }

      if (repoConfig.governance.pr) {
        await processImplementationIntake({
          octokit: context.octokit,
          issues,
          prs,
          log: context.log,
          owner,
          repo,
          prNumber,
          linkedIssues,
          trigger: "updated",
          maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          intake: repoConfig.governance.pr.intake,
        });
      }
    } catch (error) {
      context.log.error({ err: error, issue: issue.number, repo: fullName }, "Failed to process comment");
      throw error;
    }
  });

  /**
   * Handle PR closed - if merged, close competing PRs and mark issue as implemented.
   * If closed without merge, recalculate leaderboard to remove the closed PR.
   */
  probotApp.on("pull_request.closed", async (context) => {
    const { number, merged } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    // PR closed without merge - clean governance labels and recalculate leaderboard
    if (!merged) {
      context.log.info(`PR #${number} closed without merge, cleaning up`);
      try {
        const appId = getAppId();
        const prs = createPROperations(context.octokit, { appId });
        const prRef = { owner, repo, prNumber: number };
        await prs.removeGovernanceLabels(prRef);
        await recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number);

        // Phase E.2 — emit subject_updated event signaling the PR
        // closed without merge. Workers' triage logic can short-
        // circuit on this; the watchdog will eventually expire the
        // room via max_age. Explicit terminate-on-close lands in a
        // future slice (capability scoping needed — bot doesn't
        // have rooms.force_close in the queen preset).
        await maybeEmitSubjectUpdated({
          owner,
          repo,
          prNumber: number,
          changeKind: "closed",
          log: context.log,
        });
      } catch (error) {
        context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process closed PR");
        throw error;
      }
      return;
    }

    // PR merged - mark linked issues as implemented and close competing PRs
    context.log.info(`Processing merged PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });

      const linkedIssues = await getLinkedIssues(context.octokit, owner, repo, number);

      // Clean governance labels from the merged PR
      const mergedPrRef = { owner, repo, prNumber: number };
      await prs.removeGovernanceLabels(mergedPrRef);

      for (const linkedIssue of filterByLabel(linkedIssues, LABELS.READY_TO_IMPLEMENT)) {
        const issueRef = { owner, repo, issueNumber: linkedIssue.number };

        // Transition issue to implemented state
        await issues.removeLabel(issueRef, LABELS.READY_TO_IMPLEMENT);
        await issues.addLabels(issueRef, [LABELS.IMPLEMENTED]);
        await issues.close(issueRef, "completed");
        await issues.comment(issueRef, PR_MESSAGES.issueImplemented(number));

        // Close competing PRs
        const competingPRs = await getOpenPRsForIssue(context.octokit, owner, repo, linkedIssue.number);
        for (const competingPR of competingPRs) {
          if (competingPR.number !== number) {
            const prRef = { owner, repo, prNumber: competingPR.number };
            await prs.close(prRef);
            await prs.comment(prRef, PR_MESSAGES.prSuperseded(number));
            await prs.removeGovernanceLabels(prRef);
            context.log.info(`Closed competing PR #${competingPR.number}`);
          }
        }
      }

      // Phase E.2 — subject_updated for merged PRs. Same rationale
      // as the closed-without-merge path: workers see the event
      // and short-circuit. Watchdog handles eventual room expiry.
      await maybeEmitSubjectUpdated({
        owner,
        repo,
        prNumber: number,
        changeKind: "closed",
        log: context.log,
      });
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process merged PR");
      throw error;
    }
  });

  /** Handle PR review submitted - update leaderboard, run intake on approvals, evaluate merge-readiness */
  probotApp.on("pull_request_review.submitted", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const isApproval = context.payload.review.state === REVIEW_STATE.APPROVED;

    context.log.info(`Processing review (${context.payload.review.state}) for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const prs = createPROperations(context.octokit, { appId });

      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping review automation`);
        return;
      }

      const [linkedIssues] = await Promise.all([
        getLinkedIssues(context.octokit, owner, repo, number),
        // Leaderboard recalc only on approvals
        isApproval
          ? recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number)
          : Promise.resolve(),
      ]);

      if (repoConfig.governance.pr) {
        // Intake processing only on approvals
        if (isApproval) {
          await processImplementationIntake({
            octokit: context.octokit,
            issues,
            prs,
            log: context.log,
            owner,
            repo,
            prNumber: number,
            linkedIssues,
            trigger: "updated",
            maxPRsPerIssue: repoConfig.governance.pr.maxPRsPerIssue,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            intake: repoConfig.governance.pr.intake,
          });
        }

        // Merge-readiness evaluation on ALL review states (approval may satisfy threshold,
        // non-approval may invalidate it via changes_requested/dismissal)
        await evaluateMergeReadiness({
          prs,
          ref: { owner, repo, prNumber: number },
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          log: context.log,
        });

        // SimplePullRequest omits mergeable; fetch from REST so the conflict gate fires correctly.
        let reviewPRMergeable: boolean | null | undefined;
        let reviewPRNodeId: string | undefined;
        if (repoConfig.governance.pr.automerge) {
          const prState = await prs.get({ owner, repo, prNumber: number });
          reviewPRMergeable = prState.mergeable;
          reviewPRNodeId = prState.nodeId;
        }
        await evaluateAutomerge({
          prs,
          ref: { owner, repo, prNumber: number },
          config: repoConfig.governance.pr.automerge,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          nodeId: reviewPRNodeId,
          draft: context.payload.pull_request.draft,
          mergeable: reviewPRMergeable,
          log: context.log,
          graphql: context.octokit,
        });
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to process PR review");
      throw error;
    }
  });

  /** Handle PR review dismissed - recalculate leaderboard and re-evaluate merge-readiness */
  probotApp.on("pull_request_review.dismissed", async (context) => {
    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    context.log.info(`Processing dismissed review for PR #${number} in ${fullName}`);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });

      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping dismissed review automation`);
        return;
      }

      await recalculateLeaderboardForPR(context.octokit, context.log, owner, repo, number);

      // Dismissed approval may drop below threshold
      if (repoConfig.governance.pr) {
        await evaluateMergeReadiness({
          prs,
          ref: { owner, repo, prNumber: number },
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          log: context.log,
        });

        // SimplePullRequest omits mergeable; fetch from REST so the conflict gate fires correctly.
        let dismissedPRMergeable: boolean | null | undefined;
        let dismissedPRNodeId: string | undefined;
        if (repoConfig.governance.pr.automerge) {
          const prState = await prs.get({ owner, repo, prNumber: number });
          dismissedPRMergeable = prState.mergeable;
          dismissedPRNodeId = prState.nodeId;
        }
        await evaluateAutomerge({
          prs,
          ref: { owner, repo, prNumber: number },
          config: repoConfig.governance.pr.automerge,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          nodeId: dismissedPRNodeId,
          draft: context.payload.pull_request.draft,
          mergeable: dismissedPRMergeable,
          log: context.log,
          graphql: context.octokit,
        });
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to update leaderboard after review dismissal");
      throw error;
    }
  });

  /**
   * Handle label changes — re-evaluate merge-readiness when implementation label is toggled.
   * Adding `implementation` may qualify the PR; removing it should strip `merge-ready`.
   */
  probotApp.on(["pull_request.labeled", "pull_request.unlabeled"], async (context) => {
    if (!isLabelMatch(context.payload.label?.name, LABELS.IMPLEMENTATION)) return;

    const { number } = context.payload.pull_request;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping label change automation`);
        return;
      }

      if (repoConfig.governance.pr) {
        const currentLabels = context.payload.pull_request.labels?.map(
          (l: { name: string }) => l.name
        );

        await evaluateMergeReadiness({
          prs,
          ref: { owner, repo, prNumber: number },
          config: repoConfig.governance.pr.mergeReady,
          trustedReviewers: repoConfig.governance.pr.trustedReviewers,
          currentLabels,
          draft: context.payload.pull_request.draft,
          log: context.log,
        });
      }
    } catch (error) {
      context.log.error({ err: error, pr: number, repo: fullName }, "Failed to evaluate merge-readiness after label change");
      throw error;
    }
  });

  /**
   * Handle check suite completion — re-evaluate merge-readiness for associated PRs.
   * The payload includes pull_requests array with PR numbers affected by this check suite.
   */
  probotApp.on("check_suite.completed", async (context) => {
    const { pull_requests } = context.payload.check_suite;
    if (!pull_requests || pull_requests.length === 0) return;

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const headSha = context.payload.check_suite.head_sha;

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping check_suite automation`);
        return;
      }

      if (!repoConfig.governance.pr) return;

      const errors: Error[] = [];
      for (const pr of pull_requests) {
        try {
          const prRef = { owner, repo, prNumber: pr.number };
          context.log.info(`Evaluating merge-readiness for PR #${pr.number} after check_suite in ${fullName}`);
          await evaluateMergeReadiness({
            prs,
            ref: prRef,
            config: repoConfig.governance.pr.mergeReady,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            headSha,
            log: context.log,
          });
          // CheckSuitePullRequest omits draft and mergeable; fetch from REST so the
          // automerge gates can fire correctly on CI completion events.
          let prDraft: boolean | undefined;
          let prMergeable: boolean | null | undefined;
          let prNodeId: string | undefined;
          if (repoConfig.governance.pr.automerge) {
            const prState = await prs.get(prRef);
            prDraft = prState.draft;
            prMergeable = prState.mergeable;
            prNodeId = prState.nodeId;
          }
          await evaluateAutomerge({
            prs,
            ref: prRef,
            config: repoConfig.governance.pr.automerge,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            nodeId: prNodeId,
            headSha,
            draft: prDraft,
            mergeable: prMergeable,
            log: context.log,
            graphql: context.octokit,
          });
        } catch (error) {
          context.log.error({ err: error, pr: pr.number, repo: fullName }, "Failed to evaluate merge-readiness after check_suite");
          errors.push(error as Error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} PR(s) failed merge-readiness evaluation after check_suite`);
      }
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        context.log.error({ err: error, repo: fullName }, "Failed to evaluate merge-readiness after check_suite");
      }
      throw error;
    }
  });

  /**
   * Handle individual check run completion — re-evaluate merge-readiness and retry queued squash.
   * Catches granular CI updates that check_suite.completed may not cover
   * (e.g., individual required checks completing at different times).
   */
  probotApp.on("check_run.completed", async (context) => {
    const { pull_requests } = context.payload.check_run;
    if (!pull_requests || pull_requests.length === 0) return;

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    const headSha = context.payload.check_run.head_sha;

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);
      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping check_run automation`);
        return;
      }

      if (!repoConfig.governance.pr) return;

      const errors: Error[] = [];
      for (const pr of pull_requests) {
        try {
          const prRef = { owner, repo, prNumber: pr.number };
          context.log.info(`Evaluating merge-readiness for PR #${pr.number} after check_run in ${fullName}`);
          const currentLabels = await prs.getLabels({ owner, repo, prNumber: pr.number });
          await evaluateMergeReadiness({
            prs,
            ref: prRef,
            config: repoConfig.governance.pr.mergeReady,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            currentLabels,
            headSha,
            log: context.log,
          });
          // CheckRunPullRequest omits draft and mergeable; fetch from REST so the
          // automerge gates can fire correctly on CI completion events.
          let prDraft: boolean | undefined;
          let prMergeable: boolean | null | undefined;
          let checkRunPRNodeId: string | undefined;
          if (repoConfig.governance.pr.automerge) {
            const prState = await prs.get(prRef);
            prDraft = prState.draft;
            prMergeable = prState.mergeable;
            checkRunPRNodeId = prState.nodeId;
          }
          await evaluateAutomerge({
            prs,
            ref: prRef,
            config: repoConfig.governance.pr.automerge,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            nodeId: checkRunPRNodeId,
            currentLabels,
            headSha,
            draft: prDraft,
            mergeable: prMergeable,
            log: context.log,
            graphql: context.octokit,
          });

          if (currentLabels.some((label) => isLabelMatch(label, LABELS.SQUASH_QUEUED))) {
            context.log.info(`Retrying queued squash for PR #${pr.number} after check_run in ${fullName}`);
            await retryQueuedSquash({
              octokit: context.octokit as Parameters<typeof retryQueuedSquash>[0]["octokit"],
              owner,
              repo,
              issueNumber: pr.number,
              installationId: context.payload.installation?.id,
              commentId: 0,
              senderLogin: "hivemoot",
              verb: "squash",
              freeText: undefined,
              issueLabels: currentLabels.map((label) => ({ name: label })),
              isPullRequest: true,
              appId,
              log: context.log,
            }, headSha);
          }
        } catch (error) {
          context.log.error({ err: error, pr: pr.number, repo: fullName }, "Failed to evaluate merge-readiness after check_run");
          errors.push(error as Error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} PR(s) failed merge-readiness evaluation after check_run`);
      }
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        context.log.error({ err: error, repo: fullName }, "Failed to evaluate merge-readiness after check_run");
      }
      throw error;
    }
  });

  /**
   * Handle legacy commit status events — re-evaluate merge-readiness.
   * The status event carries a SHA but no direct PR reference.
   * We use the repository's search to find PRs with this HEAD SHA.
   */
  probotApp.on("status", async (context) => {
    const sha = context.payload.sha;
    const { owner, repo, fullName } = getRepoContext(context.payload.repository);

    try {
      const appId = getAppId();
      const prs = createPROperations(context.octokit, { appId });
      const repoConfig = await loadRepositoryConfig(context.octokit, owner, repo);

      if (!repoConfig) {
        context.log.debug(`No config in ${fullName}; skipping status automation`);
        return;
      }
      if (!repoConfig.governance.pr) return;

      // Find open PRs with this commit SHA via search
      const { data } = await context.octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 100,
      });

      // Filter to PRs whose HEAD matches the status event SHA while preserving draft state.
      const matchingPRs = data.filter(
        (pr: { head: { sha: string }; draft?: boolean; number: number }) => pr.head.sha === sha
      );

      const errors: Error[] = [];
      for (const pr of matchingPRs) {
        try {
          context.log.info(`Evaluating merge-readiness for PR #${pr.number} after status event in ${fullName}`);
          const currentLabels = await prs.getLabels({ owner, repo, prNumber: pr.number });
          await evaluateMergeReadiness({
            prs,
            ref: { owner, repo, prNumber: pr.number },
            config: repoConfig.governance.pr.mergeReady,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            currentLabels,
            headSha: sha,
            log: context.log,
          });
          // pulls.list omits mergeable; fetch from REST so the conflict gate fires correctly.
          let statusPRMergeable: boolean | null | undefined;
          let statusPRNodeId: string | undefined;
          if (repoConfig.governance.pr.automerge) {
            const prState = await prs.get({ owner, repo, prNumber: pr.number });
            statusPRMergeable = prState.mergeable;
            statusPRNodeId = prState.nodeId;
          }
          await evaluateAutomerge({
            prs,
            ref: { owner, repo, prNumber: pr.number },
            config: repoConfig.governance.pr.automerge,
            trustedReviewers: repoConfig.governance.pr.trustedReviewers,
            nodeId: statusPRNodeId,
            currentLabels,
            headSha: sha,
            draft: pr.draft,
            mergeable: statusPRMergeable,
            log: context.log,
            graphql: context.octokit,
          });

          if (currentLabels.some((label) => isLabelMatch(label, LABELS.SQUASH_QUEUED))) {
            context.log.info(`Retrying queued squash for PR #${pr.number} after status event in ${fullName}`);
            await retryQueuedSquash({
              octokit: context.octokit as Parameters<typeof retryQueuedSquash>[0]["octokit"],
              owner,
              repo,
              issueNumber: pr.number,
              installationId: context.payload.installation?.id,
              commentId: 0,
              senderLogin: "hivemoot",
              verb: "squash",
              freeText: undefined,
              issueLabels: currentLabels.map((label) => ({ name: label })),
              isPullRequest: true,
              appId,
              log: context.log,
            }, sha);
          }
        } catch (error) {
          context.log.error({ err: error, pr: pr.number, repo: fullName }, "Failed to evaluate merge-readiness after status event");
          errors.push(error as Error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `${errors.length} PR(s) failed merge-readiness evaluation after status event`);
      }
    } catch (error) {
      if (!(error instanceof AggregateError)) {
        context.log.error({ err: error, repo: fullName }, "Failed to evaluate merge-readiness after status event");
      }
      throw error;
    }
  });

  /**
   * Handle manual phase:voting label additions.
   *
   * When a human adds the `phase:voting` label manually (bypassing the automatic
   * discussion→voting transition), the voting comment is missing. This handler
   * detects that scenario and posts the voting comment idempotently.
   *
   * Skips Bot senders — the automatic transition in `transitionToVoting()` already
   * handles the comment when the app adds the label.
   */
  probotApp.on("issues.labeled", async (context) => {
    const { label, issue, sender } = context.payload;
    if (!isLabelMatch(label?.name, LABELS.VOTING)) return;
    if (sender.type === "Bot") return;

    const { owner, repo, fullName } = getRepoContext(context.payload.repository);
    context.log.info(
      `Manual voting label on issue #${issue.number} in ${fullName} (by ${sender.login})`,
    );

    try {
      const appId = getAppId();
      const issues = createIssueOperations(context.octokit, { appId });
      const governance = createGovernanceService(issues);
      const installationId = context.payload.installation?.id;
      const result = await governance.postVotingComment({
        owner, repo, issueNumber: issue.number, installationId,
      });
      context.log.info(`Voting comment for issue #${issue.number}: ${result}`);
    } catch (error) {
      context.log.error(
        { err: error, issue: issue.number, repo: fullName },
        "Failed to post voting comment for manually labeled issue",
      );
      throw error;
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Suppress Probot's auto-detection of REDIS_URL for bottleneck rate-limit
// clustering. When REDIS_URL is set in the Vercel environment, Probot opens a
// raw ioredis TCP connection that goes stale between serverless invocations,
// causing ECONNRESET/EPIPE errors that silently drop webhook commands.
// The bot does not use distributed rate limiting; force the local datastore.
const probot = createProbot({ overrides: { redisConfig: "" } });
const middleware = createNodeMiddleware(app, {
  probot,
  webhooksPath: "/api/github/webhooks",
});

/**
 * Vercel serverless function handler.
 *
 * GET requests return health status with configuration validation.
 * POST requests are forwarded to Probot middleware for webhook processing.
 *
 * Security: Both GET and POST validate WEBHOOK_SECRET is configured.
 * Probot then verifies webhook signatures - unsigned payloads are rejected.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  // Validate environment for all requests (fail-closed guard)
  const validation = validateEnv(true);

  if (req.method === "GET") {
    res.statusCode = validation.valid ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: validation.valid ? "ok" : "misconfigured",
        bot: "Queen",
        checks: {
          githubApp: { ready: validation.valid },
          llm: getLLMReadiness(),
        },
      })
    );
    return;
  }

  // Reject webhooks if environment is misconfigured
  if (!validation.valid) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Webhook processing unavailable" }));
    return;
  }

  middleware(req, res);
}
