import { CliError, type BuzzOptions, type GitHubIssue } from "../config/types.js";
import { loadTeamConfig } from "../config/loader.js";
import { resolveRepo } from "../github/repo.js";
import { fetchIssues } from "../github/issues.js";
import { fetchPulls } from "../github/pulls.js";
import { fetchCurrentUser } from "../github/user.js";
import { fetchVotes } from "../github/votes.js";
import { fetchNotifications } from "../github/notifications.js";
import type { NotificationMap } from "../github/notifications.js";
import { buildSummary } from "../summary/builder.js";
import { isVotingIssue } from "../summary/utils.js";
import { formatBuzz, formatStatus } from "../output/formatter.js";
import { jsonBuzz, jsonStatus } from "../output/json.js";

function errorDetail(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function buzzCommand(options: BuzzOptions): Promise<void> {
  const repo = await resolveRepo(options.repo);
  const fetchLimit = options.fetchLimit ?? 200;

  const [issuesResult, prsResult, userResult, notificationsResult] = await Promise.allSettled([
    fetchIssues(repo, fetchLimit),
    fetchPulls(repo, fetchLimit),
    fetchCurrentUser(),
    fetchNotifications(repo),
  ]);

  // If the primary fetches all failed, surface the most actionable CliError.
  if (
    issuesResult.status === "rejected" &&
    prsResult.status === "rejected" &&
    userResult.status === "rejected"
  ) {
    const cliErrors = [issuesResult, prsResult, userResult]
      .map((r) => r.reason)
      .filter((r): r is CliError => r instanceof CliError);
    const actionableCodes = ["GH_NOT_AUTHENTICATED", "RATE_LIMITED", "GH_NOT_FOUND"];
    const best = cliErrors.find((e) => actionableCodes.includes(e.code)) ?? cliErrors[0];
    throw best ?? issuesResult.reason;
  }

  const issues = issuesResult.status === "fulfilled" ? issuesResult.value : [];
  const prs = prsResult.status === "fulfilled" ? prsResult.value : [];
  const currentUser = userResult.status === "fulfilled" ? userResult.value : "";
  const notifications: NotificationMap = notificationsResult.status === "fulfilled" ? notificationsResult.value : new Map();

  // Fetch vote reactions for voting-phase issues
  const votingIssueNumbers = issues
    .filter((issue: GitHubIssue) => isVotingIssue(issue.labels))
    .map((issue: GitHubIssue) => issue.number);

  let votes = new Map<number, { reaction: string; createdAt: string }>();
  let voteFetchFailed = false;
  try {
    votes = await fetchVotes(repo, votingIssueNumbers, currentUser);
  } catch {
    voteFetchFailed = true;
  }

  const summary = buildSummary(repo, issues, prs, currentUser, new Date(), votes, notifications);

  if (issuesResult.status === "rejected" && prsResult.status === "rejected") {
    summary.notes.push(
      `Could not fetch issues (${errorDetail(issuesResult.reason)}) or pull requests (${errorDetail(prsResult.reason)}) — showing limited summary.`,
    );
  } else if (issuesResult.status === "rejected") {
    summary.notes.push(`Could not fetch issues (${errorDetail(issuesResult.reason)}) — showing PRs only.`);
  } else if (prsResult.status === "rejected") {
    summary.notes.push(`Could not fetch pull requests (${errorDetail(prsResult.reason)}) — showing issues only.`);
  }

  if (userResult.status === "rejected") {
    summary.notes.push(
      `Could not determine GitHub user (${errorDetail(userResult.reason)}) — drive sections, competition counts, and author highlighting are unavailable.`,
    );
  }

  if (voteFetchFailed) {
    summary.notes.push("Could not fetch vote data — vote status unavailable.");
  }

  if (notificationsResult.status === "rejected") {
    summary.notes.push("Could not fetch notifications — unread indicators unavailable.");
  }

  if (issues.length >= fetchLimit) {
    summary.notes.push(`Only the first ${fetchLimit} issues were fetched. Use --fetch-limit to increase.`);
  }
  if (prs.length >= fetchLimit) {
    summary.notes.push(`Only the first ${fetchLimit} PRs were fetched. Use --fetch-limit to increase.`);
  }

  if (options.role) {
    const teamConfig = await loadTeamConfig(repo);
    if (!Object.hasOwn(teamConfig.roles, options.role)) {
      const available = Object.keys(teamConfig.roles).join(", ");
      throw new CliError(
        `Role '${options.role}' not found. Available: ${available}. Run: hivemoot roles`,
        "ROLE_NOT_FOUND",
        1,
      );
    }
    const roleConfig = teamConfig.roles[options.role];

    if (options.json) {
      console.log(jsonBuzz(options.role, roleConfig, summary));
    } else {
      console.log(formatBuzz(options.role, roleConfig, summary, options.limit));
    }
  } else {
    if (options.json) {
      console.log(jsonStatus(summary));
    } else {
      console.log(formatStatus(summary, options.limit));
    }
  }
}
