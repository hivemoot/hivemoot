import chalk from "chalk";
import type { NotificationRef, PublishReadiness, RepoSummary, RoleConfig, SummaryItem, TeamConfig } from "../config/types.js";

const DIVIDER_WIDTH = 50;

// Section types determine which metadata keys appear on the second line
type SectionType = "vote" | "discuss" | "implement" | "unclassified" | "reviewPRs" | "draftPRs" | "addressFeedback" | "driveDiscussion" | "driveImplementation" | "needsHuman";

function sectionDivider(title: string, count: number): string {
  const label = ` ${title} (${count}) `;
  const remaining = Math.max(0, DIVIDER_WIDTH - label.length - 2);
  return chalk.dim("──") + chalk.bold(label) + chalk.dim("─".repeat(remaining));
}

function formatTags(tags: string[]): string {
  if (tags.length === 0) return "";
  return " " + tags.map((t) => chalk.magenta(`[${t}]`)).join(" ");
}

function formatFocusLine(focus: string): string {
  return `Team focus: ${focus}`;
}

function kv(key: string, value: string | number): string {
  return `${key}: ${chalk.dim(String(value))}`;
}

function formatMeta(item: SummaryItem, sectionType: SectionType, currentUser: string): string {
  const isYou = item.author === currentUser;
  const authorVal = isYou ? chalk.green(`${item.author} (you)`) : chalk.dim(item.author);
  const parts: string[] = [`by: ${authorVal}`];

  if (sectionType === "vote" || sectionType === "discuss" || sectionType === "driveDiscussion") {
    parts.push(kv("comments", item.comments));

    // Build "you:" composite field for issue sections
    const youParts: string[] = [];
    if (item.yourComment) {
      const commentAge = item.yourCommentAge ? ` (${item.yourCommentAge})` : "";
      youParts.push(`${item.yourComment}${commentAge}`);
    }
    if (item.yourVote) {
      const voteAge = item.yourVoteAge ? ` (${item.yourVoteAge})` : "";
      youParts.push(`voted ${item.yourVote}${voteAge}`);
    } else if (sectionType === "vote") {
      // Always show vote status on voting sections
      youParts.push("not voted");
    }
    if (youParts.length > 0) {
      parts.push(kv("you", youParts.join(", ")));
    }

    if (item.lastComment) parts.push(kv("last-comment", item.lastComment));
    if (item.updated) parts.push(kv("updated", item.updated));
    parts.push(kv("created", item.age));
  } else if (sectionType === "implement" || sectionType === "unclassified" || sectionType === "needsHuman") {
    parts.push(kv("assigned", item.assigned ?? "--"));
    parts.push(kv("comments", item.comments));

    // Show "you:" on non-voting issue sections only if user has commented
    if (item.yourComment) {
      const commentAge = item.yourCommentAge ? ` (${item.yourCommentAge})` : "";
      parts.push(kv("you", `${item.yourComment}${commentAge}`));
    }

    if (item.lastComment) parts.push(kv("last-comment", item.lastComment));
    if (item.updated) parts.push(kv("updated", item.updated));
    parts.push(kv("created", item.age));
    if (item.competingPRs !== undefined) {
      parts.push(kv("competing", item.competingPRs));
    }
  } else {
    // PR sections: reviewPRs, draftPRs, addressFeedback, driveImplementation
    if (item.status !== undefined) {
      const statusVal = /changes.requested/i.test(item.status) ? chalk.red(item.status) : chalk.dim(item.status);
      parts.push(`status: ${statusVal}`);
    }
    if (item.checks !== undefined && item.checks !== null) {
      const checksVal = /fail/i.test(item.checks) ? chalk.red(item.checks) : chalk.dim(item.checks);
      parts.push(`checks: ${checksVal}`);
    }
    if (item.mergeable !== undefined && item.mergeable !== null) {
      const mergeVal = /conflict/i.test(item.mergeable) ? chalk.red(item.mergeable) : chalk.dim(item.mergeable);
      parts.push(`merge: ${mergeVal}`);
    }
    if (item.review) {
      const segments = [`${item.review.approvals} approved`];
      if (item.review.changesRequested > 0) segments.push(chalk.red(`${item.review.changesRequested} changes-requested`));
      if (item.review.commented > 0) segments.push(chalk.dim(`${item.review.commented} with feedback`));
      parts.push(kv("review", segments.join(", ")));
    }
    if (item.yourReview) {
      const age = item.yourReviewAge ? ` (${item.yourReviewAge})` : "";
      parts.push(kv("you", `${item.yourReview}${age}`));
    }
    if (item.lastCommit) parts.push(kv("last-commit", item.lastCommit));
    if (item.lastComment) parts.push(kv("last-comment", item.lastComment));
    if (item.updated) parts.push(kv("updated", item.updated));
    parts.push(kv("comments", item.comments));
    parts.push(kv("created", item.age));
  }

  if (item.unread && item.unreadReason) {
    const age = item.unreadAge ? ` (${item.unreadAge})` : "";
    parts.push(kv("new", `${item.unreadReason}${age}`));
    if (item.ackKey) {
      parts.push(kv("ack", item.ackKey));
    }
  }

  return parts.join("  ");
}

function formatItem(item: SummaryItem, currentUser: string, sectionType: SectionType): string {
  const isYou = item.author === currentUser;
  const prefix = isYou ? chalk.green("★") : " ";
  const num = chalk.cyan(`#${item.number}`);
  const unreadDot = item.unread ? " " + chalk.yellow("●") : "";
  const tags = formatTags(item.tags);
  const hasProblems = (item.checks && /fail/i.test(item.checks)) || (item.mergeable && /conflict/i.test(item.mergeable));
  const warningIcon = hasProblems ? " " + chalk.red("✗") : "";

  const titleLine = `${prefix} ${num}${unreadDot} ${item.title}${tags}${warningIcon}`;
  const metaLine = `       ${formatMeta(item, sectionType, currentUser)}`;

  return `${titleLine}\n${metaLine}`;
}

function formatSection(
  title: string,
  items: SummaryItem[],
  currentUser: string,
  sectionType: SectionType,
  limit?: number,
): string {
  if (items.length === 0) return "";

  const displayed = limit ? items.slice(0, limit) : items;
  const header = sectionDivider(title, items.length);
  const itemBlocks = displayed.map((item) => formatItem(item, currentUser, sectionType));

  const parts = [header, ...itemBlocks];

  if (limit && items.length > limit) {
    parts.push(chalk.dim(`  ... and ${items.length - limit} more`));
  }

  return parts.join("\n\n");
}

function formatNotificationsSection(title: string, refs: NotificationRef[], limit?: number): string {
  if (refs.length === 0) return "";

  // refs arrive pre-sorted newest-first from buildSummary()
  const displayed = limit ? refs.slice(0, limit) : refs;
  const header = sectionDivider(title, refs.length);
  const lines = displayed.map((r) => {
    const prefix = r.itemType === "Issue" ? "Issue " : r.itemType === "PullRequest" ? "PR " : "";
    const num = chalk.cyan(`${prefix}#${r.number}`);
    return `  ${num} ${r.title}  ${chalk.dim(r.reason)}  ${chalk.dim(r.age)}  ${kv("ack", r.ackKey)}`;
  });

  const parts = [header, ...lines];
  if (limit && refs.length > limit) {
    parts.push(chalk.dim(`  ... ${refs.length - limit} more`));
  }

  return parts.join("\n");
}

function formatRecentClosedSection(summary: RepoSummary, limit?: number): string {
  const items = summary.recentlyClosedByYou ?? [];
  if (items.length === 0) return "";

  const displayed = limit ? items.slice(0, limit) : items;
  const header = sectionDivider("RECENTLY CLOSED (AUTHORED BY YOU)", items.length);
  const lines = displayed.map((item) => {
    const prefix = item.itemType === "pr" ? "PR" : "Issue";
    return `  ${chalk.cyan(`${prefix} #${item.number}`)} ${item.title}  ${chalk.dim(item.outcome)}  ${chalk.dim(item.closedAge ?? "")}`;
  });

  const parts = [header, ...lines];
  if (limit && items.length > limit) {
    parts.push(chalk.dim(`  ... ${items.length - limit} more`));
  }
  return parts.join("\n");
}

function formatRepositoryHealth(summary: RepoSummary): string {
  if (!summary.repositoryHealth) return "";
  const health = summary.repositoryHealth;
  const lines: string[] = [
    sectionDivider("REPOSITORY HEALTH", 1),
    `  Open PRs: ${health.openPRs.total} (${health.openPRs.mergeReady} merge-ready, ${health.openPRs.changesRequested} changes-requested, ${health.openPRs.draft} draft)`,
    `  Review queue: ${health.reviewQueue.waitingForYourReview} waiting for your review${health.reviewQueue.oldestWaitingAge ? ` (oldest ${health.reviewQueue.oldestWaitingAge})` : ""}`,
    `  Stale risk: ${health.staleRisk.prsOlderThan3Days} PRs older than 3 days, ${health.staleRisk.issuesStaleOver24h} issues with no update >24h`,
  ];
  if (health.issuePipeline) {
    lines.splice(
      3,
      0,
      `  Issue pipeline: ${health.issuePipeline.discussion} discussion, ${health.issuePipeline.voting} voting, ${health.issuePipeline.readyToImplement} ready-to-implement`,
    );
  }
  return lines.join("\n");
}

function formatPrioritySignals(summary: RepoSummary): string {
  const signals = summary.prioritySignals ?? [];
  if (signals.length === 0) return "";
  const lines = [sectionDivider("PRIORITY SIGNALS", signals.length)];

  for (let i = 0; i < signals.length; i++) {
    const prefix = i === 0 ? "Highest pressure" : i === 1 ? "Next pressure" : `Signal ${i + 1}`;
    lines.push(`  ${prefix}: ${signals[i].kind} (${signals[i].summary})`);
  }

  return lines.join("\n");
}

function formatPublishReadinessSection(readiness: PublishReadiness): string {
  if (readiness.canPush) return "";
  const lines = [sectionDivider("PUBLISH READINESS", 1)];
  lines.push(chalk.red(`  ✗ ${readiness.message ?? "Cannot push to origin."}`));
  return lines.join("\n");
}

function formatSummaryBody(summary: RepoSummary, limit?: number): string {
  const u = summary.currentUser;
  const sections: string[] = [];

  sections.push(
    ...[
      formatNotificationsSection("NOTIFICATIONS", summary.notifications, limit),
      formatNotificationsSection("UNACKED MENTIONS", summary.unackedMentions ?? [], limit),
      formatRepositoryHealth(summary),
      formatPrioritySignals(summary),
      formatSection("NEEDS HUMAN", summary.needsHuman, u, "needsHuman", limit),
      formatSection("DRIVE THE DISCUSSION", summary.driveDiscussion, u, "driveDiscussion", limit),
      formatSection("DRIVE THE IMPLEMENTATION", summary.driveImplementation, u, "driveImplementation", limit),
      formatSection("VOTE ON ISSUES", summary.voteOn, u, "vote", limit),
      formatSection("DISCUSS ISSUES", summary.discuss, u, "discuss", limit),
      formatSection("READY TO IMPLEMENT ISSUES", summary.implement, u, "implement", limit),
      formatSection("UNCLASSIFIED ISSUES", summary.unclassified ?? [], u, "unclassified", limit),
      formatSection("REVIEW PRs", summary.reviewPRs, u, "reviewPRs", limit),
      formatSection("DRAFT PRs", summary.draftPRs, u, "draftPRs", limit),
      formatSection("ADDRESS FEEDBACK PRs", summary.addressFeedback, u, "addressFeedback", limit),
      formatRecentClosedSection(summary, limit),
      summary.publishReadiness ? formatPublishReadinessSection(summary.publishReadiness) : "",
    ].filter(Boolean),
  );

  if (summary.notes.length > 0) {
    sections.push(summary.notes.map((n) => chalk.dim(`  ${n}`)).join("\n"));
  }

  if (sections.length === 0) {
    return chalk.dim("  No open issues or PRs.");
  }

  return sections.join("\n\n");
}

export function formatBuzz(
  roleName: string,
  role: RoleConfig,
  summary: RepoSummary,
  limit?: number,
  onboarding?: string,
): string {
  const lines: string[] = [];

  if (onboarding) {
    lines.push(chalk.bold("ONBOARDING:"), onboarding.trimEnd(), "");
  }

  lines.push(
    chalk.bold(`ROLE: ${roleName}`) + ` — ${role.description}`,
    "",
    chalk.bold("INSTRUCTIONS:"),
    role.instructions.trimEnd(),
    "",
    summary.currentUser
      ? `You are working on ${chalk.bold(`${summary.repo.owner}/${summary.repo.repo}`)}, logged in as ${chalk.green(summary.currentUser)}`
      : `You are working on ${chalk.bold(`${summary.repo.owner}/${summary.repo.repo}`)}`,
    ...(summary.focus ? [formatFocusLine(summary.focus)] : []),
    "",
    formatSummaryBody(summary, limit),
  );

  return lines.join("\n");
}

export function formatStatus(summary: RepoSummary, limit?: number): string {
  const lines = [
    summary.currentUser
      ? `You are working on ${chalk.bold(`${summary.repo.owner}/${summary.repo.repo}`)}, logged in as ${chalk.green(summary.currentUser)}`
      : `You are working on ${chalk.bold(`${summary.repo.owner}/${summary.repo.repo}`)}`,
    ...(summary.focus ? [formatFocusLine(summary.focus)] : []),
    "",
    formatSummaryBody(summary, limit),
  ];

  return lines.join("\n");
}

export function formatRole(roleName: string, role: RoleConfig, repoFullName: string, onboarding?: string): string {
  const lines: string[] = [];

  if (onboarding) {
    lines.push(chalk.bold("ONBOARDING:"), onboarding.trimEnd(), "");
  }

  lines.push(
    chalk.bold(`ROLE — ${repoFullName}`),
    "",
    `Name: ${chalk.cyan(roleName)}`,
    `Description: ${role.description}`,
    "",
    "Instructions:",
    role.instructions.trimEnd(),
  );

  return lines.join("\n");
}

export function formatRoles(teamConfig: TeamConfig, repoFullName: string): string {
  const nameLabel = teamConfig.name ? ` (${teamConfig.name})` : "";
  const lines = [
    chalk.bold(`ROLES — ${repoFullName}${nameLabel}`),
    "",
  ];

  const slugs = Object.keys(teamConfig.roles);
  const maxLen = Math.max(...slugs.map((s) => s.length));

  for (const slug of slugs) {
    const role = teamConfig.roles[slug];
    const padded = slug.padEnd(maxLen + 2);
    lines.push(`  ${chalk.cyan(padded)}${role.description}`);
  }

  return lines.join("\n");
}
