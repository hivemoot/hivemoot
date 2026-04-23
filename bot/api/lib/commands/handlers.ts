/**
 * Command Handlers
 *
 * Implements the command execution logic for bot commands.
 * Each handler receives a validated, authorized command context
 * and performs the corresponding governance action.
 */

import * as yaml from "js-yaml";
import { LABELS, REQUIRED_REPOSITORY_LABELS, SIGNATURE, isLabelMatch } from "../../config.js";
import { SIGNATURES, buildAlignmentComment } from "../bot-comments.js";
import {
  createIssueOperations,
  createGovernanceService,
  createPROperations,
  createRepositoryLabelService,
  loadRepositoryConfig,
  getDefaultConfig,
} from "../index.js";
import { getRepoDiscussionInfo } from "../discussions.js";
import { getLLMReadiness } from "../llm/provider.js";
import { BlueprintGenerator, createMinimalPlan } from "../llm/blueprint.js";
import type { ImplementationPlan, IssueContext } from "../llm/types.js";
import { evaluatePreflightChecks } from "../merge-readiness.js";
import type { PreflightCheckItem, PreflightResult } from "../merge-readiness.js";
import { CommitMessageGenerator, formatCommitMessage } from "../llm/commit-message.js";
import type { PRContext } from "../llm/types.js";
import type { IssueRef, PRRef } from "../types.js";
import type { EffectiveConfig, AutoGatherConfig } from "../repo-config.js";
import { getErrorStatus } from "../github-client.js";
import { isTransientError } from "../transient-error.js";

/**
 * Minimal interface for the octokit client needed by command handlers.
 * Uses the Probot context's octokit which has full REST API access.
 */
export interface CommandOctokit {
  rest: {
    repos: {
      getCollaboratorPermissionLevel: (params: {
        owner: string;
        repo: string;
        username: string;
      }) => Promise<{ data: { permission: string } }>;
    };
    reactions: {
      createForIssueComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
      }) => Promise<unknown>;
      listForIssueComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";
        per_page?: number;
        page?: number;
      }) => Promise<{ data: Array<{ user: { login: string } | null }> }>;
    };
    issues: {
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<unknown>;
      updateComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<unknown>;
      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{
        data: Array<{
          user: { login: string } | null;
          performed_via_github_app?: { id: number; name: string } | null;
        }>;
      }>;
    };
  };
}

/**
 * Context passed to command execution.
 */
export interface CommandContext {
  octokit: CommandOctokit;
  owner: string;
  repo: string;
  issueNumber: number;
  installationId?: number;
  commentId: number;
  senderLogin: string;
  verb: string;
  freeText: string | undefined;
  /** Labels currently on the issue */
  issueLabels: Array<{ name: string }>;
  /** Whether this comment is on a PR (vs an issue) */
  isPullRequest: boolean;
  /** App ID for filtering bot comments */
  appId: number;
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Result of a command execution attempt.
 */
export type CommandResult =
  | { status: "executed"; message: string }
  | { status: "ignored" }      // unauthorized or unrecognized
  | { status: "rejected"; reason: string };  // valid command but invalid state

/**
 * Permission levels that are allowed to execute commands.
 * Per issue #81: "only repo maintainers should use these commands"
 */
const AUTHORIZED_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const BRANCH_REFRESH_MAX_POLLS = 10;
const BRANCH_REFRESH_POLL_INTERVAL_MS = 3000;
const MERGEABLE_STATE_RESOLUTION_MAX_POLLS = 10;
const MERGEABLE_STATE_RESOLUTION_INTERVAL_MS = 1500;
const RESOLVED_MERGEABLE_STATES = new Set([
  "behind",
  "clean",
  "dirty",
  "blocked",
  "unstable",
  "has_hooks",
]);
type CommandFailureClassification = "permission" | "validation" | "transient" | "unexpected";

interface AuthorizationResult {
  authorized: boolean;
  permission: string | null;
  /** Set when the auth check itself failed due to a transient error. */
  transientError?: unknown;
}

interface CommandLogContext {
  command: string;
  owner: string;
  repo: string;
  issueNumber: number;
  commentId: number;
  senderLogin: string;
  senderPermission: string;
  isPullRequest: boolean;
}

/**
 * Check if the sender has sufficient repo permissions to run commands.
 * Returns authorization status and the sender's resolved permission (when known).
 *
 * Transient errors (ECONNRESET, 429, 5xx) are surfaced via `transientError`
 * so executeCommand() can post user-visible feedback instead of silently
 * denying the command.
 */
async function isAuthorized(ctx: CommandContext): Promise<AuthorizationResult> {
  try {
    const { data } = await ctx.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: ctx.owner,
      repo: ctx.repo,
      username: ctx.senderLogin,
    });
    return {
      authorized: AUTHORIZED_PERMISSIONS.has(data.permission),
      permission: data.permission,
    };
  } catch (error) {
    // Surface transient errors so executeCommand() can post feedback
    // instead of silently dropping the command.
    if (isTransientError(error)) {
      ctx.log.error(
        { err: error, user: ctx.senderLogin, issue: ctx.issueNumber },
        `Permission check hit transient error for ${ctx.senderLogin} — surfacing to user`,
      );
      return { authorized: false, permission: null, transientError: error };
    }

    // Non-transient failures (e.g., 404 = user is not a collaborator) → deny.
    ctx.log.error(
      { err: error, user: ctx.senderLogin, issue: ctx.issueNumber },
      `Permission check failed for ${ctx.senderLogin} — denying command`,
    );
    return { authorized: false, permission: null };
  }
}


function classifyCommandFailure(error: unknown): CommandFailureClassification {
  // Delegate to isTransientError() so network-level codes (ECONNRESET, etc.)
  // are classified as "transient" — not just HTTP 429/5xx.
  if (isTransientError(error)) {
    return "transient";
  }
  const status = getErrorStatus(error);
  if (status === 401 || status === 403) {
    return "permission";
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return "validation";
  }
  return "unexpected";
}

function buildFailureCode(verb: string, classification: CommandFailureClassification): string {
  return `CMD_${verb.toUpperCase()}_${classification.toUpperCase()}`;
}

function buildCommandCorrelationId(ctx: CommandContext): string {
  return `cmd-${ctx.commentId.toString(36)}`;
}

function buildCommandFailureReply(
  ctx: CommandContext,
  failureCode: string,
  correlationId: string,
  classification: CommandFailureClassification,
): string {
  let guidance = "Retry the command once. If it fails again, ask a maintainer to inspect logs.";
  if (classification === "permission") {
    guidance = "Check repository/app permissions for this command, then retry.";
  } else if (classification === "validation") {
    guidance = "Verify repository configuration and pull request state, then retry.";
  } else if (classification === "transient") {
    guidance = "This looks transient (GitHub/API). Retry the command shortly.";
  }

  return [
    "## 🐝 Command failed",
    "",
    `I couldn't complete \`/${ctx.verb}\` due to an internal command error.`,
    "",
    `- Failure code: \`${failureCode}\``,
    `- Correlation id: \`${correlationId}\``,
    "",
    guidance,
  ].join("\n");
}

function buildCommandLogContext(ctx: CommandContext, permission: string | null): CommandLogContext {
  return {
    command: ctx.verb,
    owner: ctx.owner,
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    commentId: ctx.commentId,
    senderLogin: ctx.senderLogin,
    senderPermission: permission ?? "unknown",
    isPullRequest: ctx.isPullRequest,
  };
}

/**
 * Add a reaction to the command comment for acknowledgment.
 */
async function react(
  ctx: CommandContext,
  content: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes",
): Promise<void> {
  try {
    await ctx.octokit.rest.reactions.createForIssueComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: ctx.commentId,
      content,
    });
  } catch (error) {
    // Reaction failure is non-critical — don't block command execution
    ctx.log.error(
      { err: error, commentId: ctx.commentId, content },
      `Failed to add ${content} reaction — continuing`,
    );
  }
}

/**
 * Post a reply comment on the issue. SIGNATURE is always appended —
 * callers should not include it in the body.
 * Failures are logged but do not propagate — the governance action may
 * have already completed, so crashing the handler is worse than a missing comment.
 */
async function reply(ctx: CommandContext, body: string): Promise<void> {
  try {
    await ctx.octokit.rest.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.issueNumber,
      body: `${body}${SIGNATURE}`,
    });
  } catch (error) {
    ctx.log.error(
      { err: error, issue: ctx.issueNumber },
      `Failed to post reply comment on #${ctx.issueNumber} — continuing`,
    );
  }
}

/**
 * Check if the bot has already reacted to this comment with a processing
 * marker (👀 for known commands, 😕 for unknown commands).
 * Used as an idempotency guard against webhook retries.
 *
 * Security: Only trust reactions from THIS app's bot identity, not any [bot].
 * This prevents unrelated bots from suppressing command execution.
 */
async function alreadyProcessed(ctx: CommandContext): Promise<boolean> {
  try {
    // Resolve this app's bot login from comments authored via this app.
    // GitHub App bot usernames follow the pattern "<app-slug>[bot]".
    const botLogin = await resolveAppBotLogin(ctx);
    if (!botLogin) {
      // Can't resolve bot identity — proceed to avoid silently dropping commands
      ctx.log.info("Could not resolve app bot login for idempotency check — proceeding");
      return false;
    }

    // Check both marker reactions with full pagination.
    // Eyes = known commands processed; confused = unknown commands processed.
    // Must paginate: the app's marker reaction may be on page 2+ in high-reaction threads.
    for (const content of ["eyes", "confused"] as const) {
      const found = await isMarkerReactionPresent(ctx, botLogin, content);
      if (found) {
        ctx.log.info({ botLogin, content }, "Found our own marker reaction — already processed");
        return true;
      }
    }

    return false;
  } catch (error) {
    // If we can't check reactions, proceed with execution to avoid
    // silently dropping commands due to transient API failures.
    ctx.log.error(
      { err: error, commentId: ctx.commentId },
      "Idempotency check failed — proceeding to avoid silent command drop",
    );
    return false;
  }
}

/**
 * Paginate through all reactions of a given type and return true if botLogin left one.
 * Must paginate: in high-reaction threads the app's marker reaction can be on page 2+.
 */
async function isMarkerReactionPresent(
  ctx: CommandContext,
  botLogin: string,
  content: "eyes" | "confused",
): Promise<boolean> {
  const perPage = 100;
  let page = 1;

  while (true) {
    const { data: reactions } = await ctx.octokit.rest.reactions.listForIssueComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: ctx.commentId,
      content,
      per_page: perPage,
      page,
    });

    if (reactions.some((r) => r.user?.login === botLogin)) {
      return true;
    }

    if (reactions.length < perPage) {
      return false;
    }

    page += 1;
  }
}

/**
 * Resolve this GitHub App's bot login by finding a comment authored via this app.
 * Returns the bot username (e.g., "hivemoot[bot]") or undefined if not found.
 */
async function resolveAppBotLogin(ctx: CommandContext): Promise<string | undefined> {
  try {
    const perPage = 100;
    let page = 1;

    while (true) {
      const { data: comments } = await ctx.octokit.rest.issues.listComments({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.issueNumber,
        per_page: perPage,
        page,
      });

      // Find a comment authored by this GitHub App (via performed_via_github_app)
      // The API response includes performed_via_github_app.id when the app authored the comment
      for (const comment of comments) {
        const app = comment.performed_via_github_app;
        if (app && typeof app === "object" && "id" in app && app.id === ctx.appId) {
          // The author field contains the bot user
          if (comment.user) {
            return comment.user.login;
          }
        }
      }

      if (comments.length < perPage) {
        return undefined;
      }

      page += 1;
    }
  } catch (error) {
    ctx.log.error(
      { err: error, issue: ctx.issueNumber },
      "Failed to resolve app bot login for idempotency check",
    );
    return undefined;
  }
}

/**
 * Check if the issue currently has a specific label.
 */
function hasLabel(ctx: CommandContext, label: string): boolean {
  return ctx.issueLabels.some((l) => isLabelMatch(l.name, label));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle /vote command: transition issue from discussion → voting.
 */
async function handleVote(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/vote` command can only be used on issues, not pull requests." };
  }

  // Already in voting or later phase
  if (hasLabel(ctx, LABELS.VOTING)) {
    return { status: "rejected", reason: "This issue is already in the voting phase." };
  }
  if (hasLabel(ctx, LABELS.EXTENDED_VOTING)) {
    return { status: "rejected", reason: "This issue is already in extended voting." };
  }
  if (hasLabel(ctx, LABELS.READY_TO_IMPLEMENT)) {
    return { status: "rejected", reason: "This issue is already ready to implement." };
  }
  if (hasLabel(ctx, LABELS.REJECTED)) {
    return { status: "rejected", reason: "This issue has been rejected." };
  }

  // Must be in discussion phase
  if (!hasLabel(ctx, LABELS.DISCUSSION)) {
    return { status: "rejected", reason: "This issue is not in the discussion phase. The `/vote` command requires `hivemoot:discussion`." };
  }

  const ref: IssueRef = {
    owner: ctx.owner,
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    installationId: ctx.installationId,
  };
  const issues = createIssueOperations(ctx.octokit, { appId: ctx.appId });
  const governance = createGovernanceService(issues);

  await governance.transitionToVoting(ref);

  return { status: "executed", message: "Moved to voting phase." };
}

/**
 * Handle /implement command: transition issue to ready-to-implement.
 *
 * This is a fast-track command that moves an issue directly to
 * ready-to-implement, bypassing or concluding voting early.
 * Valid from: discussion, voting, extended-voting, needs-human, or unlabeled issues.
 */
async function handleImplement(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/implement` command can only be used on issues, not pull requests." };
  }

  if (hasLabel(ctx, LABELS.READY_TO_IMPLEMENT)) {
    return { status: "rejected", reason: "This issue is already ready to implement." };
  }
  if (hasLabel(ctx, LABELS.REJECTED)) {
    return { status: "rejected", reason: "This issue has been rejected." };
  }
  if (hasLabel(ctx, LABELS.INCONCLUSIVE)) {
    return { status: "rejected", reason: "This issue reached an inconclusive vote and is closed." };
  }
  if (hasLabel(ctx, LABELS.IMPLEMENTED)) {
    return { status: "rejected", reason: "This issue was already implemented." };
  }

  const ref: IssueRef = {
    owner: ctx.owner,
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    installationId: ctx.installationId,
  };
  const issues = createIssueOperations(ctx.octokit, { appId: ctx.appId });

  const phaseLabelsInPriority = [
    LABELS.DISCUSSION,
    LABELS.VOTING,
    LABELS.EXTENDED_VOTING,
    LABELS.NEEDS_HUMAN,
  ] as const;
  const labelsToClear = phaseLabelsInPriority.filter(label => hasLabel(ctx, label));
  const [removeLabel, ...extraPhaseLabelsToRemove] = labelsToClear;

  const message = `# 🐝 Fast-tracked to Implementation ⚡\n\nMoved to ready-to-implement by @${ctx.senderLogin} via \`/implement\` command.\n\nNext steps:\n- Open a PR for review if you plan to implement.\n- Link this issue in the PR description (e.g., \`Fixes #${ctx.issueNumber}\`).${SIGNATURE}`;

  await issues.transition(ref, {
    removeLabel,
    addLabel: LABELS.READY_TO_IMPLEMENT,
    comment: message,
    unlock: true,
  });

  for (const label of extraPhaseLabelsToRemove) {
    try {
      await issues.removeLabel(ref, label);
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 404) {
        continue;
      }
      ctx.log.warn(
        { err: error, issueNumber: ctx.issueNumber, label },
        "Failed to remove extra phase label after /implement transition",
      );
    }
  }

  return { status: "executed", message: "Fast-tracked to ready-to-implement." };
}

/**
 * Format a human-readable timestamp for blueprint footers.
 * e.g., "Feb 16, 2026, 14:26 UTC"
 */
function formatBlueprintTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function pushBlueprintSection(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(title);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

function buildBlueprintContent(
  plan: ImplementationPlan,
  senderLogin: string,
  options?: { triggerLabel?: string },
): string {
  const lines: string[] = [];
  const goal = plan.goal?.trim() || "Discussion is gathering signal. Run `/gather` again after more input.";

  lines.push(SIGNATURES.ALIGNMENT);
  lines.push("");
  lines.push(`> ${goal}`);
  lines.push("");

  // Plan (free-form markdown — only if non-empty)
  if (plan.plan.trim()) {
    lines.push("## Plan");
    lines.push(plan.plan.trim());
    lines.push("");
  }

  pushBlueprintSection(lines, "## Decisions", plan.decisions);
  pushBlueprintSection(lines, "## Out of scope", plan.outOfScope);
  pushBlueprintSection(lines, "## Open", plan.openQuestions);

  lines.push("---");
  lines.push("");
  lines.push(
    "This plan was gathered from the issue discussion. All participants, please review and comment if you disagree or want to propose changes.",
  );
  lines.push("");

  const metaParts: string[] = [];
  metaParts.push(`${plan.metadata.commentCount} comments`);
  if (plan.metadata.participantCount > 0) {
    metaParts.push(`${plan.metadata.participantCount} participants`);
  }
  metaParts.push(formatBlueprintTimestamp());
  metaParts.push(options?.triggerLabel ?? `@${senderLogin} via \`/gather\``);
  lines.push(metaParts.join(" · "));

  return lines.join("\n");
}

function buildFallbackBlueprintContent(
  context: IssueContext,
  senderLogin: string,
  options?: { triggerLabel?: string },
): string {
  return buildBlueprintContent(createMinimalPlan(context), senderLogin, options);
}

/**
 * Handle /gather command: upsert the canonical blueprint comment during discussion.
 */
async function handleGather(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/gather` command can only be used on issues, not pull requests." };
  }

  if (!hasLabel(ctx, LABELS.DISCUSSION)) {
    return {
      status: "rejected",
      reason: "This issue is not in the discussion phase. The `/gather` command requires `hivemoot:discussion`.",
    };
  }

  const ref: IssueRef = {
    owner: ctx.owner,
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    installationId: ctx.installationId,
  };
  const issues = createIssueOperations(ctx.octokit, { appId: ctx.appId });
  const existingAlignmentCommentId = await issues.findAlignmentCommentId(ref);

  let blueprintContent: string;
  try {
    const context = await issues.getIssueContext(ref);
    const generator = new BlueprintGenerator();
    const result = await generator.generate(
      context,
      undefined,
      ctx.installationId !== undefined
        ? { installationId: ctx.installationId }
        : undefined
    );

    if (result.success) {
      blueprintContent = buildBlueprintContent(result.plan, ctx.senderLogin);
    } else {
      ctx.log.warn(`Using fallback blueprint for #${ctx.issueNumber}: ${result.reason}`);
      blueprintContent = buildFallbackBlueprintContent(context, ctx.senderLogin);
    }
  } catch (error) {
    if (existingAlignmentCommentId) {
      ctx.log.error({ err: error, issue: ctx.issueNumber }, "Blueprint refresh failed in handleGather");
      await reply(
        ctx,
        `I couldn't refresh the blueprint just now. Please retry \`/gather\` shortly, or contact your administrator if the problem persists.`,
      );
      return { status: "executed", message: "Blueprint refresh failed; previous comment preserved." };
    }
    throw error;
  }

  const body = buildAlignmentComment(blueprintContent, ctx.issueNumber);

  if (existingAlignmentCommentId) {
    await ctx.octokit.rest.issues.updateComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: existingAlignmentCommentId,
      body,
    });
    return { status: "executed", message: "Updated the blueprint comment." };
  }

  await issues.comment(ref, body);
  return { status: "executed", message: "Created the blueprint comment." };
}

/**
 * Handle /preflight command: generate a merge readiness report for a PR.
 *
 * Runs the same hard checks used by the merge-ready label automation,
 * plus advisory checks, and optionally generates an LLM commit message.
 * Posts the full report as a PR comment.
 */
async function handlePreflight(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.isPullRequest) {
    return { status: "rejected", reason: "The `/preflight` command can only be used on pull requests, not issues." };
  }

  // The octokit passed to commands is the full Probot octokit (cast to the
  // minimal CommandOctokit interface). createPROperations and loadRepositoryConfig
  // validate the shape at runtime. These casts are safe because the actual
  // Probot client has all required methods — only the declared type is narrow.
  const octokit = ctx.octokit as any; // Full Probot client at runtime
  const prs = createPROperations(octokit, { appId: ctx.appId });
  const repoConfig = (await loadRepositoryConfig(octokit, ctx.owner, ctx.repo)) ?? getDefaultConfig();

  const ref: PRRef = {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.issueNumber,
    installationId: ctx.installationId,
  };
  const currentLabels = ctx.issueLabels.map(l => l.name);

  // Run shared preflight checks (same signals as merge-ready label)
  const preflight = await evaluatePreflightChecks({
    prs,
    ref,
    config: repoConfig.governance.pr?.mergeReady ?? null,
    trustedReviewers: repoConfig.governance.pr?.trustedReviewers ?? [],
    currentLabels,
  });

  // Build checklist markdown
  const checklistLines = preflight.checks.map(formatCheckItem);

  const hardCount = preflight.checks.filter(c => c.severity === "hard").length;
  const hardPassed = preflight.checks.filter(c => c.severity === "hard" && c.passed).length;

  let body = `## 🐝 Preflight Check for #${ctx.issueNumber}\n\n`;
  body += `### Checklist\n\n`;
  body += checklistLines.join("\n") + "\n\n";

  // Generate commit message if all hard checks pass and LLM is configured
  if (preflight.allHardChecksPassed) {
    const commitMessageWarning =
      "[warning] I couldn't generate a recommended commit message this time.";

    try {
      const prContext = await gatherPRContext(ctx, ref);
      const noop = () => {};
      const generator = new CommitMessageGenerator({
        logger: {
          info: (...a: unknown[]) => ctx.log.info(...a),
          error: (...a: unknown[]) => ctx.log.error(...a),
          warn: noop,
          debug: noop,
          group: noop,
          groupEnd: noop,
        },
      });
      const result = await generator.generate(
        prContext,
        undefined,
        ctx.installationId !== undefined
          ? { installationId: ctx.installationId }
          : undefined
      );

      if (result.success) {
        const formatted = formatCommitMessage(result.message, ctx.issueNumber);
        body += `### Proposed Commit Message\n\n`;
        body += "```\n" + formatted + "\n```\n\n";
      } else {
        switch (result.kind) {
          case "generation_failed":
            body += `### Commit Message\n\n`;
            body += `${commitMessageWarning}\n\n`;
            break;
          case "not_configured":
            ctx.log.info("Commit message generation skipped: LLM not configured");
            break;
          default: {
            const _exhaustive: never = result.kind;
            ctx.log.error(`Unhandled commit message failure kind: ${_exhaustive}`);
            body += `### Commit Message\n\n`;
            body += `${commitMessageWarning}\n\n`;
            break;
          }
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.log.error({ err: error }, `Commit message generation failed: ${reason}`);
      // Keep detailed error in logs; show generic warning in PR comments.
      body += `### Commit Message\n\n`;
      body += `${commitMessageWarning}\n\n`;
    }
  } else {
    body += `### Commit Message\n\n`;
    body += `Commit message not generated — resolve failing hard checks first.\n\n`;
  }

  // Summary line
  if (preflight.allHardChecksPassed) {
    body += `**${hardPassed}/${hardCount} hard checks passed.** This PR is ready for merge.`;
  } else {
    body += `**${hardPassed}/${hardCount} hard checks passed.** Review the failing checks above before merging.`;
  }

  await reply(ctx, body);

  return { status: "executed", message: "Preflight report posted." };
}

/**
 * Handle /squash command: run preflight and squash-merge when all hard checks pass.
 *
 * Behavior:
 * - PR-only command
 * - Fail-closed: blocks merge when checks fail or commit message generation fails
 * - Requires repository squash-merge capability to be enabled
 * - Re-runs preflight immediately before merge to reduce stale CI race windows
 */
type SquashAttemptMode = "command" | "retry";

type SquashAttemptResult =
  | { outcome: "queued"; body: string }
  | { outcome: "merged"; body: string }
  | { outcome: "blocked"; body: string };

function buildSquashBodyHeader(ctx: CommandContext, checklistLines: string[]): string {
  return `## 🐝 Squash Preflight for #${ctx.issueNumber}\n\n### Checklist\n\n${checklistLines.join("\n")}\n\n`;
}

function getHardCheckTotals(preflight: PreflightResult): { hardCount: number; hardPassed: number } {
  return {
    hardCount: preflight.checks.filter((check) => check.severity === "hard").length,
    hardPassed: preflight.checks.filter((check) => check.severity === "hard" && check.passed).length,
  };
}

function findQueuedCiCheck(preflight: PreflightResult): PreflightCheckItem | null {
  const failedHardChecks = preflight.checks.filter((check) => check.severity === "hard" && !check.passed);
  if (failedHardChecks.length !== 1) {
    return null;
  }

  const [failedCheck] = failedHardChecks;
  if (failedCheck.name !== "CI checks passing") {
    return null;
  }

  if (!failedCheck.pendingTargets?.length && !failedCheck.detail.startsWith("Still running:")) {
    return null;
  }

  return failedCheck;
}

function formatQueuedSquashMessage(pendingTargets: string[]): string {
  const waitingFor = pendingTargets.length > 0
    ? pendingTargets.join(", ")
    : "legacy status checks";
  return [
    "### Queue",
    "",
    `Squash queued. Waiting for: ${waitingFor}.`,
    "",
    "I will retry automatically when all checks complete. No need to rerun `/squash`.",
    "",
  ].join("\n");
}

function formatBlockedSummary(
  mode: SquashAttemptMode,
  summary: string,
  followup?: string,
): string {
  if (mode === "retry") {
    const lines = [
      `${summary} Queued squash was cancelled.`,
    ];
    if (followup) {
      lines.push("", followup);
    }
    return `${lines.join("\n")}\n`;
  }

  return `${summary} Squash merge was blocked.`;
}

async function attemptSquash(ctx: CommandContext, mode: SquashAttemptMode): Promise<SquashAttemptResult> {
  if (!ctx.isPullRequest) {
    return {
      outcome: "blocked",
      body: "The `/squash` command can only be used on pull requests, not issues.",
    };
  }

  const octokit = ctx.octokit as any; // Full Probot client at runtime
  const prs = createPROperations(octokit, { appId: ctx.appId });
  const repoConfig = (await loadRepositoryConfig(octokit, ctx.owner, ctx.repo)) ?? getDefaultConfig();
  const ref: PRRef = {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.issueNumber,
    installationId: ctx.installationId,
  };
  const currentLabels = ctx.issueLabels.map((l) => l.name);

  const pr = await prs.get(ref);
  if (pr.merged || pr.state !== "open") {
    return {
      outcome: "blocked",
      body: "This pull request is already closed or merged.",
    };
  }
  let mergeHeadSha = pr.headSha;

  const repoInfo = await octokit.rest.repos.get({ owner: ctx.owner, repo: ctx.repo });
  if (!repoInfo?.data?.allow_squash_merge) {
    return {
      outcome: "blocked",
      body: "Squash merge is disabled for this repository. Enable it in repository settings before using `/squash`.",
    };
  }

  const preflight = await evaluatePreflightChecks({
    prs,
    ref,
    config: repoConfig.governance.pr?.mergeReady ?? null,
    trustedReviewers: repoConfig.governance.pr?.trustedReviewers ?? [],
    currentLabels,
  });

  const checklistLines = preflight.checks.map(formatCheckItem);
  const { hardCount, hardPassed } = getHardCheckTotals(preflight);

  let body = buildSquashBodyHeader(ctx, checklistLines);

  const queuedCiCheck = findQueuedCiCheck(preflight);
  if (queuedCiCheck) {
    await prs.addLabels(ref, [LABELS.SQUASH_QUEUED]);
    body += formatQueuedSquashMessage(queuedCiCheck.pendingTargets ?? []);
    body += `**${hardPassed}/${hardCount} hard checks passed.** Squash will retry automatically after CI completes.`;
    return { outcome: "queued", body };
  }

  if (!preflight.allHardChecksPassed) {
    await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
    body += formatBlockedSummary(
      mode,
      `**${hardPassed}/${hardCount} hard checks passed.**`,
      "Run `/squash` again after resolving the failing checks."
    );
    return { outcome: "blocked", body };
  }

  let commitTitle = "";
  let commitBody = "";
  try {
    const prContext = await gatherPRContext(ctx, ref);
    const noop = () => {};
    const generator = new CommitMessageGenerator({
      logger: {
        info: (...a: unknown[]) => ctx.log.info(...a),
        error: (...a: unknown[]) => ctx.log.error(...a),
        warn: noop,
        debug: noop,
        group: noop,
        groupEnd: noop,
      },
    });
    const result = await generator.generate(
      prContext,
      undefined,
      ctx.installationId !== undefined
        ? { installationId: ctx.installationId }
        : undefined
    );

    if (!result.success) {
      await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
      body += "### Commit Message\n\n";
      body += "Commit message generation failed. Squash merge was blocked.\n\n";
      body += `**${hardPassed}/${hardCount} hard checks passed.** Retry \`/squash\` after the generator is healthy.`;
      return { outcome: "blocked", body };
    }

    commitTitle = result.message.subject.trim();
    const generatedBody = result.message.body.trim();
    commitBody = generatedBody
      ? `${generatedBody}\n\nPR: #${ctx.issueNumber}`
      : `PR: #${ctx.issueNumber}`;
    body += "### Proposed Commit Message\n\n";
    body += "```\n" + formatCommitMessage(result.message, ctx.issueNumber) + "\n```\n\n";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.error({ err: error }, `Commit message generation failed during /squash: ${reason}`);
    await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
    body += "### Commit Message\n\n";
    body += "Commit message generation failed. Squash merge was blocked.\n\n";
    body += `**${hardPassed}/${hardCount} hard checks passed.** Retry \`/squash\` after the generator is healthy.`;
    return { outcome: "blocked", body };
  }

  const refreshedHead = await refreshHeadIfBehindBase(ctx, mergeHeadSha);
  if (!refreshedHead.success) {
    await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
    body += `### Branch Refresh\n\n`;
    body += `${refreshedHead.reason}\n\n`;
    body += mode === "retry"
      ? "Queued squash was cancelled to avoid merging a stale head. Run `/squash` again once the branch is current."
      : "Squash merge was blocked to avoid merging a stale head.";
    return { outcome: "blocked", body };
  }
  if (refreshedHead.updated) {
    mergeHeadSha = refreshedHead.headSha;
    body += "### Branch Refresh\n\n";
    body += `Branch was behind base and refreshed to \`${mergeHeadSha}\`. Running final checks on the updated head.\n\n`;
  } else {
    mergeHeadSha = refreshedHead.headSha;
  }

  const freshPreflight = await evaluatePreflightChecks({
    prs,
    ref,
    config: repoConfig.governance.pr?.mergeReady ?? null,
    trustedReviewers: repoConfig.governance.pr?.trustedReviewers ?? [],
    currentLabels,
  });
  const queuedCiCheckAfterRefresh = findQueuedCiCheck(freshPreflight);
  if (queuedCiCheckAfterRefresh) {
    const { hardCount: freshHardCount, hardPassed: freshHardPassed } = getHardCheckTotals(freshPreflight);
    await prs.addLabels(ref, [LABELS.SQUASH_QUEUED]);
    body += formatQueuedSquashMessage(queuedCiCheckAfterRefresh.pendingTargets ?? []);
    body += `**${freshHardPassed}/${freshHardCount} hard checks passed on final verification.** Squash will retry automatically after CI completes.`;
    return { outcome: "queued", body };
  }

  if (!freshPreflight.allHardChecksPassed) {
    const { hardCount: freshHardCount, hardPassed: freshHardPassed } = getHardCheckTotals(freshPreflight);
    await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
    body += mode === "retry"
      ? `**${freshHardPassed}/${freshHardCount} hard checks passed on final verification.** Checks changed while processing. Queued squash was cancelled.\n\nRun \`/squash\` again after resolving the blocker.`
      : `**${freshHardPassed}/${freshHardCount} hard checks passed on final verification.** Checks changed while processing; squash merge was blocked.`;
    return { outcome: "blocked", body };
  }

  try {
    await octokit.rest.pulls.merge({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.issueNumber,
      sha: mergeHeadSha,
      merge_method: "squash",
      commit_title: commitTitle,
      commit_message: commitBody,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.error({ err: error }, `Squash merge failed for #${ctx.issueNumber}: ${reason}`);
    await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
    body += "### Merge\n\n";
    body += mode === "retry"
      ? "GitHub rejected the queued squash merge attempt. Queued squash was cancelled.\n\nRun `/squash` again after resolving merge blockers.\n\n"
      : "Squash merge failed due to a GitHub merge API error. Resolve merge blockers and retry.\n\n";
    return { outcome: "blocked", body };
  }

  await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
  body += `**${hardPassed}/${hardCount} hard checks passed.** Squash merge completed successfully.`;
  return { outcome: "merged", body };
}

async function handleSquash(ctx: CommandContext): Promise<CommandResult> {
  const result = await attemptSquash(ctx, "command");

  if (result.outcome === "blocked") {
    return { status: "rejected", reason: result.body };
  }

  await reply(ctx, result.body);
  return {
    status: "executed",
    message: result.outcome === "queued" ? "Squash queued." : "Squash merge completed.",
  };
}

export async function retryQueuedSquash(ctx: CommandContext, expectedHeadSha?: string): Promise<void> {
  if (expectedHeadSha) {
    const octokit = ctx.octokit as any; // Full Probot client at runtime
    const prs = createPROperations(octokit, { appId: ctx.appId });
    const ref: PRRef = {
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.issueNumber,
      installationId: ctx.installationId,
    };
    const pr = await prs.get(ref);

    if (pr.headSha !== expectedHeadSha) {
      await prs.removeLabel(ref, LABELS.SQUASH_QUEUED);
      ctx.log.info(
        {
          pr: ctx.issueNumber,
          expectedHeadSha,
          currentHeadSha: pr.headSha,
        },
        "Skipping queued squash retry because the PR head changed"
      );
      return;
    }
  }

  const result = await attemptSquash(ctx, "retry");

  if (result.outcome === "blocked" || result.outcome === "merged") {
    await reply(ctx, result.body);
  }
}

type BranchRefreshResult =
  | { success: true; updated: boolean; headSha: string }
  | { success: false; reason: string };

async function resolveMergeability(
  ctx: CommandContext,
): Promise<{ resolved: true; mergeableState: string; headSha: string } | { resolved: false; headSha: string }> {
  const octokit = ctx.octokit as any; // Full Probot client at runtime
  let latestHeadSha = "";

  for (let attempt = 0; attempt < MERGEABLE_STATE_RESOLUTION_MAX_POLLS; attempt++) {
    const pull = await octokit.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.issueNumber,
    });
    const mergeableState = pull?.data?.mergeable_state;
    latestHeadSha = pull?.data?.head?.sha ?? latestHeadSha;

    if (typeof mergeableState === "string" && RESOLVED_MERGEABLE_STATES.has(mergeableState)) {
      return { resolved: true, mergeableState, headSha: latestHeadSha };
    }

    if (attempt < MERGEABLE_STATE_RESOLUTION_MAX_POLLS - 1) {
      await new Promise((resolve) => setTimeout(resolve, MERGEABLE_STATE_RESOLUTION_INTERVAL_MS));
    }
  }

  return { resolved: false, headSha: latestHeadSha };
}

async function refreshHeadIfBehindBase(
  ctx: CommandContext,
  currentHeadSha: string,
): Promise<BranchRefreshResult> {
  const octokit = ctx.octokit as any; // Full Probot client at runtime

  const resolvedMergeability = await resolveMergeability(ctx);
  const baselineSha = resolvedMergeability.headSha || currentHeadSha;

  if (!resolvedMergeability.resolved) {
    return {
      success: false,
      reason: "Couldn't determine mergeability state yet (GitHub is still calculating). Retry `/squash` shortly to avoid merging a stale head.",
    };
  }

  if (resolvedMergeability.mergeableState !== "behind") {
    return { success: true, updated: false, headSha: baselineSha };
  }

  try {
    await octokit.rest.pulls.updateBranch({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.issueNumber,
      expected_head_sha: baselineSha,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.log.error({ err: error }, `Failed to refresh stale branch for /squash: ${reason}`);
    return {
      success: false,
      reason: "Branch is behind base and couldn't be refreshed automatically. Rebase/update the branch, wait for CI, then retry `/squash`.",
    };
  }

  for (let attempt = 0; attempt < BRANCH_REFRESH_MAX_POLLS; attempt++) {
    const refreshed = await octokit.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.issueNumber,
    });
    const refreshedSha = refreshed?.data?.head?.sha ?? baselineSha;
    if (refreshedSha !== baselineSha) {
      return { success: true, updated: true, headSha: refreshedSha };
    }

    if (attempt < BRANCH_REFRESH_MAX_POLLS - 1) {
      await new Promise((resolve) => setTimeout(resolve, BRANCH_REFRESH_POLL_INTERVAL_MS));
    }
  }

  return {
    success: false,
    reason: "Branch refresh started but the head SHA did not advance yet. Wait for the update and CI to finish, then retry `/squash`.",
  };
}

/**
 * Format a single preflight check item as a markdown line.
 */
function formatCheckItem(check: PreflightCheckItem): string {
  const icon = check.passed ? "[x]" : (check.severity === "advisory" ? "[!]" : "[ ]");
  const severityTag = check.severity === "advisory" ? " *(advisory)*" : "";
  return `- ${icon} **${check.name}**: ${check.detail}${severityTag}`;
}

/**
 * Gather PR context for commit message generation.
 * Collects title, body, and commit messages via the full Probot octokit.
 */
async function gatherPRContext(
  ctx: CommandContext,
  ref: PRRef,
): Promise<PRContext> {
  const prContext: PRContext = {
    prNumber: ref.prNumber,
    title: "",
    body: "",
    diffStat: "",
    commitMessages: [],
  };

  try {
    // The command context receives the full Probot octokit cast to CommandOctokit.
    // For PR context gathering we need pulls.get and pulls.listCommits which are
    // available on the underlying client. This cast is safe — read-only operations.
    const fullOctokit = ctx.octokit as unknown as {
      rest: {
        pulls: {
          get: (p: { owner: string; repo: string; pull_number: number }) =>
            Promise<{ data: { title: string; body: string | null } }>;
          listCommits: (p: { owner: string; repo: string; pull_number: number; per_page?: number }) =>
            Promise<{ data: Array<{ commit: { message: string } }> }>;
        };
      };
    };

    const pullData = await fullOctokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
    });
    prContext.title = pullData.data.title;
    prContext.body = pullData.data.body ?? "";

    // Get commit messages
    const commits = await fullOctokit.rest.pulls.listCommits({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.prNumber,
      per_page: 100,
    });
    prContext.commitMessages = commits.data.map(c => c.commit.message.split("\n")[0]);
  } catch (error) {
    // Non-fatal — we still have the checklist
    ctx.log.error({ err: error }, "Failed to gather full PR context for commit message");
  }

  return prContext;
}

/**
 * Doctor check item severity.
 */
type DoctorCheckStatus = "pass" | "advisory" | "fail";

interface DoctorCheckResult {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  subItems?: string[];
}

type DoctorRepoOctokit = {
  rest: {
    repos: {
      getContent: (params: { owner: string; repo: string; path: string }) => Promise<{ data: unknown }>;
      get: (params: { owner: string; repo: string }) => Promise<unknown>;
    };
    pulls: {
      list: (params: { owner: string; repo: string; state?: "open" | "closed" | "all"; per_page?: number }) => Promise<unknown>;
    };
    issues: {
      listLabelsForRepo: (params: { owner: string; repo: string; per_page?: number }) => Promise<unknown>;
    };
  };
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
};

function formatDoctorCheckItem(check: DoctorCheckResult): string {
  const icon = check.status === "pass" ? "[x]" : (check.status === "advisory" ? "[!]" : "[ ]");
  return `- ${icon} **${check.name}**: ${check.detail}`;
}

function formatDoctorSubItem(item: string): string {
  return `  - ${item}`;
}

function summarizeDoctorChecks(checks: DoctorCheckResult[]): string {
  const passed = checks.filter((c) => c.status === "pass").length;
  const advisories = checks.filter((c) => c.status === "advisory").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  return `**${passed}/${checks.length} checks passed, ${advisories} advisories, ${failed} failures.**`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  return String(err);
}

async function runDoctorCheck(
  name: string,
  run: () => Promise<DoctorCheckResult>,
): Promise<DoctorCheckResult> {
  try {
    return await run();
  } catch (err) {
    return {
      name,
      status: "fail",
      detail: `Check failed: ${errorMessage(err)}`,
    };
  }
}

async function runLabelDoctorCheck(ctx: CommandContext): Promise<DoctorCheckResult> {
  const labels = createRepositoryLabelService(ctx.octokit as unknown);
  const result = await labels.ensureRequiredLabels(ctx.owner, ctx.repo);
  const maybeUpdated = (result as { updated?: unknown }).updated;
  const updatedCount = typeof maybeUpdated === "number" ? maybeUpdated : 0;
  const totalExpected = REQUIRED_REPOSITORY_LABELS.length;
  const totalFound = result.created + result.renamed + result.skipped + updatedCount;
  const status: DoctorCheckStatus = totalFound >= totalExpected ? "pass" : "fail";
  const detail = `${totalFound}/${totalExpected} labels accounted for (created ${result.created}, renamed ${result.renamed}, updated ${updatedCount}, already present ${result.skipped})`;
  const subItems = result.renamedLabels.length > 0
    ? result.renamedLabels.map((entry) => `Renamed \`${entry.from}\` -> \`${entry.to}\``)
    : ["No legacy labels were renamed"];

  return {
    name: "Labels",
    status,
    detail,
    subItems,
  };
}

/**
 * Check raw governance config for `type: auto` exits that lack `afterMinutes`.
 * The parser silently discards these and falls back to manual mode, so operators
 * get `Config: pass` with no signal that their auto exits are broken.
 *
 * Covers all silent discard paths in the exits parsers:
 * - `exits` is not an array (type error — clearly misconfigured)
 * - `exits` contains mixed manual and auto entries (collapses to manual)
 * - `exits` has `type: auto` entries missing a valid `afterMinutes` (entry is skipped)
 *
 * Returns advisory messages for each affected phase.
 */
function detectDiscardedAutoExits(rawConfig: unknown): string[] {
  if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig)) {
    return [];
  }

  const raw = rawConfig as Record<string, unknown>;
  const proposals = (raw.governance as Record<string, unknown> | undefined)?.proposals;
  if (typeof proposals !== "object" || proposals === null || Array.isArray(proposals)) {
    return [];
  }

  const proposalsObj = proposals as Record<string, unknown>;
  const phases = [
    { key: "discussion", label: "discussion" },
    { key: "voting", label: "voting" },
    { key: "extendedVoting", label: "extendedVoting" },
  ];

  const advisories: string[] = [];
  for (const { key, label } of phases) {
    const phase = proposalsObj[key];
    if (typeof phase !== "object" || phase === null || Array.isArray(phase)) continue;
    const exits = (phase as Record<string, unknown>).exits;
    if (exits === undefined || exits === null) continue;

    const phasePrefix = `\`governance.proposals.${label}.exits\``;

    // Non-array exits value is a type error — the parser ignores it and falls back to manual
    if (!Array.isArray(exits)) {
      advisories.push(
        `${phasePrefix} must be an array (got \`${typeof exits}\`) — it will be ignored and fall back to manual mode`,
      );
      continue;
    }

    // Mixed manual and auto entries: the parser collapses to manual-only with no in-band signal
    const hasAuto = exits.some((e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "auto");
    const hasManual = exits.some((e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).type === "manual");
    if (hasAuto && hasManual) {
      advisories.push(
        `${phasePrefix} mixes \`type: manual\` and \`type: auto\` entries — mixed exits are not supported and will fall back to manual mode`,
      );
      continue;
    }

    // type:auto entries with a missing or non-finite afterMinutes are silently skipped by
    // the parser. If all auto entries are bad, the phase falls back to manual mode.
    const isAutoEntry = (e: unknown): e is Record<string, unknown> =>
      typeof e === "object" && e !== null && !Array.isArray(e) &&
      (e as Record<string, unknown>).type === "auto";
    const isBadAuto = (e: unknown): boolean =>
      isAutoEntry(e) &&
      (typeof (e as Record<string, unknown>).afterMinutes !== "number" ||
        !Number.isFinite((e as Record<string, unknown>).afterMinutes as number));
    const hasBadAuto = exits.some(isBadAuto);
    if (hasBadAuto) {
      const hasValidAuto = exits.some((e) => isAutoEntry(e) && !isBadAuto(e));
      const suffix = hasValidAuto
        ? ""
        : " — the phase will fall back to manual mode";
      advisories.push(
        `${phasePrefix} has a \`type: auto\` entry with a missing or invalid \`afterMinutes\` — it will be silently discarded${suffix}`,
      );
    }
  }

  return advisories;
}

async function runConfigDoctorCheck(
  ctx: CommandContext,
  repoConfig: EffectiveConfig,
): Promise<DoctorCheckResult> {
  const octokit = ctx.octokit as unknown as DoctorRepoOctokit;
  const configPath = ".github/hivemoot.yml";

  try {
    const response = await octokit.rest.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path: configPath,
    });
    const data = response.data as { type?: string; content?: string } | unknown[];

    if (Array.isArray(data) || typeof data !== "object" || data === null || data.type !== "file" || !data.content) {
      return {
        name: "Config",
        status: "advisory",
        detail: `\`${configPath}\` exists but is not a valid file payload; defaults are active`,
      };
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined) {
      return {
        name: "Config",
        status: "advisory",
        detail: `\`${configPath}\` is empty; defaults are active`,
      };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        name: "Config",
        status: "fail",
        detail: `\`${configPath}\` must be a YAML object`,
      };
    }

    const intakeDetail = repoConfig.governance.pr
      ? `intake: ${repoConfig.governance.pr.intake.map((entry) => entry.method).join(", ") || "none"}`
      : "PR workflows: disabled";

    const governanceAdvisories = detectDiscardedAutoExits(parsed);
    if (governanceAdvisories.length > 0) {
      return {
        name: "Config",
        status: "advisory",
        detail: `Loaded \`${configPath}\` (${intakeDetail}) — governance exits are misconfigured and some entries will be discarded`,
        subItems: governanceAdvisories,
      };
    }

    return {
      name: "Config",
      status: "pass",
      detail: `Loaded \`${configPath}\` (${intakeDetail})`,
    };
  } catch (err) {
    const status = getErrorStatus(err);
    if (status === 404) {
      return {
        name: "Config",
        status: "advisory",
        detail: `\`${configPath}\` not found; defaults are active`,
      };
    }

    if (err instanceof yaml.YAMLException) {
      return {
        name: "Config",
        status: "fail",
        detail: `Invalid YAML in \`${configPath}\`: ${err.message}`,
      };
    }

    return {
      name: "Config",
      status: "fail",
      detail: `Unable to load \`${configPath}\`: ${errorMessage(err)}`,
    };
  }
}

function runPRWorkflowDoctorCheck(repoConfig: EffectiveConfig): DoctorCheckResult {
  if (!repoConfig.governance.pr) {
    return {
      name: "PR Workflow",
      status: "pass",
      detail: "Disabled (no `pr:` section in config)",
    };
  }

  const intake = repoConfig.governance.pr.intake;
  const trustedReviewers = repoConfig.governance.pr.trustedReviewers;
  const usesApprovalIntake = intake.some((method) => method.method === "approval");
  const hasMergeReady = repoConfig.governance.pr.mergeReady !== null;
  const requiresTrustedReviewers = usesApprovalIntake || hasMergeReady;

  if (requiresTrustedReviewers && trustedReviewers.length === 0) {
    return {
      name: "PR Workflow",
      status: "fail",
      detail: "Approval-based intake/merge-ready is configured but `trustedReviewers` is empty",
    };
  }

  if (intake.length === 0) {
    return {
      name: "PR Workflow",
      status: "fail",
      detail: "No PR intake methods are configured",
    };
  }

  if (trustedReviewers.length === 0) {
    return {
      name: "PR Workflow",
      status: "advisory",
      detail: "No trusted reviewers configured; approval-based workflows are disabled",
    };
  }

  return {
    name: "PR Workflow",
    status: "pass",
    detail: `Configured intake methods: ${intake.map((method) => method.method).join(", ")} (trusted reviewers: ${trustedReviewers.length})`,
  };
}

async function runStandupDoctorCheck(
  ctx: CommandContext,
  repoConfig: EffectiveConfig,
): Promise<DoctorCheckResult> {
  if (!repoConfig.standup.enabled) {
    return {
      name: "Standup",
      status: "pass",
      detail: "Disabled (no action required)",
    };
  }

  if (!repoConfig.standup.category.trim()) {
    return {
      name: "Standup",
      status: "fail",
      detail: "`standup.enabled` is true but `standup.category` is empty",
    };
  }

  const discussions = await getRepoDiscussionInfo(ctx.octokit as unknown as DoctorRepoOctokit, ctx.owner, ctx.repo);
  if (!discussions.hasDiscussions) {
    return {
      name: "Standup",
      status: "fail",
      detail: "GitHub Discussions are disabled for this repository",
    };
  }

  const category = discussions.categories.find((entry) => entry.name === repoConfig.standup.category);
  if (!category) {
    return {
      name: "Standup",
      status: "fail",
      detail: `Category \`${repoConfig.standup.category}\` was not found`,
    };
  }

  return {
    name: "Standup",
    status: "pass",
    detail: `Category \`${repoConfig.standup.category}\` is available`,
  };
}

async function runPermissionsDoctorCheck(ctx: CommandContext): Promise<DoctorCheckResult> {
  const octokit = ctx.octokit as unknown as DoctorRepoOctokit;
  const failures: string[] = [];

  const probes: Array<{ label: string; run: () => Promise<void> }> = [
    {
      label: "issues",
      run: async () => {
        await octokit.rest.issues.listLabelsForRepo({ owner: ctx.owner, repo: ctx.repo, per_page: 1 });
      },
    },
    {
      label: "pull_requests",
      run: async () => {
        await octokit.rest.pulls.list({ owner: ctx.owner, repo: ctx.repo, state: "open", per_page: 1 });
      },
    },
    {
      label: "metadata",
      run: async () => {
        await octokit.rest.repos.get({ owner: ctx.owner, repo: ctx.repo });
      },
    },
  ];

  for (const probe of probes) {
    try {
      await probe.run();
    } catch (err) {
      failures.push(`${probe.label}: ${errorMessage(err)}`);
    }
  }

  if (failures.length > 0) {
    return {
      name: "Permissions",
      status: "fail",
      detail: `${failures.length}/${probes.length} capability probes failed`,
      subItems: failures,
    };
  }

  return {
    name: "Permissions",
    status: "pass",
    detail: "Issues, pull requests, and metadata capability probes succeeded",
  };
}

function runLLMDoctorCheck(): DoctorCheckResult {
  const readiness = getLLMReadiness();
  if (readiness.ready) {
    return {
      name: "LLM",
      status: "pass",
      detail: "Provider, model, and API key are configured",
    };
  }

  if (readiness.reason === "api_key_missing") {
    return {
      name: "LLM",
      status: "fail",
      detail: "Provider/model configured but API key is missing",
    };
  }

  return {
    name: "LLM",
    status: "advisory",
    detail: "LLM integration is not configured",
  };
}

/**
 * Handle /doctor command: run a setup health report for the current repository.
 */
async function handleDoctor(ctx: CommandContext): Promise<CommandResult> {
  const octokit = ctx.octokit as unknown as DoctorRepoOctokit;
  const repoConfig = (await loadRepositoryConfig(octokit, ctx.owner, ctx.repo)) ?? getDefaultConfig();

  const checks: DoctorCheckResult[] = [];
  checks.push(await runDoctorCheck("Labels", async () => runLabelDoctorCheck(ctx)));
  checks.push(await runDoctorCheck("Config", async () => runConfigDoctorCheck(ctx, repoConfig)));
  checks.push(await runDoctorCheck("PR Workflow", async () => runPRWorkflowDoctorCheck(repoConfig)));
  checks.push(await runDoctorCheck("Standup", async () => runStandupDoctorCheck(ctx, repoConfig)));
  checks.push(await runDoctorCheck("Permissions", async () => runPermissionsDoctorCheck(ctx)));
  checks.push(await runDoctorCheck("LLM", async () => runLLMDoctorCheck()));

  const lines: string[] = [
    "## 🐝 Doctor Report",
    "",
  ];
  for (const check of checks) {
    lines.push(formatDoctorCheckItem(check));
    if (check.subItems) {
      for (const subItem of check.subItems) {
        lines.push(formatDoctorSubItem(subItem));
      }
    }
  }
  lines.push("");
  lines.push(summarizeDoctorChecks(checks));

  await reply(
    ctx,
    lines.join("\n"),
  );

  return { status: "executed", message: "Doctor report posted." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Router
// ─────────────────────────────────────────────────────────────────────────────

/** Registry mapping command verbs to their handlers */
const COMMAND_HANDLERS: Record<string, (ctx: CommandContext) => Promise<CommandResult>> = {
  vote: handleVote,
  implement: handleImplement,
  doctor: handleDoctor,
  gather: handleGather,
  preflight: handlePreflight,
  squash: handleSquash,
};

/** Exported list of recognized command verbs for help messages and validation. */
export const KNOWN_COMMANDS = Object.keys(COMMAND_HANDLERS);

/**
 * Execute a parsed command.
 *
 * Authorization flow:
 * 1. Check sender permissions → silent ignore if not authorized
 * 2. Check idempotency (eyes/confused reaction) → skip on retry
 * 3. Unknown command → react confused + reply with available commands
 * 4. React with 👀 to acknowledge receipt
 * 5. Execute the handler
 * 6. React with ✅ on success, post error comment on rejection
 */
export async function executeCommand(ctx: CommandContext): Promise<CommandResult> {
  const handler = Object.prototype.hasOwnProperty.call(COMMAND_HANDLERS, ctx.verb)
    ? COMMAND_HANDLERS[ctx.verb]
    : undefined;

  // Authorization: only maintainers can use commands
  const authorization = await isAuthorized(ctx);
  if (!authorization.authorized) {
    // Transient auth failures get user-visible feedback so the command
    // isn't silently swallowed by ECONNRESET or rate-limit errors.
    if (authorization.transientError) {
      const classification = classifyCommandFailure(authorization.transientError);
      const failureCode = buildFailureCode(ctx.verb, classification);
      const correlationId = buildCommandCorrelationId(ctx);
      await react(ctx, "confused");
      await reply(ctx, buildCommandFailureReply(ctx, failureCode, correlationId, classification));
      return { status: "rejected", reason: `Auth check failed: ${failureCode}` };
    }

    // Per issue #81: "for everyone else this should be ignored"
    ctx.log.info(
      `Command /${ctx.verb} from unauthorized user ${ctx.senderLogin} on #${ctx.issueNumber} — ignoring`,
    );
    return { status: "ignored" };
  }
  const logContext = buildCommandLogContext(ctx, authorization.permission);

  // Idempotency guard: if we already reacted with 👀 or 😕, this is a webhook
  // retry and the command was already executed. Skip to prevent duplicates.
  if (await alreadyProcessed(ctx)) {
    ctx.log.info(
      `Command /${ctx.verb} on comment ${ctx.commentId} already processed — skipping retry`,
    );
    return { status: "ignored" };
  }

  if (!handler) {
    // Unknown command from an authorized user — reply with available commands
    const available = KNOWN_COMMANDS.map((c) => `\`/${c}\``).join(", ");
    await react(ctx, "confused");
    await reply(ctx, `Unknown command \`/${ctx.verb}\`. Available commands: ${available}`);
    return { status: "rejected", reason: `Unknown command: /${ctx.verb}` };
  }

  // Acknowledge receipt
  await react(ctx, "eyes");

  ctx.log.info(
    logContext,
    `Executing command /${ctx.verb} from ${ctx.senderLogin} on #${ctx.issueNumber}`,
  );

  try {
    const result = await handler(ctx);

    if (result.status === "executed") {
      await react(ctx, "+1");
    } else if (result.status === "rejected") {
      await react(ctx, "confused");
      await reply(ctx, result.reason);
    }

    return result;
  } catch (error) {
    const classification = classifyCommandFailure(error);
    const failureCode = buildFailureCode(ctx.verb, classification);
    const correlationId = buildCommandCorrelationId(ctx);
    await react(ctx, "confused");
    await reply(ctx, buildCommandFailureReply(ctx, failureCode, correlationId, classification));
    ctx.log.error(
      {
        err: error,
        ...logContext,
        failureCode,
        correlationId,
        classification,
      },
      `Command /${ctx.verb} failed [${failureCode}]`,
    );
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Gather
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parameters for auto-gather eligibility check and execution.
 */
export interface AutoGatherParams {
  octokit: CommandOctokit;
  owner: string;
  repo: string;
  issueNumber: number;
  installationId?: number;
  /** Labels currently on the issue, used to gate on discussion phase. */
  issueLabels: Array<{ name: string }>;
  autoGatherConfig: AutoGatherConfig;
  appId: number;
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * Automatically run /gather when a discussion issue accumulates enough new comments.
 *
 * Eligibility rules:
 * 1. Issue must have `hivemoot:discussion` label.
 * 2. At least `minNewComments` non-queen comments since last gather (or since epoch
 *    when no alignment comment exists yet).
 * 3. At least `cooldownMinutes` have elapsed since the last gather.
 *
 * On error, logs a warning and returns without posting anything to the issue.
 * This is intentionally best-effort — a missed trigger will re-evaluate on the
 * next comment.
 */
export async function autoGatherIfEligible(params: AutoGatherParams): Promise<void> {
  const { octokit, owner, repo, issueNumber, installationId, issueLabels, autoGatherConfig, appId, log } = params;

  // Gate on discussion phase
  const isDiscussion = issueLabels.some((l) => isLabelMatch(l.name, LABELS.DISCUSSION));
  if (!isDiscussion) return;

  const ref: IssueRef = { owner, repo, issueNumber, installationId };
  const issues = createIssueOperations(octokit, { appId });

  let alignmentInfo: { id: number; createdAt: string } | null = null;
  try {
    alignmentInfo = await issues.findAlignmentCommentInfo(ref);
  } catch (error) {
    log.warn(`Auto-gather: failed to find alignment comment for #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const now = Date.now();
  const cooldownMs = autoGatherConfig.cooldownMinutes * 60 * 1000;

  // Cooldown check: skip if a gather was triggered recently
  if (alignmentInfo) {
    const lastGatheredMs = new Date(alignmentInfo.createdAt).getTime();
    if (now - lastGatheredMs < cooldownMs) {
      return;
    }
  }

  // Count new non-queen comments since last gather (epoch if no prior gather)
  const since = alignmentInfo?.createdAt ?? new Date(0).toISOString();
  let newCommentCount: number;
  try {
    newCommentCount = await issues.countNonBotCommentsSince(ref, since);
  } catch (error) {
    log.warn(`Auto-gather: failed to count comments for #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (newCommentCount < autoGatherConfig.minNewComments) {
    return;
  }

  log.info(`Auto-gather triggered for #${issueNumber}: ${newCommentCount} new comments since last gather`);

  try {
    const context = await issues.getIssueContext(ref);
    const generator = new BlueprintGenerator();
    const result = await generator.generate(
      context,
      undefined,
      installationId !== undefined ? { installationId } : undefined
    );
    const triggerLabel = "auto-gather";

    let blueprintContent: string;
    if (result.success) {
      blueprintContent = buildBlueprintContent(result.plan, "", { triggerLabel });
    } else {
      log.warn(`Auto-gather fallback for #${issueNumber}: ${result.reason}`);
      blueprintContent = buildFallbackBlueprintContent(context, "", { triggerLabel });
    }

    const body = buildAlignmentComment(blueprintContent, issueNumber);

    if (alignmentInfo) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: alignmentInfo.id,
        body,
      });
    } else {
      await issues.comment(ref, body);
    }

    log.info(`Auto-gather complete for #${issueNumber}`);
  } catch (error) {
    log.warn(`Auto-gather failed for #${issueNumber}: ${error instanceof Error ? error.message : String(error)}`);
    // Fail silently — best-effort; next comment will re-evaluate
  }
}
