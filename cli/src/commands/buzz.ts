import {
  CliError,
  type BuzzOptions,
  type GitHubIssue,
  type NotificationRef,
  type RecentClosedItem,
  type RepoRef,
  type TeamConfig,
} from "../config/types.js";
import { loadTeamConfig } from "../config/loader.js";
import { fetchRepoPushAccess, resolveRepo } from "../github/repo.js";
import { runPublishPreflight } from "../github/publish.js";
import { fetchIssues } from "../github/issues.js";
import { fetchPulls } from "../github/pulls.js";
import { fetchCurrentUser } from "../github/user.js";
import { fetchVotes } from "../github/votes.js";
import { fetchNotifications } from "../github/notifications.js";
import type { NotificationMap } from "../github/notifications.js";
import { fetchRecentClosedByAuthor } from "../github/recent.js";
import { buildSummary } from "../summary/builder.js";
import { isVotingIssue, timeAgo } from "../summary/utils.js";
import { formatBuzz, formatStatus } from "../output/formatter.js";
import { jsonBuzz, jsonStatus } from "../output/json.js";
import { loadStateWithStatus, mergeAckJournal } from "../watch/state.js";

function errorDetail(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function normalizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl.trim().toLowerCase().replace(/\.git$/, "");
}

function originTargetsUpstream(originUrl: string, repo: RepoRef): boolean {
  const normalized = normalizeRemoteUrl(originUrl);
  const owner = repo.owner.toLowerCase();
  const name = repo.repo.toLowerCase();
  return (
    normalized.endsWith(`github.com/${owner}/${name}`) ||
    normalized.endsWith(`github.com:${owner}/${name}`)
  );
}

function buildUnackedMentions(
  notifications: NotificationMap,
  processedThreadIds: Set<string>,
  now: Date,
): NotificationRef[] {
  const mentions: NotificationRef[] = [];

  for (const [number, n] of notifications.entries()) {
    if (n.reason !== "mention") continue;

    const ackKey = `${n.threadId}:${n.updatedAt}`;
    if (processedThreadIds.has(ackKey)) continue;

    mentions.push({
      number,
      title: n.title,
      url: n.url,
      itemType: n.itemType,
      threadId: n.threadId,
      reason: n.reason,
      timestamp: n.updatedAt,
      age: timeAgo(n.updatedAt, now),
      ackKey,
      section: "unackedMentions",
    });
  }

  mentions.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? -1 : 1;
    if (a.number !== b.number) return a.number - b.number;
    return a.ackKey.localeCompare(b.ackKey);
  });
  return mentions;
}

export async function buzzCommand(options: BuzzOptions): Promise<void> {
  const repo = await resolveRepo(options.repo);
  const fetchLimit = options.fetchLimit ?? 200;
  const stateFile = options.stateFile ?? ".hivemoot-watch.json";

  const teamConfigPromise = loadTeamConfig(repo);

  let teamConfig: TeamConfig | undefined;
  let teamConfigWarning: string | undefined;
  let stateWarning: string | undefined;

  const processedThreadIdsPromise = loadStateWithStatus(stateFile)
    .then(async (loadResult) => {
      let state = loadResult.state;
      try {
        state = await mergeAckJournal(stateFile, state);
      } catch (err) {
        stateWarning = `Could not merge watch ack journal (${errorDetail(err)}) from ${stateFile}.acks — UNACKED MENTIONS may be incomplete.`;
      }

      if (loadResult.degraded) {
        const reason = loadResult.reason ? `: ${loadResult.reason}` : "";
        stateWarning = `Could not fully load watch state${reason} from ${stateFile} — UNACKED MENTIONS may be incomplete.`;
      }

      return new Set(state.processedThreadIds);
    })
    .catch((err) => {
      stateWarning = `Could not load watch state (${errorDetail(err)}) from ${stateFile} — UNACKED MENTIONS may be incomplete.`;
      return new Set<string>();
    });

  // Fetch summary data in parallel with optional team config loading.
  // Focus is additive and should not delay base status data.
  const [issuesResult, prsResult, userResult, notificationsResult, pushAccessResult, publishPreflightResult] = await Promise.allSettled([
    fetchIssues(repo, fetchLimit),
    fetchPulls(repo, fetchLimit),
    fetchCurrentUser(),
    fetchNotifications(repo),
    fetchRepoPushAccess(repo),
    runPublishPreflight(),
  ]);

  try {
    teamConfig = await teamConfigPromise;
  } catch (err) {
    if (options.role) throw err;
    if (!(err instanceof CliError && err.code === "CONFIG_NOT_FOUND")) {
      teamConfigWarning = `Could not load team config (${errorDetail(err)}) — team focus guidance unavailable.`;
    }
  }

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
  let recentClosedFetchFailed = false;
  let recentlyClosedByYou: RecentClosedItem[] = [];
  try {
    votes = await fetchVotes(repo, votingIssueNumbers, currentUser);
  } catch {
    voteFetchFailed = true;
  }

  if (currentUser) {
    try {
      const now = new Date();
      recentlyClosedByYou = (await fetchRecentClosedByAuthor(repo, currentUser, now)).map((item) => ({
        ...item,
        closedAge: timeAgo(item.closedAt, now),
      }));
    } catch {
      recentClosedFetchFailed = true;
    }
  }

  const summary = buildSummary(
    repo,
    issues,
    prs,
    currentUser,
    new Date(),
    votes,
    notifications,
    teamConfig?.focus,
  );
  const processedThreadIds = await processedThreadIdsPromise;
  summary.unackedMentions = buildUnackedMentions(notifications, processedThreadIds, new Date());
  summary.recentlyClosedByYou = recentlyClosedByYou;

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
  if (recentClosedFetchFailed) {
    summary.notes.push("Could not fetch recently closed authored activity.");
  }

  if (notificationsResult.status === "rejected") {
    summary.notes.push("Could not fetch notifications — unread indicators unavailable.");
  }

  if (teamConfigWarning) {
    summary.notes.push(teamConfigWarning);
  }
  if (stateWarning) {
    summary.notes.push(stateWarning);
  }
  if (pushAccessResult.status === "fulfilled") {
    if (pushAccessResult.value === false) {
      summary.notes.push(
        `No direct push permission detected for you on ${repo.owner}/${repo.repo} — check this repository's docs for the exact contribution flow.`,
      );
    } else if (pushAccessResult.value === undefined) {
      summary.notes.push(
        `Could not determine push permissions for you on ${repo.owner}/${repo.repo} — check this repository's contribution docs for the exact publishing flow.`,
      );
    }
  } else {
    summary.notes.push(
      `Could not check push permissions (${errorDetail(pushAccessResult.reason)}) — check this repository's contribution docs for publishing guidance.`,
    );
  }

  if (publishPreflightResult.status === "fulfilled") {
    const preflight = publishPreflightResult.value;
    if (!preflight.ok) {
      let message: string;
      if (preflight.originUrl && originTargetsUpstream(preflight.originUrl, repo)) {
        message = `Cannot push — origin targets the upstream repo (${repo.owner}/${repo.repo}). Point origin at a repo you have push access to.`;
      } else if (preflight.originUrl) {
        const errorText = (preflight.error ?? "push failed").replace(/\.$/, "");
        message = `Cannot push to origin (${preflight.originUrl}): ${errorText}. Check credentials and push access.`;
      } else {
        message = `Could not verify push access (${preflight.error ?? "unknown error"}). Ensure git is available and origin is configured.`;
      }
      summary.publishReadiness = { canPush: false, message };
    }
  } else {
    summary.publishReadiness = {
      canPush: false,
      message: `Could not verify push access (${errorDetail(publishPreflightResult.reason)}). Ensure git is available and origin is configured.`,
    };
  }

  if (issues.length >= fetchLimit) {
    summary.notes.push(`Only the first ${fetchLimit} issues were fetched. Use --fetch-limit to increase.`);
  }
  if (prs.length >= fetchLimit) {
    summary.notes.push(`Only the first ${fetchLimit} PRs were fetched. Use --fetch-limit to increase.`);
  }

  if (options.role) {
    if (!teamConfig) {
      throw new CliError(
        "No .github/hivemoot.yml found. Run: hivemoot init",
        "CONFIG_NOT_FOUND",
        1,
      );
    }

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
      console.log(jsonBuzz(options.role, roleConfig, summary, teamConfig.onboarding));
    } else {
      console.log(formatBuzz(options.role, roleConfig, summary, options.limit, teamConfig.onboarding));
    }
  } else {
    if (options.json) {
      console.log(jsonStatus(summary));
    } else {
      console.log(formatStatus(summary, options.limit));
    }
  }
}
