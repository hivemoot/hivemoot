/**
 * Colony Standup Module
 *
 * Collects governance data, generates LLM-narrated daily reports,
 * and formats them as Colony Journal comments.
 *
 * Layered reliability:
 * - Layer 0 (always): Snapshot counts, issue/PR lists, metadata tag
 * - Layer 1 (LLM, optional): Narrative summary, key updates, Queen's Take
 */

import { z } from "zod";
import { generateObject } from "ai";

import { LABELS, SIGNATURE, getLabelQueryAliases } from "../config.js";
import {
  createStandupMetadata,
  generateMetadataTag,
} from "./bot-comments.js";
import { repairMalformedJsonText } from "./llm/json-repair.js";
import { createModelFromEnv } from "./llm/provider.js";
import { STANDUP_SYSTEM_PROMPT, buildStandupUserPrompt } from "./llm/prompts.js";
import { withLLMRetry } from "./llm/retry.js";
import { LLM_DEFAULTS } from "./llm/types.js";
import { logger } from "./logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface StandupIssueRef {
  number: number;
  title: string;
}

export interface StandupPRRef {
  number: number;
  title: string;
  author: string;
  linkedIssue?: number;
}

export interface StandupCommitRef {
  sha: string;
  message: string;
  author: string;
}

export interface StandupData {
  // Pipeline (required — fail if unavailable)
  discussionPhase: StandupIssueRef[];
  votingPhase: StandupIssueRef[];
  extendedVoting: StandupIssueRef[];
  readyToImplement: StandupIssueRef[];

  // Implementation (optional — degrade gracefully)
  implementationPRs?: StandupPRRef[];
  mergeReadyPRs?: StandupPRRef[];
  stalePRs?: StandupPRRef[];

  // Activity for the reporting period (optional)
  recentlyMergedPRs?: StandupPRRef[];
  recentlyRejected?: StandupIssueRef[];

  // Direct commits not attributable to any merged PR (optional)
  directCommits?: StandupCommitRef[];

  // Health signals (pre-computed for LLM)
  healthSignals?: string[];

  // Repo-level stats
  openIssueCount?: number;

  // Metadata
  repoFullName: string;
  reportDate: string;
  dayNumber: number;
}

export interface StandupLLMContent {
  narrative: string;
  keyUpdates: string[];
  queensTake: {
    wentWell: string;
    focusAreas: string;
    needsAttention: string;
  };
}

export interface StandupLLMContext {
  installationId?: number;
}

// ───────────────────────────────────────────────────────────────────────────────
// LLM Schema
// ───────────────────────────────────────────────────────────────────────────────

export const StandupOutputSchema = z.object({
  narrative: z.string().min(20).max(500),
  keyUpdates: z.array(z.string().max(200)).min(1).max(10),
  queensTake: z.object({
    wentWell: z.string().min(10).max(400),
    focusAreas: z.string().min(10).max(400),
    needsAttention: z.string().max(400),
  }),
});

// ───────────────────────────────────────────────────────────────────────────────
// Standup Client Interface
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Minimal Octokit interface for standup data collection.
 * Keeps the module testable with simple mocks.
 */
export interface StandupClient {
  rest: {
    issues: {
      listForRepo: (params: {
        owner: string;
        repo: string;
        labels?: string;
        state?: "open" | "closed";
        since?: string;
        per_page?: number;
      }) => Promise<{
        data: Array<{
          number: number;
          title: string;
          pull_request?: unknown;
          closed_at?: string | null;
        }>;
      }>;
    };
    pulls: {
      list: (params: {
        owner: string;
        repo: string;
        state?: "closed" | "open" | "all";
        sort?: "updated" | "created" | "popularity" | "long-running";
        direction?: "desc" | "asc";
        per_page?: number;
      }) => Promise<{
        data: Array<{
          number: number;
          title: string;
          user: { login: string } | null;
          merged_at: string | null;
          labels: Array<{ name: string }>;
        }>;
      }>;
      listCommits: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }) => Promise<{
        data: Array<{
          sha: string;
          commit: { message: string; author: { name?: string } | null };
        }>;
      }>;
    };
    repos: {
      get: (params: {
        owner: string;
        repo: string;
      }) => Promise<{
        data: {
          open_issues_count: number;
        };
      }>;
      listCommits: (params: {
        owner: string;
        repo: string;
        since?: string;
        until?: string;
        per_page?: number;
      }) => Promise<{
        data: Array<{
          sha: string;
          commit: { message: string; author: { name?: string } | null };
          author: { login: string } | Record<string, never> | null;
        }>;
      }>;
    };
  };
}

/**
 * PR operations interface for label-based PR queries.
 */
export interface StandupPROperations {
  findPRsWithLabel: (
    owner: string,
    repo: string,
    label: string
  ) => Promise<Array<{
    number: number;
    createdAt: Date;
    updatedAt: Date;
    labels: Array<{ name: string }>;
  }>>;
}

// ───────────────────────────────────────────────────────────────────────────────
// Data Collection
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Collect all standup data for a repository.
 *
 * Pipeline counts are required — failure throws.
 * All other sections are optional — failures logged and omitted.
 */
export async function collectStandupData(
  octokit: StandupClient,
  prs: StandupPROperations,
  owner: string,
  repo: string,
  reportDate: string,
  dayNumber: number
): Promise<StandupData> {
  const repoFullName = `${owner}/${repo}`;

  // Calendar day boundaries (UTC) for the reporting period
  const dayStart = `${reportDate}T00:00:00Z`;
  const dayEnd = `${reportDate}T23:59:59Z`;

  // ── Required: Pipeline counts ──────────────────────────────────────────
  const [discussionPhase, votingPhase, extendedVoting, readyToImplement] =
    await Promise.all([
      fetchIssuesByLabel(octokit, owner, repo, LABELS.DISCUSSION),
      fetchIssuesByLabel(octokit, owner, repo, LABELS.VOTING),
      fetchIssuesByLabel(octokit, owner, repo, LABELS.EXTENDED_VOTING),
      fetchIssuesByLabel(octokit, owner, repo, LABELS.READY_TO_IMPLEMENT),
    ]);

  const data: StandupData = {
    discussionPhase,
    votingPhase,
    extendedVoting,
    readyToImplement,
    repoFullName,
    reportDate,
    dayNumber,
  };

  // ── Optional: Total open issue count ─────────────────────────────────
  try {
    const repoData = await octokit.rest.repos.get({ owner, repo });
    data.openIssueCount = repoData.data.open_issues_count;
  } catch (error) {
    logger.warn(`[${repoFullName}] Failed to fetch repo info: ${(error as Error).message}`);
  }

  // ── Optional: Implementation PRs ──────────────────────────────────────
  // Fetch open PR details once (shared across all enrichment calls)
  const prDetailsMap = await fetchOpenPRDetails(octokit, owner, repo);

  // GitHub's open_issues_count includes PRs; subtract known open PRs
  if (data.openIssueCount !== undefined) {
    data.openIssueCount -= prDetailsMap.size;
  }

  try {
    const implPRs = await prs.findPRsWithLabel(owner, repo, LABELS.IMPLEMENTATION);
    data.implementationPRs = enrichPRRefs(implPRs, prDetailsMap);
  } catch (error) {
    logger.warn(`[${repoFullName}] Failed to fetch implementation PRs: ${(error as Error).message}`);
  }

  try {
    const mrPRs = await prs.findPRsWithLabel(owner, repo, LABELS.MERGE_READY);
    data.mergeReadyPRs = enrichPRRefs(mrPRs, prDetailsMap);
  } catch (error) {
    logger.warn(`[${repoFullName}] Failed to fetch merge-ready PRs: ${(error as Error).message}`);
  }

  try {
    const stalePRsRaw = await prs.findPRsWithLabel(owner, repo, LABELS.STALE);
    data.stalePRs = enrichPRRefs(stalePRsRaw, prDetailsMap);
  } catch (error) {
    logger.warn(`[${repoFullName}] Failed to fetch stale PRs: ${(error as Error).message}`);
  }

  // ── Optional: Recently merged PRs ─────────────────────────────────────
  try {
    const mergedPRs = await fetchRecentlyMergedPRs(octokit, owner, repo, dayStart, dayEnd);
    data.recentlyMergedPRs = mergedPRs;

    // Commit grouping: for each merged PR, fetch its commits
    if (mergedPRs.length > 0) {
      try {
        data.directCommits = await fetchDirectCommits(
          octokit, owner, repo, mergedPRs, dayStart, dayEnd
        );
      } catch (error) {
        logger.warn(`[${repoFullName}] Failed to group commits: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    logger.warn(`[${repoFullName}] Failed to fetch merged PRs: ${(error as Error).message}`);
  }

  // ── Optional: Recently rejected issues ────────────────────────────────
  try {
    data.recentlyRejected = await fetchRecentlyRejected(octokit, owner, repo, dayStart, dayEnd);
  } catch (error) {
    logger.warn(`[${repoFullName}] Failed to fetch rejected issues: ${(error as Error).message}`);
  }

  // ── Health signals ────────────────────────────────────────────────────
  data.healthSignals = computeHealthSignals(data);

  return data;
}

async function fetchIssuesByLabel(
  octokit: StandupClient,
  owner: string,
  repo: string,
  label: string
): Promise<StandupIssueRef[]> {
  const seen = new Set<number>();
  const issues: StandupIssueRef[] = [];

  // Query each alias (canonical + legacy) to catch both old and new labels
  for (const alias of getLabelQueryAliases(label)) {
    const response = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      labels: alias,
      state: "open",
      per_page: 100,
    });

    for (const issue of response.data) {
      if (!issue.pull_request && !seen.has(issue.number)) {
        seen.add(issue.number);
        issues.push({ number: issue.number, title: issue.title });
      }
    }
  }

  return issues;
}

/**
 * Fetch open PR details (title, author) once for shared enrichment.
 * Returns an empty map on failure so callers degrade gracefully.
 */
async function fetchOpenPRDetails(
  octokit: StandupClient,
  owner: string,
  repo: string
): Promise<Map<number, { title: string; author: string }>> {
  try {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: 100,
    });

    const map = new Map<number, { title: string; author: string }>();
    for (const pr of response.data) {
      map.set(pr.number, {
        title: pr.title,
        author: pr.user?.login ?? "ghost",
      });
    }
    return map;
  } catch (error) {
    logger.warn(`Failed to fetch open PR details for ${owner}/${repo}: ${(error as Error).message}`);
    return new Map();
  }
}

/**
 * Build StandupPRRef[] from label-matched PRs, enriching with details
 * from the shared PR details map. PRs not in the map get a placeholder
 * title ("PR #N") and author ("unknown").
 */
function enrichPRRefs(
  rawPRs: Array<{ number: number }>,
  prDetailsMap: Map<number, { title: string; author: string }>
): StandupPRRef[] {
  return rawPRs.map((pr) => {
    const details = prDetailsMap.get(pr.number);
    return {
      number: pr.number,
      title: details?.title ?? `PR #${pr.number}`,
      author: details?.author ?? "unknown",
    };
  });
}

async function fetchRecentlyMergedPRs(
  octokit: StandupClient,
  owner: string,
  repo: string,
  dayStart: string,
  dayEnd: string
): Promise<StandupPRRef[]> {
  const response = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  return response.data
    .filter((pr) => {
      if (!pr.merged_at) return false;
      return pr.merged_at >= dayStart && pr.merged_at <= dayEnd;
    })
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "ghost",
    }));
}

async function fetchRecentlyRejected(
  octokit: StandupClient,
  owner: string,
  repo: string,
  dayStart: string,
  dayEnd: string
): Promise<StandupIssueRef[]> {
  // GitHub's `since` filters by updated_at, not closed_at.
  // We post-filter by closed_at to get only issues actually closed in the reporting window.
  const response = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    labels: LABELS.REJECTED,
    state: "closed",
    since: dayStart,
    per_page: 50,
  });

  return response.data
    .filter((issue) => {
      if (issue.pull_request) return false;
      if (!issue.closed_at) return false;
      return issue.closed_at >= dayStart && issue.closed_at <= dayEnd;
    })
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
    }));
}

/**
 * Find commits pushed directly to the default branch (not via a merged PR).
 * Fetches per-PR commit SHAs to exclude them, then returns the remainder.
 */
async function fetchDirectCommits(
  octokit: StandupClient,
  owner: string,
  repo: string,
  mergedPRs: StandupPRRef[],
  dayStart: string,
  dayEnd: string
): Promise<StandupCommitRef[]> {
  // Collect all commit SHAs from merged PRs
  const prCommitSHAs = new Set<string>();

  for (const pr of mergedPRs) {
    try {
      const response = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });

      for (const c of response.data) {
        prCommitSHAs.add(c.sha);
      }
    } catch (error) {
      logger.debug(`Failed to fetch commits for PR #${pr.number}: ${(error as Error).message}`);
    }
  }

  // Fetch default branch commits for the calendar day
  const branchCommitsResponse = await octokit.rest.repos.listCommits({
    owner,
    repo,
    since: dayStart,
    until: dayEnd,
    per_page: 100,
  });

  // Build a set of merged PR numbers for squash/rebase detection
  const mergedPRNumbers = new Set(mergedPRs.map((pr) => pr.number));

  // Direct pushes: commits on default branch not attributable to any merged PR.
  // Filters by SHA match (regular merge) and by PR number in commit message
  // (squash/rebase merges, where GitHub appends "(#N)" to the message).
  return branchCommitsResponse.data
    .filter((c) => {
      if (prCommitSHAs.has(c.sha)) return false;
      const msg = c.commit.message.split("\n")[0];
      const prRefMatch = msg.match(/\(#(\d+)\)\s*$/);
      if (prRefMatch && mergedPRNumbers.has(parseInt(prRefMatch[1], 10))) return false;
      return true;
    })
    .map((c) => ({
      sha: c.sha.substring(0, 7),
      message: c.commit.message.split("\n")[0],
      author: (c.author && "login" in c.author ? c.author.login : null) ?? c.commit.author?.name ?? "unknown",
    }));
}

// ───────────────────────────────────────────────────────────────────────────────
// Health Signals
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Pre-compute health signals from standup data.
 * These are injected into the LLM prompt so it doesn't need to compute them.
 */
export function computeHealthSignals(data: StandupData): string[] {
  const signals: string[] = [];

  // Merge-ready but unmerged
  if (data.mergeReadyPRs && data.mergeReadyPRs.length > 0) {
    const numbers = data.mergeReadyPRs.map((p) => `#${p.number}`).join(", ");
    signals.push(
      `${data.mergeReadyPRs.length} PR(s) are merge-ready but unmerged: ${numbers}`
    );
  }

  // Stale PRs approaching auto-close
  if (data.stalePRs && data.stalePRs.length > 0) {
    const numbers = data.stalePRs.map((p) => `#${p.number}`).join(", ");
    signals.push(
      `${data.stalePRs.length} stale PR(s) approaching auto-close: ${numbers}`
    );
  }

  // Ready-to-implement backlog
  if (data.readyToImplement.length > 5) {
    signals.push(
      `Large ready-to-implement backlog: ${data.readyToImplement.length} issues waiting for PRs`
    );
  }

  // No implementation PRs for ready issues
  if (data.readyToImplement.length > 0 && (!data.implementationPRs || data.implementationPRs.length === 0)) {
    signals.push(
      `${data.readyToImplement.length} issues are ready to implement but no active implementation PRs exist`
    );
  }

  return signals;
}

// ───────────────────────────────────────────────────────────────────────────────
// Content Check
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Determine if the standup has meaningful content beyond just pipeline counts.
 * Used to decide between full format and quiet-day format.
 */
export function hasAnyContent(data: StandupData): boolean {
  // Pipeline counts themselves count as content
  const pipelineTotal =
    data.discussionPhase.length +
    data.votingPhase.length +
    data.extendedVoting.length +
    data.readyToImplement.length;

  if (pipelineTotal > 0) return true;

  // Activity counts
  if (data.implementationPRs && data.implementationPRs.length > 0) return true;
  if (data.mergeReadyPRs && data.mergeReadyPRs.length > 0) return true;
  if (data.stalePRs && data.stalePRs.length > 0) return true;
  if (data.recentlyMergedPRs && data.recentlyMergedPRs.length > 0) return true;
  if (data.recentlyRejected && data.recentlyRejected.length > 0) return true;
  if (data.directCommits && data.directCommits.length > 0) return true;

  return false;
}

/** One-line summary of open issue count and PRs in flight. */
function formatCurrentState(data: StandupData): string {
  const openIssues = data.openIssueCount ?? "?";
  const prsInFlight = (data.implementationPRs?.length ?? 0) + (data.mergeReadyPRs?.length ?? 0);

  return `**Current state:** ${openIssues} open issues · ${prsInFlight} PRs in flight`;
}

// ───────────────────────────────────────────────────────────────────────────────
// LLM Integration
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Collect all valid issue/PR numbers from standup data.
 * Used to validate LLM output references.
 */
function collectValidNumbers(data: StandupData): Set<number> {
  const numbers = new Set<number>();

  for (const issue of data.discussionPhase) numbers.add(issue.number);
  for (const issue of data.votingPhase) numbers.add(issue.number);
  for (const issue of data.extendedVoting) numbers.add(issue.number);
  for (const issue of data.readyToImplement) numbers.add(issue.number);

  if (data.implementationPRs) {
    for (const pr of data.implementationPRs) numbers.add(pr.number);
  }
  if (data.mergeReadyPRs) {
    for (const pr of data.mergeReadyPRs) numbers.add(pr.number);
  }
  if (data.stalePRs) {
    for (const pr of data.stalePRs) numbers.add(pr.number);
  }
  if (data.recentlyMergedPRs) {
    for (const pr of data.recentlyMergedPRs) numbers.add(pr.number);
  }
  if (data.recentlyRejected) {
    for (const issue of data.recentlyRejected) numbers.add(issue.number);
  }

  return numbers;
}

/**
 * Validate and sanitize LLM references to issue/PR numbers.
 * Replaces hallucinated #NNN references with "[ref removed]".
 * Returns null if >50% of references are hallucinated.
 */
export function validateLLMReferences(
  text: string,
  validNumbers: Set<number>
): string | null {
  const refPattern = /#(\d+)/g;
  let totalRefs = 0;
  let invalidRefs = 0;

  // Count references
  const matches = [...text.matchAll(refPattern)];
  totalRefs = matches.length;

  if (totalRefs === 0) return text;

  for (const match of matches) {
    const num = parseInt(match[1], 10);
    if (!validNumbers.has(num)) {
      invalidRefs++;
    }
  }

  // If >50% hallucinated, reject the entire output
  if (invalidRefs / totalRefs > 0.5) {
    return null;
  }

  // Replace invalid references
  return text.replace(refPattern, (match, numStr: string) => {
    const num = parseInt(numStr, 10);
    return validNumbers.has(num) ? match : "[ref removed]";
  });
}

/**
 * Validate all string fields in the LLM output.
 * Returns the sanitized output, or null if too many hallucinations.
 */
function validateLLMOutput(
  output: z.infer<typeof StandupOutputSchema>,
  validNumbers: Set<number>
): StandupLLMContent | null {
  const narrative = validateLLMReferences(output.narrative, validNumbers);
  if (narrative === null) {
    logger.warn("LLM narrative rejected: >50% hallucinated references");
    return null;
  }

  const keyUpdates: string[] = [];
  for (const update of output.keyUpdates) {
    const validated = validateLLMReferences(update, validNumbers);
    if (validated === null) {
      logger.warn("LLM key update rejected: >50% hallucinated references");
      return null;
    }
    keyUpdates.push(validated);
  }

  const wentWell = validateLLMReferences(output.queensTake.wentWell, validNumbers);
  const focusAreas = validateLLMReferences(output.queensTake.focusAreas, validNumbers);
  const needsAttention = validateLLMReferences(output.queensTake.needsAttention, validNumbers);

  if (wentWell === null || focusAreas === null || needsAttention === null) {
    logger.warn("LLM Queen's Take rejected: >50% hallucinated references");
    return null;
  }

  return {
    narrative,
    keyUpdates,
    queensTake: { wentWell, focusAreas, needsAttention },
  };
}

/**
 * Generate LLM content for the standup report.
 * Returns null if LLM is not configured or fails.
 */
export async function generateStandupLLMContent(
  data: StandupData,
  llmContext?: StandupLLMContext
): Promise<StandupLLMContent | null> {
  try {
    const modelResult = await createModelFromEnv(
      llmContext?.installationId !== undefined
        ? { installationId: llmContext.installationId }
        : undefined
    );
    if (!modelResult) {
      logger.debug("LLM not configured, skipping standup narration");
      return null;
    }

    const { model, config } = modelResult;
    logger.info(`Generating standup narrative with ${config.provider}/${config.model}`);

    const result = await withLLMRetry(
      () =>
        generateObject({
          model,
          schema: StandupOutputSchema,
          system: STANDUP_SYSTEM_PROMPT,
          prompt: buildStandupUserPrompt(data),
          experimental_repairText: async (args) => {
            const repaired = await repairMalformedJsonText(args);
            if (repaired !== null) {
              logger.info(`Repaired malformed LLM JSON output (error: ${args.error.message})`);
            }
            return repaired;
          },
          maxOutputTokens: config.maxTokens,
          temperature: 0.4,
          maxRetries: 0, // Disable SDK retry; our wrapper handles rate-limits
          abortSignal: AbortSignal.timeout(LLM_DEFAULTS.perCallTimeoutMs),
        }),
      undefined,
      logger
    );

    const validNumbers = collectValidNumbers(data);
    const validated = validateLLMOutput(result.object, validNumbers);

    if (!validated) {
      logger.warn("LLM output failed reference validation, falling back to template");
      return null;
    }

    logger.info("Standup narrative generated and validated successfully");
    return validated;
  } catch (error) {
    // LLM is Layer 1 (optional) — degrade gracefully to template-only.
    // BYOK infrastructure failures are logged at error for operator visibility.
    const message = error instanceof Error ? error.message : String(error);
    const isByokRuntime = message.startsWith("BYOK ");
    logger[isByokRuntime ? "error" : "warn"](`LLM standup generation failed: ${message}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Formatting
// ───────────────────────────────────────────────────────────────────────────────

/** GitHub comment body limit */
const MAX_COMMENT_LENGTH = 60_000;
const MAX_MERGED_LIST_ITEMS = 8;

/**
 * Format the date for display (e.g., "Friday, Feb 7, 2026").
 */
function formatDisplayDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Build a GitHub search URL for merged PRs on a specific UTC date.
 */
function buildMergedPRSearchUrl(repoFullName: string, reportDate: string): string {
  const query = `is:pr is:merged merged:${reportDate}..${reportDate}`;
  return `https://github.com/${repoFullName}/pulls?q=${encodeURIComponent(query)}`;
}

/**
 * Format the standup comment body.
 * Applies Layer 0 (always) + Layer 1 (LLM, if available).
 * Enforces 60K char cap with progressive truncation.
 */
export function formatStandupComment(
  data: StandupData,
  llmContent?: StandupLLMContent | null
): string {
  const metadata = createStandupMetadata(data.dayNumber, data.reportDate, data.repoFullName);
  const metadataTag = generateMetadataTag(metadata);
  const displayDate = formatDisplayDate(data.reportDate);

  // Quiet day format
  if (!hasAnyContent(data)) {
    return [
      metadataTag,
      "",
      `# 🐝 Colony Report — Day ${data.dayNumber}`,
      `**${displayDate}**`,
      "",
      "The colony rests. No governance activity yesterday.",
      "",
      formatCurrentState(data),
      SIGNATURE,
    ].join("\n");
  }

  // Full format — build sections in priority order
  const sections: string[] = [];

  // Header
  sections.push(metadataTag);
  sections.push("");
  sections.push(`# 🐝 Colony Report — Day ${data.dayNumber}`);
  sections.push("");
  sections.push(`**${displayDate}** · Reporting on ${data.reportDate} activity`);
  sections.push("");

  // LLM narrative (Layer 1) — editorial voice comes first
  if (llmContent) {
    sections.push(`> ${llmContent.narrative}`);
    sections.push("");

    // Queen's Take
    sections.push("## Queen's Take");
    sections.push("");
    sections.push(`**What went well:** ${llmContent.queensTake.wentWell}`);
    sections.push("");
    sections.push(`**Focus areas:** ${llmContent.queensTake.focusAreas}`);
    sections.push("");
    if (llmContent.queensTake.needsAttention.length > 0) {
      sections.push(`**Needs addressing:** ${llmContent.queensTake.needsAttention}`);
      sections.push("");
    }
  }

  sections.push(formatCurrentState(data));
  sections.push("");

  // Implementation Activity table
  const allPRs = [
    ...(data.implementationPRs ?? []),
    ...(data.mergeReadyPRs ?? []).filter(
      (mr) => !data.implementationPRs?.some((ip) => ip.number === mr.number)
    ),
  ];

  if (allPRs.length > 0) {
    sections.push("## Implementation Activity");
    sections.push("");
    sections.push("| PR | Author | Status |");
    sections.push("|----|--------|--------|");
    for (const pr of allPRs) {
      const isMergeReady = data.mergeReadyPRs?.some((mr) => mr.number === pr.number);
      const isStale = data.stalePRs?.some((s) => s.number === pr.number);
      const status = isMergeReady ? "✅ Merge-ready" : isStale ? "⏰ Stale" : "🔨 Active";
      const safeTitle = pr.title.replace(/\|/g, "\\|");
      sections.push(`| #${pr.number} ${safeTitle} | @${pr.author} | ${status} |`);
    }
    sections.push("");
  }

  // Merged PRs (heading omits "Today" — report date is already in the header)
  if (data.recentlyMergedPRs && data.recentlyMergedPRs.length > 0) {
    sections.push("## Merged");
    sections.push("");
    if (data.recentlyMergedPRs.length > MAX_MERGED_LIST_ITEMS) {
      const searchUrl = buildMergedPRSearchUrl(data.repoFullName, data.reportDate);
      sections.push(`- **${data.recentlyMergedPRs.length} PRs merged**`);
      sections.push(`- [View all merged PRs for ${data.reportDate}](${searchUrl})`);
    } else {
      for (const pr of data.recentlyMergedPRs) {
        sections.push(`- **#${pr.number}** ${pr.title} (by @${pr.author})`);
      }
    }
    sections.push("");
  }

  // Direct pushes
  if (data.directCommits && data.directCommits.length > 0) {
    sections.push("**Direct pushes:**");
    for (const commit of data.directCommits.slice(0, 10)) {
      sections.push(`- \`${commit.sha}\` ${commit.message} (@${commit.author})`);
    }
    if (data.directCommits.length > 10) {
      sections.push(`- *...and ${data.directCommits.length - 10} more*`);
    }
    sections.push("");
  }

  // Rejected
  if (data.recentlyRejected && data.recentlyRejected.length > 0) {
    sections.push("## Rejected");
    sections.push("");
    for (const issue of data.recentlyRejected) {
      sections.push(`- #${issue.number} ${issue.title}`);
    }
    sections.push("");
  }

  // Signature — hardcoded here rather than using SIGNATURE constant because
  // SIGNATURE has leading \n\n which produces extra blank lines when joined
  sections.push("---");
  sections.push("buzz buzz 🐝 Hivemoot Queen");

  let result = sections.join("\n");

  // Enforce char cap with progressive truncation
  if (result.length > MAX_COMMENT_LENGTH) {
    result = truncateStandup(sections, metadataTag, data, MAX_COMMENT_LENGTH);
  }

  return result;
}

/**
 * Progressive truncation: drop lowest-priority sections first.
 * Priority (highest to lowest): metadata, header, snapshot, LLM, activity table, merged, commits, rejected
 */
function truncateStandup(
  _sections: string[],
  metadataTag: string,
  data: StandupData,
  maxLength: number
): string {
  // Rebuild with just the essential sections
  const displayDate = formatDisplayDate(data.reportDate);

  const essential = [
    metadataTag,
    "",
    `# 🐝 Colony Report — Day ${data.dayNumber}`,
    "",
    `**${displayDate}** · Reporting on ${data.reportDate} activity`,
    "",
    formatCurrentState(data),
    "",
    "*(truncated — busy day)*",
    "---",
    "buzz buzz 🐝 Hivemoot Queen",
  ];

  const result = essential.join("\n");
  if (result.length > maxLength) {
    return result.substring(0, maxLength - 50) + "\n\n*(truncated)*";
  }
  return result;
}
