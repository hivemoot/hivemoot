/**
 * Hivemoot Bot Configuration
 *
 * Shared configuration for governance automation across webhook handlers
 * and scheduled scripts.
 */

import { SIGNATURES, buildNotificationComment, NOTIFICATION_TYPES } from "./lib/bot-comments.js";

// ───────────────────────────────────────────────────────────────────────────────
// Configuration Boundaries
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Configuration boundaries for all tunable settings.
 * Used by both env-var parsing (global defaults) and repo-config parsing (per-repo overrides).
 * All duration values are in minutes.
 */
export const CONFIG_BOUNDS = {
  phaseDurationMinutes: {
    min: 1,
    max: 30 * 24 * 60, // 30 days
    default: 24 * 60, // 24 hours
  },
  prStaleDays: {
    min: 1,
    max: 30,
    default: 3,
  },
  maxPRsPerIssue: {
    min: 1,
    max: 10,
    default: 3,
  },
  voting: {
    minVoters: { min: 0, max: 50, default: 3 },
  },
  requiredVoters: {
    maxEntries: 20,
    maxUsernameLength: 39,
  },
  mergeReady: {
    minApprovals: { min: 1, max: 20, default: 1 },
  },
  automerge: {
    maxFiles: { min: 1, max: 50, default: 5 },
    maxChangedLines: { min: 1, max: 1000, default: 80 },
    maxPathPatterns: 50,
    minApprovals: { min: 1, max: 20, default: 2 },
  },
  llmMaxTokens: {
    min: 500,
    max: 32_768,
    default: 4_096,
  },
  autoGather: {
    minNewComments: { min: 1, max: 100, default: 5 },
    cooldownMinutes: { min: 5, max: 10080, default: 60 }, // 5 min..7 days
  },
} as const;

// ───────────────────────────────────────────────────────────────────────────────
// Phase Durations
// ───────────────────────────────────────────────────────────────────────────────

const DEFAULT_PHASE_DURATION_MINUTES = CONFIG_BOUNDS.phaseDurationMinutes.default;
const MIN_PHASE_DURATION_MINUTES = CONFIG_BOUNDS.phaseDurationMinutes.min;
const MAX_PHASE_DURATION_MINUTES = CONFIG_BOUNDS.phaseDurationMinutes.max;

/**
 * Parse duration from environment variable with validation bounds.
 * Returns milliseconds.
 */
const parseMinutesToMs = (envVar: string | undefined, defaultMinutes: number): number => {
  const minutes = parseInt(envVar ?? "", 10);
  if (Number.isNaN(minutes)) {
    return defaultMinutes * 60 * 1000;
  }

  // Clamp to valid range
  const clampedMinutes = Math.max(
    MIN_PHASE_DURATION_MINUTES,
    Math.min(MAX_PHASE_DURATION_MINUTES, minutes)
  );

  return clampedMinutes * 60 * 1000;
};

export const DISCUSSION_DURATION_MS = parseMinutesToMs(
  process.env.HIVEMOOT_DISCUSSION_DURATION_MINUTES,
  DEFAULT_PHASE_DURATION_MINUTES
);

export const VOTING_DURATION_MS = parseMinutesToMs(
  process.env.HIVEMOOT_VOTING_DURATION_MINUTES,
  DEFAULT_PHASE_DURATION_MINUTES
);

// ───────────────────────────────────────────────────────────────────────────────
// Bot Signature & Identifiers
// ───────────────────────────────────────────────────────────────────────────────

export const SIGNATURE = "\n\n---\nbuzz buzz 🐝 Hivemoot Queen";

// ───────────────────────────────────────────────────────────────────────────────
// Message Templates
// ───────────────────────────────────────────────────────────────────────────────

/** Format vote results for display */
const formatVotes = (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) =>
  `**Results:** 👍 ${votes.thumbsUp} | 👎 ${votes.thumbsDown} | 😕 ${votes.confused} | 👀 ${votes.eyes}`;

const formatVotingRequirements = (opts: {
  minVoters: number;
  validVoters: number;
  missingRequired: string[];
  requiredVotersNeeded?: number;
  requiredVotersParticipated?: number;
}) => {
  const lines = [
    opts.minVoters > 0
      ? `- Quorum: ${opts.validVoters}/${opts.minVoters} valid voters`
      : "- Quorum: not required",
  ];
  if (opts.missingRequired.length > 0) {
    const mentions = opts.missingRequired.map((u) => `@${u}`).join(", ");
    const needed = opts.requiredVotersNeeded ?? 0;
    const participated = opts.requiredVotersParticipated ?? 0;
    const stillNeeded = needed - participated;
    if (stillNeeded > 0 && stillNeeded < opts.missingRequired.length) {
      // N-of-M: not all missing voters are individually required
      lines.push(`- Need ${stillNeeded} more required voter${stillNeeded === 1 ? "" : "s"} from: ${mentions}`);
    } else {
      lines.push(`- Missing required voters: ${mentions}`);
    }
  }
  return lines.join("\n");
};

const ISSUE_WELCOME_VOTING = `# 🐝 Discussion Phase

Welcome to hivemoot! Share your analysis, proposals, or concerns.

**Ready to vote?** React 👍 on the issue above to signal readiness. Voting opens in ~24 hours, or earlier if enough participants are ready.${SIGNATURE}`;

const ISSUE_WELCOME_MANUAL = `# 🐝 Discussion Phase

Welcome to hivemoot! Share your analysis, proposals, or concerns.

React 👍 on the issue to show support (or 👎 if it needs more discussion).

Nothing moves forward automatically here. Discussion and reactions are encouraged; a maintainer will take the next step when there's enough support.${SIGNATURE}`;

export const MESSAGES = {
  // Posted when a new issue is opened and voting automation is enabled.
  ISSUE_WELCOME_VOTING,
  // Backward-compat alias; prefer ISSUE_WELCOME_VOTING.
  ISSUE_WELCOME: ISSUE_WELCOME_VOTING,

  // Posted when a new issue is opened and decision method is manual.
  ISSUE_WELCOME_MANUAL,

  // Posted when a new PR is opened with no linked issues
  PR_NO_LINKED_ISSUE: `# 🐝 No Linked Issue

This PR doesn't reference an approved issue.

Link it using closing keywords in the description:
\`Fixes #<issue-number>\`, \`Fixes owner/repo#<issue-number>\`, or \`Fixes https://github.com/owner/repo/issues/<issue-number>\` (also \`Closes\` / \`Resolves\`).${SIGNATURE}`,

  // Posted when discussion phase ends
  votingStart: (priority?: "high" | "medium" | "low") => {
    const priorityHeader = priority ? ` (${priority.toUpperCase()} PRIORITY)` : "";
    const priorityReminder = priority
      ? `\n\nThis issue is marked **${priority}-priority** — your timely vote is appreciated.`
      : "";

    return `# 🐝 Voting Phase${priorityHeader}

Time for hivemoot to decide.${priorityReminder}

**${SIGNATURES.VOTING}:**
- 👍 **Ready** — Approve for implementation
- 👎 **Not Ready** — Close this proposal
- 😕 **Needs Discussion** — Back to discussion
- 👀 **Needs Human Input** — Escalate for human review

Voting closes in ~24 hours.${SIGNATURE}`;
  },

  // Backward-compat alias
  VOTING_START: `# 🐝 Voting Phase

Time for hivemoot to decide.

**${SIGNATURES.VOTING} (react once — multiple reactions = no vote):**
- 👍 **Ready** — Approve for implementation
- 👎 **Not Ready** — Close this proposal
- 😕 **Needs Discussion** — Back to discussion
- 👀 **Needs Human Input** — Escalate for human review

Voting closes in ~24 hours.${SIGNATURE}`,

  // Posted when voting ends with a ready-to-implement outcome
  votingEndReadyToImplement: (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) => `# 🐝 Ready to Implement ✅

${formatVotes(votes)}

Hivemoot has spoken. Ready for implementation.

Next steps:
- Open a PR for review if you plan to implement.
- Link this issue in the PR description using a closing keyword (e.g., \`Fixes #<issue-number>\`, \`Fixes owner/repo#<issue-number>\`, or \`Fixes https://github.com/owner/repo/issues/<issue-number>\`; \`Closes\` / \`Resolves\` also work).
- Implementation slots are limited; additional PRs may be deferred to a later round.${SIGNATURE}`,

  // Posted when voting ends with rejection
  votingEndRejected: (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) => `# 🐝 Rejected ❌

${formatVotes(votes)}

Hivemoot has decided. This proposal is closed.${SIGNATURE}`,

  // Posted when voting ends with needs-more-discussion (majority abstain)
  votingEndNeedsMoreDiscussion: (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) => `# 🐝 Needs More Discussion 💬

${formatVotes(votes)}

Back to the drawing board. Returning to discussion phase.${SIGNATURE}`,

  // Posted when voting ends with needs-human-input (eyes majority)
  votingEndNeedsHumanInput: (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) => `# 🐝 Needs Human Input 👀

${formatVotes(votes)}

The hive has spoken — this issue needs a human to weigh in. The issue remains open and unlocked for human response.

Remove the \`hivemoot:needs-human\` label when you've addressed the concern.${SIGNATURE}`,

  // Posted when voting ends with tie/no votes (first round - extended voting begins)
  votingEndInconclusive: (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) => `# 🐝 Extended Voting ⚖️

${formatVotes(votes)}

The initial vote was tied. Voting continues — react to the voting comment above.${SIGNATURE}`,

  // Posted when voting requirements (quorum/required voters) are not met
  votingEndRequirementsNotMet: (params: {
    votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number };
    minVoters: number;
    validVoters: number;
    missingRequired: string[];
    requiredVotersNeeded?: number;
    requiredVotersParticipated?: number;
    final: boolean;
  }) => `# 🐝 ${params.final ? "Inconclusive" : "Extended Voting"} (Requirements Not Met) ⚖️

${formatVotes(params.votes)}

Voting requirements were not met:
${formatVotingRequirements({
  minVoters: params.minVoters,
  validVoters: params.validVoters,
  missingRequired: params.missingRequired,
  requiredVotersNeeded: params.requiredVotersNeeded,
  requiredVotersParticipated: params.requiredVotersParticipated,
})}

${params.final
  ? "Extended voting ended without meeting requirements. Closing this issue."
  : "Extended voting begins — continue voting above."}${SIGNATURE}`,

  // Posted when extended voting resolves with a clear winner
  votingEndInconclusiveResolved: (
    votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number },
    outcome: "ready-to-implement" | "rejected" | "needs-human-input"
  ) => {
    const config = {
      "ready-to-implement": {
        status: "Ready to Implement",
        emoji: "✅",
        explanation: "Patience paid off. Ready for implementation.",
      },
      rejected: {
        status: "Rejected",
        emoji: "❌",
        explanation: "Hivemoot has decided. This proposal is closed.",
      },
      "needs-human-input": {
        status: "Needs Human Input",
        emoji: "👀",
        explanation: "The hive has spoken — this issue needs a human to weigh in. Remove the `hivemoot:needs-human` label when you've addressed the concern.",
      },
    }[outcome];
    return `# 🐝 ${config.status} ${config.emoji}

${formatVotes(votes)}

${config.explanation}${SIGNATURE}`;
  },

  // Posted when extended voting still results in a tie (final closure)
  votingEndInconclusiveFinal: (votes: { thumbsUp: number; thumbsDown: number; confused: number; eyes: number }) => `# 🐝 Inconclusive (Final) 🔒

${formatVotes(votes)}

Hivemoot couldn't reach consensus after two voting periods. Closing this issue.

A maintainer can reopen if circumstances change.${SIGNATURE}`,

  // Posted when the voting comment cannot be found (human intervention needed)
  votingCommentNotFound: () => `${SIGNATURES.HUMAN_HELP}

*adjusts tiny crown nervously*

Look, I hate to admit it, but I need help. This issue has a \`hivemoot:voting\` or \`hivemoot:extended-voting\` label, but I can't find my voting comment anywhere. I've checked under every honeycomb. Nothing.

The hive usually handles everything autonomously, but this one has me stumped.

**What went wrong:**
- My voting comment vanished (deleted? abducted by aliens?)
- Or it's in an old format from before my upgrade

**Dear human, please:**
1. Check if there's a voting comment with "React to THIS comment to vote"
2. If it exists but looks old, update it to match the new format
3. If it's truly gone, manually resolve this issue or restart voting

*The Queen waits patiently for human intervention. Take your time. I'll just be here. Buzzing.*${SIGNATURE}`,
};

// ───────────────────────────────────────────────────────────────────────────────
// Labels
// ───────────────────────────────────────────────────────────────────────────────

export const LABELS = {
  DISCUSSION: "hivemoot:discussion",
  VOTING: "hivemoot:voting",
  READY_TO_IMPLEMENT: "hivemoot:ready-to-implement",
  REJECTED: "hivemoot:rejected",
  EXTENDED_VOTING: "hivemoot:extended-voting",
  INCONCLUSIVE: "hivemoot:inconclusive",
  IMPLEMENTATION: "hivemoot:candidate",
  STALE: "hivemoot:stale",
  IMPLEMENTED: "hivemoot:implemented",
  NEEDS_HUMAN: "hivemoot:needs-human",
  MERGE_READY: "hivemoot:merge-ready",
  SQUASH_QUEUED: "hivemoot:squash-queued",
  AUTOMERGE: "hivemoot:automerge",
} as const;

export const PRIORITY_LABELS = {
  HIGH: "hivemoot:high-priority",
  MEDIUM: "hivemoot:medium-priority",
  LOW: "hivemoot:low-priority",
} as const;

/**
 * Maps old label names to canonical new names.
 * Enables dual support during transition: old labels are recognized on read,
 * new labels are used on write.
 */
export const LEGACY_LABEL_MAP: Record<string, string> = {
  "phase:discussion": LABELS.DISCUSSION,
  "phase:voting": LABELS.VOTING,
  "phase:extended-voting": LABELS.EXTENDED_VOTING,
  "ready-to-implement": LABELS.READY_TO_IMPLEMENT,
  "phase:ready-to-implement": LABELS.READY_TO_IMPLEMENT,
  "rejected": LABELS.REJECTED,
  "inconclusive": LABELS.INCONCLUSIVE,
  "implementation": LABELS.IMPLEMENTATION,
  "stale": LABELS.STALE,
  "implemented": LABELS.IMPLEMENTED,
  "needs:human": LABELS.NEEDS_HUMAN,
  "merge-ready": LABELS.MERGE_READY,
};

/**
 * Check if a label name matches a LABELS value, supporting legacy names.
 * Returns true if `name` equals the canonical label or maps to it via LEGACY_LABEL_MAP.
 */
export function isLabelMatch(name: string | undefined, label: string): boolean {
  if (!name) return false;
  return name === label || LEGACY_LABEL_MAP[name] === label;
}

/**
 * Return all label names that refer to the same canonical label.
 * Result: [canonical, ...legacyAliases].
 *
 * Use this when building GitHub API queries (e.g., `labels` filter on
 * `listForRepo`) which only match exact names. Querying each alias
 * ensures entities carrying either old or new labels are found.
 */
export function getLabelQueryAliases(label: string): string[] {
  const aliases = [label];
  for (const [legacy, canonical] of Object.entries(LEGACY_LABEL_MAP)) {
    if (canonical === label) {
      aliases.push(legacy);
    }
  }
  return aliases;
}

export interface RepositoryLabelDefinition {
  name: string;
  color: string;
  description: string;
}

/**
 * Labels that must exist in each repository where the app is installed.
 * Colors are GitHub hex codes without `#`.
 */
export const REQUIRED_REPOSITORY_LABELS: readonly RepositoryLabelDefinition[] = [
  {
    name: LABELS.DISCUSSION,
    color: "1d76db",
    description: "Issue is in discussion phase.",
  },
  {
    name: LABELS.VOTING,
    color: "5319e7",
    description: "Issue is in voting phase.",
  },
  {
    name: LABELS.READY_TO_IMPLEMENT,
    color: "0e8a16",
    description: "Proposal passed and is ready for implementation.",
  },
  {
    name: LABELS.REJECTED,
    color: "d73a4a",
    description: "Proposal was rejected by voting.",
  },
  {
    name: LABELS.EXTENDED_VOTING,
    color: "fbca04",
    description: "Extended voting round is active.",
  },
  {
    name: LABELS.INCONCLUSIVE,
    color: "6e7781",
    description: "Voting ended without consensus.",
  },
  {
    name: LABELS.IMPLEMENTATION,
    color: "0e8a92",
    description: "PR is an active implementation candidate.",
  },
  {
    name: LABELS.STALE,
    color: "c5d0d8",
    description: "PR has been inactive and may be auto-closed.",
  },
  {
    name: LABELS.IMPLEMENTED,
    color: "1f883d",
    description: "Issue was implemented by a merged PR.",
  },
  {
    name: LABELS.NEEDS_HUMAN,
    color: "e99695",
    description: "Human maintainer intervention is required.",
  },
  {
    name: LABELS.MERGE_READY,
    color: "2ea043",
    description: "Implementation PR meets merge-readiness checks.",
  },
  {
    name: LABELS.SQUASH_QUEUED,
    color: "fbca04",
    description: "PR is queued for automatic squash retry when CI completes.",
  },
  {
    name: LABELS.AUTOMERGE,
    color: "7057ff",
    description: "PR qualifies for automatic merge.",
  },
  {
    name: PRIORITY_LABELS.HIGH,
    color: "d73a4a",
    description: "High priority — critical or blocking issue.",
  },
  {
    name: PRIORITY_LABELS.MEDIUM,
    color: "fbca04",
    description: "Medium priority — important, should be addressed soon.",
  },
  {
    name: PRIORITY_LABELS.LOW,
    color: "0e8a16",
    description: "Low priority — nice to have, do when capacity allows.",
  },
] as const;

// ───────────────────────────────────────────────────────────────────────────────
// PR Configuration
// ───────────────────────────────────────────────────────────────────────────────

const DEFAULT_PR_STALE_DAYS = CONFIG_BOUNDS.prStaleDays.default;
const MIN_PR_STALE_DAYS = CONFIG_BOUNDS.prStaleDays.min;
const MAX_PR_STALE_DAYS = CONFIG_BOUNDS.prStaleDays.max;

const DEFAULT_MAX_PRS_PER_ISSUE = CONFIG_BOUNDS.maxPRsPerIssue.default;
const MIN_MAX_PRS_PER_ISSUE = CONFIG_BOUNDS.maxPRsPerIssue.min;
const MAX_MAX_PRS_PER_ISSUE = CONFIG_BOUNDS.maxPRsPerIssue.max;

/**
 * Parse integer from environment variable with validation bounds.
 */
const parseIntWithBounds = (
  envVar: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number => {
  const value = parseInt(envVar ?? "", 10);
  if (Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.max(min, Math.min(max, value));
};

export const PR_STALE_THRESHOLD_DAYS = parseIntWithBounds(
  process.env.HIVEMOOT_PR_STALE_DAYS,
  DEFAULT_PR_STALE_DAYS,
  MIN_PR_STALE_DAYS,
  MAX_PR_STALE_DAYS
);

export const MAX_PRS_PER_ISSUE = parseIntWithBounds(
  process.env.HIVEMOOT_MAX_PRS_PER_ISSUE,
  DEFAULT_MAX_PRS_PER_ISSUE,
  MIN_MAX_PRS_PER_ISSUE,
  MAX_MAX_PRS_PER_ISSUE
);

// ───────────────────────────────────────────────────────────────────────────────
// PR Message Templates
// ───────────────────────────────────────────────────────────────────────────────

export const PR_MESSAGES = {
  /**
   * Posted when a PR is opened that links to a phase:ready-to-implement issue.
   * Wrapped with notification metadata for idempotent duplicate detection.
   */
  IMPLEMENTATION_WELCOME: (issueNumber: number, priority?: "high" | "medium" | "low") => {
    const priorityHeader = priority ? ` (${priority.toUpperCase()} PRIORITY)` : "";
    const priorityReminder = priority
      ? `\n\nThis issue is marked **${priority}-priority** — timely implementation and review are especially appreciated.\n`
      : "";

    return buildNotificationComment(
      `# 🐝 Implementation PR${priorityHeader}

Multiple implementations for #${issueNumber} may compete — may the best code win.${priorityReminder}
Focus on a clean implementation and quick responses to reviews to stay in the lead.${SIGNATURE}`,
      issueNumber,
      NOTIFICATION_TYPES.IMPLEMENTATION_WELCOME
    );
  },

  /**
   * Posted to the linked issue when a new implementation PR is opened.
   * Wrapped with notification metadata for idempotent duplicate detection.
   * Uses prNumber as the reference number so each PR's notification is independently deduplicated.
   */
  issueNewPR: (prNumber: number, totalPRs: number) =>
    buildNotificationComment(
      `# 🐝 New Implementation 🔨

#${prNumber} submitted. ${totalPRs} competing implementation${totalPRs === 1 ? "" : "s"} now.${SIGNATURE}`,
      prNumber,
      NOTIFICATION_TYPES.ISSUE_NEW_PR
    ),

  /**
   * Posted to the issue when it's implemented via a merged PR.
   */
  issueImplemented: (prNumber: number) =>
    `# 🐝 Implemented ✅

Merged via #${prNumber}. Hivemoot delivers. 🍯${SIGNATURE}`,

  /**
   * Posted to a PR when it's rejected due to PR limit being reached.
   */
  prLimitReached: (maxPRs: number, existingPRNumbers: number[]) =>
    `# 🐝 PR Limit Reached 🚫

Already ${maxPRs} competing implementations: ${existingPRNumbers.map((n) => `#${n}`).join(", ")}

PR closed. Consider improving an existing PR or waiting for a stale one to close.${SIGNATURE}`,

  /**
   * Posted to a PR when the limit is full during activation (no slot yet).
   */
  prNoRoomYet: (maxPRs: number, existingPRNumbers: number[]) =>
    `# 🐝 No Room Yet ⏳

Already ${maxPRs} active implementation PRs: ${existingPRNumbers.map((n) => `#${n}`).join(", ")}

This PR isn't tracked yet. Try again after a slot opens.${SIGNATURE}`,

  /**
   * Posted to a PR when it links to an issue that isn't phase:ready-to-implement yet.
   */
  issueNotReadyToImplement: (issueNumber: number) =>
    `# 🐝 Not Ready Yet ⚠️

Issue #${issueNumber} hasn't passed voting. This PR won't be tracked until it does.${SIGNATURE}`,

  /**
   * Posted to a PR when it links to an issue in a terminal closed state
   * (rejected, inconclusive, or already implemented).
   */
  issueClosedNoTracking: (issueNumber: number) =>
    `# 🐝 Issue Closed ❌\n\nIssue #${issueNumber} is closed — this PR won't be tracked.${SIGNATURE}`,

  /**
   * Posted to a PR when the issue is ready but the PR needs a post-approval update.
   */
  issueReadyNeedsUpdate: (issueNumber: number) =>
    `# 🐝 Update Needed ⏳

Issue #${issueNumber} passed voting, but this PR was opened before approval and was not automatically activated for implementation tracking.

Pre-ready PRs require a fresh post-vote signal so implementation tracking reflects the approved proposal.
Depending on this repo's intake rules, activate by adding a new commit/comment or by meeting trusted-reviewer approval requirements.${SIGNATURE}`,

  /**
   * Posted to a PR when it becomes stale (no activity for threshold days).
   */
  prStaleWarning: (daysSinceActivity: number, daysUntilClose: number) =>
    `# 🐝 Stale Warning ⏰

No activity for ${daysSinceActivity} days. Auto-closes in ${daysUntilClose} days without an update.${SIGNATURE}`,

  /**
   * Posted to a PR when it's auto-closed due to inactivity.
   */
  prStaleClosed: (daysSinceActivity: number) =>
    `# 🐝 Auto-Closed 🔒

Closed after ${daysSinceActivity} days of inactivity. Issue remains open for other implementations.${SIGNATURE}`,

  /**
   * Posted to a PR when it is converted to draft and merge-ready labels are removed.
   */
  prConvertedToDraft: (removedLabels: string[]) =>
    `# 🐝 Back to Draft 📝

Converted to draft, so removed ${removedLabels.map((label) => `\`${label}\``).join(" and ")}.
Mark this PR ready for review to re-run merge-readiness and automerge checks.${SIGNATURE}`,

  /**
   * Posted to competing PRs when another PR is merged for the same issue.
   */
  prSuperseded: (mergedPRNumber: number) =>
    `# 🐝 Superseded

Implemented via #${mergedPRNumber}. Closing this competing implementation.${SIGNATURE}`,

  /**
   * Posted as a reminder to review competing implementations.
   */
  approvalReminder: (prNumbers: number[]) =>
    `# 🐝 Review Time 💡

${prNumbers.length} competing implementations: ${prNumbers.map((n) => `#${n}`).join(", ")}

Review and approve the best one.${SIGNATURE}`,

  /**
   * Posted to existing PRs when their linked issue is ready to implement.
   * Notifies the PR author to push an update so the PR can be considered.
   * Wrapped with notification metadata for idempotent duplicate detection.
   */
  issueReadyToImplement: (issueNumber: number, prAuthor: string) =>
    buildNotificationComment(
      `# 🐝 Issue #${issueNumber} Ready to Implement ✅

Good news @${prAuthor} — Issue #${issueNumber} is ready for implementation!

Push a new commit or add a comment to activate it for implementation tracking.${SIGNATURE}`,
      issueNumber,
      NOTIFICATION_TYPES.VOTING_PASSED
    ),
};
