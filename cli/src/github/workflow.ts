import { CliError, type RepoRef } from "../config/types.js";
import { hasGovernanceLabelName } from "../summary/utils.js";
import { gh } from "./client.js";

export type PreflightBlockerCode =
  | "no_linked_issue"
  | "linked_issue_not_ready"
  | "merge_conflict"
  | "required_checks_failing";

export type WorkflowWarningCode =
  | PreflightBlockerCode
  | "required_checks_pending"
  | "mergeability_unknown";

export interface WorkflowSignal {
  code: PreflightBlockerCode | WorkflowWarningCode;
  message: string;
}

type WorkflowCheckBucket = "pass" | "fail" | "pending";

export interface WorkflowCheck {
  name: string;
  type: "check_run" | "status_context";
  required: boolean;
  bucket: WorkflowCheckBucket;
  status: string | null;
  conclusion: string | null;
}

export interface WorkflowIssueRef {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  isReadyToImplement: boolean;
}

export interface PullRequestSnapshotResult {
  schemaVersion: 1;
  kind: "pr_snapshot";
  generatedAt: string;
  repo: RepoRef;
  pr: {
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    mergeable: string | null;
    reviewDecision: string | null;
    createdAt: string;
    updatedAt: string;
    headRefName: string;
    baseRefName: string;
    author: string | null;
  };
  linkedIssues: WorkflowIssueRef[];
  checks: {
    required: WorkflowCheck[];
    all: WorkflowCheck[];
    requiredFailing: WorkflowCheck[];
    requiredPending: WorkflowCheck[];
  };
  warnings: WorkflowSignal[];
}

export interface PullRequestPreflightResult {
  schemaVersion: 1;
  kind: "pr_preflight";
  generatedAt: string;
  repo: RepoRef;
  pr: PullRequestSnapshotResult["pr"];
  linkedIssues: WorkflowIssueRef[];
  checks: PullRequestSnapshotResult["checks"];
  blockers: WorkflowSignal[];
  warnings: WorkflowSignal[];
  pass: boolean;
}

export type VoteChoice = "support" | "oppose" | "needs-discussion" | "needs-human";

export const ISSUE_VOTE_CHOICES: VoteChoice[] = [
  "support",
  "oppose",
  "needs-discussion",
  "needs-human",
];

interface VoteChoiceSpec {
  reaction: string;
  restContent: string;
}

const VOTE_CHOICE_SPEC: Record<VoteChoice, VoteChoiceSpec> = {
  support: { reaction: "👍", restContent: "+1" },
  oppose: { reaction: "👎", restContent: "-1" },
  "needs-discussion": { reaction: "😕", restContent: "confused" },
  "needs-human": { reaction: "👀", restContent: "eyes" },
};

export interface IssueVoteResult {
  schemaVersion: 1;
  kind: "issue_vote";
  generatedAt: string;
  repo: RepoRef;
  issue: {
    number: number;
    title: string;
    url: string;
    state: string;
    labels: string[];
  };
  targetComment: {
    id: string;
    databaseId: number;
    url: string;
    author: string | null;
    createdAt: string;
  };
  vote: {
    choice: VoteChoice;
    reaction: string;
    content: string;
  };
}

const PR_WORKFLOW_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      isDraft
      mergeable
      reviewDecision
      createdAt
      updatedAt
      headRefName
      baseRefName
      author { login }
      closingIssuesReferences(first: 20) {
        nodes {
          number
          title
          url
          state
          labels(first: 20) {
            nodes { name }
          }
        }
      }
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun {
              name
              status
              conclusion
              isRequired(pullRequestNumber: $number)
            }
            ... on StatusContext {
              context
              state
              isRequired(pullRequestNumber: $number)
            }
          }
        }
      }
    }
  }
}
`;

const ISSUE_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $commentsCursor: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number
      title
      url
      state
      labels(first: 50) {
        nodes { name }
      }
      comments(last: 100, before: $commentsCursor) {
        pageInfo {
          hasPreviousPage
          startCursor
        }
        nodes {
          id
          databaseId
          url
          body
          createdAt
          author { login }
        }
      }
    }
  }
}
`;

const METADATA_RE = /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/;

interface PullRequestWorkflowQueryResponse {
  data?: {
    repository?: {
      pullRequest?: {
        number: number;
        title: string;
        url: string;
        state: string;
        isDraft: boolean;
        mergeable: string | null;
        reviewDecision: string | null;
        createdAt: string;
        updatedAt: string;
        headRefName: string;
        baseRefName: string;
        author: { login: string } | null;
        closingIssuesReferences: {
          nodes: Array<{
            number: number;
            title: string;
            url: string;
            state: string;
            labels: {
              nodes: Array<{ name: string }>;
            };
          }>;
        };
        statusCheckRollup: {
          contexts: {
            nodes: Array<{
              __typename: string;
              name?: string;
              context?: string;
              status?: string;
              state?: string;
              conclusion?: string | null;
              isRequired?: boolean;
            }>;
          };
        } | null;
      } | null;
    };
  };
}

interface IssuePageQueryResponse {
  data?: {
    repository?: {
      issue?: {
        number: number;
        title: string;
        url: string;
        state: string;
        labels: {
          nodes: Array<{ name: string }>;
        };
        comments: {
          pageInfo?: {
            hasPreviousPage?: boolean;
            startCursor?: string | null;
          };
          nodes: Array<{
            id: string;
            databaseId: number;
            url: string;
            body: string;
            createdAt: string;
            author: { login: string } | null;
          }>;
        };
      } | null;
    };
  };
}

function parseJSON<T>(raw: string, message: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(message, "GH_ERROR", 1);
  }
}

async function resolvePullRequestNumber(repo: RepoRef, prRef: string): Promise<number> {
  const raw = await gh([
    "pr",
    "view",
    prRef,
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--json",
    "number",
  ]);

  const parsed = parseJSON<{ number?: number }>(
    raw,
    "Failed to parse pull request reference from gh CLI response.",
  );
  if (typeof parsed.number !== "number") {
    throw new CliError(
      `Could not resolve pull request reference "${prRef}" in ${repo.owner}/${repo.repo}.`,
      "GH_ERROR",
      1,
    );
  }
  return parsed.number;
}

async function resolveIssueNumber(repo: RepoRef, issueRef: string): Promise<number> {
  const raw = await gh([
    "issue",
    "view",
    issueRef,
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--json",
    "number",
  ]);

  const parsed = parseJSON<{ number?: number }>(
    raw,
    "Failed to parse issue reference from gh CLI response.",
  );
  if (typeof parsed.number !== "number") {
    throw new CliError(
      `Could not resolve issue reference "${issueRef}" in ${repo.owner}/${repo.repo}.`,
      "GH_ERROR",
      1,
    );
  }
  return parsed.number;
}

function checkRunBucket(
  status: string | undefined,
  conclusion: string | null | undefined,
): WorkflowCheckBucket {
  const normalizedStatus = status?.toUpperCase();
  if (normalizedStatus !== "COMPLETED") return "pending";

  const normalizedConclusion = conclusion?.toUpperCase() ?? null;
  if (!normalizedConclusion) return "pending";

  if (normalizedConclusion === "SUCCESS" || normalizedConclusion === "NEUTRAL" || normalizedConclusion === "SKIPPED") {
    return "pass";
  }

  if (
    normalizedConclusion === "FAILURE" ||
    normalizedConclusion === "ACTION_REQUIRED" ||
    normalizedConclusion === "CANCELLED" ||
    normalizedConclusion === "TIMED_OUT" ||
    normalizedConclusion === "STARTUP_FAILURE" ||
    normalizedConclusion === "STALE"
  ) {
    return "fail";
  }

  return "pending";
}

function statusContextBucket(state: string | undefined): WorkflowCheckBucket {
  const normalizedState = state?.toUpperCase();
  if (normalizedState === "SUCCESS") return "pass";
  if (normalizedState === "FAILURE" || normalizedState === "ERROR") return "fail";
  return "pending";
}

function mapCheckNode(node: {
  __typename: string;
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string | null;
  isRequired?: boolean;
}): WorkflowCheck | null {
  if (node.__typename === "CheckRun") {
    if (!node.name) return null;
    return {
      name: node.name,
      type: "check_run",
      required: node.isRequired === true,
      bucket: checkRunBucket(node.status, node.conclusion),
      status: node.status ?? null,
      conclusion: node.conclusion ?? null,
    };
  }

  if (node.__typename === "StatusContext") {
    if (!node.context) return null;
    return {
      name: node.context,
      type: "status_context",
      required: node.isRequired === true,
      bucket: statusContextBucket(node.state),
      status: node.state ?? null,
      conclusion: null,
    };
  }

  return null;
}

function isReadyIssue(labels: string[]): boolean {
  return hasGovernanceLabelName(labels, "READY_TO_IMPLEMENT");
}

function warning(code: WorkflowWarningCode, message: string): WorkflowSignal {
  return { code, message };
}

function blocker(code: PreflightBlockerCode, message: string): WorkflowSignal {
  return { code, message };
}

function buildSnapshotWarnings(
  linkedIssues: WorkflowIssueRef[],
  mergeable: string | null,
  requiredPending: WorkflowCheck[],
): WorkflowSignal[] {
  const warnings: WorkflowSignal[] = [];

  if (linkedIssues.length === 0) {
    warnings.push(
      warning(
        "no_linked_issue",
        "Pull request has no linked issue via closing keyword.",
      ),
    );
  } else if (!linkedIssues.some((issue) => issue.isReadyToImplement)) {
    warnings.push(
      warning(
        "linked_issue_not_ready",
        "Linked issues were found, but none are labeled ready-to-implement.",
      ),
    );
  }

  if (mergeable !== "MERGEABLE" && mergeable !== "CONFLICTING") {
    warnings.push(
      warning(
        "mergeability_unknown",
        `Mergeability is currently ${mergeable ?? "UNKNOWN"}.`,
      ),
    );
  }

  if (requiredPending.length > 0) {
    const names = requiredPending.map((check) => check.name).join(", ");
    warnings.push(
      warning(
        "required_checks_pending",
        `Required checks are still pending: ${names}.`,
      ),
    );
  }

  return warnings;
}

async function fetchPullRequestWorkflow(
  repo: RepoRef,
  prNumber: number,
): Promise<NonNullable<NonNullable<NonNullable<PullRequestWorkflowQueryResponse["data"]>["repository"]>["pullRequest"]>> {
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${PR_WORKFLOW_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.repo}`,
    "-F",
    `number=${prNumber}`,
  ]);

  const parsed = parseJSON<PullRequestWorkflowQueryResponse>(
    raw,
    "Failed to parse pull request workflow response from gh CLI.",
  );

  const pr = parsed.data?.repository?.pullRequest;
  if (!pr) {
    throw new CliError(
      `Pull request #${prNumber} was not found in ${repo.owner}/${repo.repo}.`,
      "GH_ERROR",
      1,
    );
  }
  return pr;
}

function parseMetadataType(body: string): string | null {
  const match = body.match(METADATA_RE);
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[1]);
    return typeof metadata.type === "string" ? metadata.type : null;
  } catch {
    return null;
  }
}

function isVotingMetadataComment(body: string): boolean {
  return parseMetadataType(body) === "voting";
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export async function buildPrSnapshot(
  repo: RepoRef,
  prRef: string,
  generatedAt = new Date().toISOString(),
): Promise<PullRequestSnapshotResult> {
  const prNumber = await resolvePullRequestNumber(repo, prRef);
  const pr = await fetchPullRequestWorkflow(repo, prNumber);

  const linkedIssues: WorkflowIssueRef[] = (pr.closingIssuesReferences.nodes ?? []).map((issue) => {
    const labels = (issue.labels.nodes ?? []).map((label) => label.name);
    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      labels,
      isReadyToImplement: isReadyIssue(labels),
    };
  });

  const allChecks = (pr.statusCheckRollup?.contexts.nodes ?? [])
    .map((node) => mapCheckNode(node))
    .filter((node): node is WorkflowCheck => node !== null);

  const required = allChecks.filter((check) => check.required);
  const requiredFailing = required.filter((check) => check.bucket === "fail");
  const requiredPending = required.filter((check) => check.bucket === "pending");

  return {
    schemaVersion: 1,
    kind: "pr_snapshot",
    generatedAt,
    repo,
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      reviewDecision: pr.reviewDecision,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      author: pr.author?.login ?? null,
    },
    linkedIssues,
    checks: {
      required,
      all: allChecks,
      requiredFailing,
      requiredPending,
    },
    warnings: buildSnapshotWarnings(linkedIssues, pr.mergeable, requiredPending),
  };
}

export async function buildPrPreflight(
  repo: RepoRef,
  prRef: string,
  generatedAt = new Date().toISOString(),
): Promise<PullRequestPreflightResult> {
  const snapshot = await buildPrSnapshot(repo, prRef, generatedAt);
  const blockers: WorkflowSignal[] = [];

  if (snapshot.linkedIssues.length === 0) {
    blockers.push(
      blocker("no_linked_issue", "Pull request must link an approved issue via closing keyword."),
    );
  } else if (!snapshot.linkedIssues.some((issue) => issue.isReadyToImplement)) {
    const linked = snapshot.linkedIssues.map((issue) => `#${issue.number}`).join(", ");
    blockers.push(
      blocker(
        "linked_issue_not_ready",
        `Linked issue(s) are not ready-to-implement: ${linked}.`,
      ),
    );
  }

  if (snapshot.pr.mergeable === "CONFLICTING") {
    blockers.push(
      blocker("merge_conflict", "Pull request currently has merge conflicts."),
    );
  }

  if (snapshot.checks.requiredFailing.length > 0) {
    const names = snapshot.checks.requiredFailing.map((check) => check.name).join(", ");
    blockers.push(
      blocker(
        "required_checks_failing",
        `Required checks are failing: ${names}.`,
      ),
    );
  }

  const warnings = snapshot.warnings.filter(
    (item) => !blockers.some((existing) => existing.code === item.code),
  );

  if (
    snapshot.linkedIssues.length > 0 &&
    snapshot.linkedIssues.some((issue) => issue.isReadyToImplement) &&
    snapshot.linkedIssues.some((issue) => !issue.isReadyToImplement)
  ) {
    warnings.push(
      warning(
        "linked_issue_not_ready",
        "Some linked issues are not ready-to-implement; using a ready issue link is recommended.",
      ),
    );
  }

  return {
    schemaVersion: 1,
    kind: "pr_preflight",
    generatedAt,
    repo,
    pr: snapshot.pr,
    linkedIssues: snapshot.linkedIssues,
    checks: snapshot.checks,
    blockers,
    warnings,
    pass: blockers.length === 0,
  };
}

async function fetchIssuePage(
  repo: RepoRef,
  issueNumber: number,
  commentsCursor: string | null,
): Promise<IssuePageQueryResponse["data"]> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${ISSUE_PAGE_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.repo}`,
    "-F",
    `number=${issueNumber}`,
  ];
  if (commentsCursor) {
    args.push("-F", `commentsCursor=${commentsCursor}`);
  } else {
    args.push("-f", "commentsCursor=");
  }

  const raw = await gh(args);
  const parsed = parseJSON<IssuePageQueryResponse>(
    raw,
    "Failed to parse issue voting context response from gh CLI.",
  );
  return parsed.data;
}

async function addIssueCommentReaction(
  repo: RepoRef,
  commentDatabaseId: number,
  content: string,
): Promise<{ content?: string }> {
  const raw = await gh([
    "api",
    "-X",
    "POST",
    `/repos/${repo.owner}/${repo.repo}/issues/comments/${commentDatabaseId}/reactions`,
    "-H",
    "Accept: application/vnd.github+json",
    "-f",
    `content=${content}`,
  ]);

  return parseJSON<{ content?: string }>(
    raw,
    "Failed to parse reaction response from gh CLI.",
  );
}

export async function submitIssueVote(
  repo: RepoRef,
  issueRef: string,
  choice: VoteChoice,
  generatedAt = new Date().toISOString(),
): Promise<IssueVoteResult> {
  const issueNumber = await resolveIssueNumber(repo, issueRef);

  let cursor: string | null = null;
  let issueDetails:
    | {
      number: number;
      title: string;
      url: string;
      state: string;
      labels: string[];
    }
    | undefined;
  let targetComment:
    | {
      id: string;
      databaseId: number;
      url: string;
      body: string;
      createdAt: string;
      author: { login: string } | null;
    }
    | undefined;

  while (true) {
    const data = await fetchIssuePage(repo, issueNumber, cursor);
    const issue = data?.repository?.issue;
    if (!issue) {
      throw new CliError(
        `Issue #${issueNumber} was not found in ${formatRepo(repo)}.`,
        "GH_ERROR",
        1,
      );
    }

    if (!issueDetails) {
      issueDetails = {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        labels: (issue.labels.nodes ?? []).map((label) => label.name),
      };
    }

    for (const comment of issue.comments.nodes) {
      if (!isVotingMetadataComment(comment.body)) continue;
      if (!targetComment || comment.createdAt > targetComment.createdAt) {
        targetComment = comment;
      }
    }

    if (targetComment) break;
    if (!issue.comments.pageInfo?.hasPreviousPage) break;
    cursor = issue.comments.pageInfo.startCursor ?? null;
    if (!cursor) break;
  }

  if (!issueDetails) {
    throw new CliError(
      `Issue #${issueNumber} was not found in ${formatRepo(repo)}.`,
      "GH_ERROR",
      1,
    );
  }

  const inVotingPhase =
    hasGovernanceLabelName(issueDetails.labels, "VOTING")
    || hasGovernanceLabelName(issueDetails.labels, "EXTENDED_VOTING");
  if (!inVotingPhase) {
    throw new CliError(
      `Issue #${issueDetails.number} is not in voting phase; expected hivemoot:voting or hivemoot:extended-voting label.`,
      "GH_ERROR",
      1,
    );
  }

  if (!targetComment) {
    throw new CliError(
      `Could not find a Queen voting comment on issue #${issueDetails.number}.`,
      "GH_ERROR",
      1,
    );
  }

  const voteSpec = VOTE_CHOICE_SPEC[choice];
  const reactionResult = await addIssueCommentReaction(
    repo,
    targetComment.databaseId,
    voteSpec.restContent,
  );

  return {
    schemaVersion: 1,
    kind: "issue_vote",
    generatedAt,
    repo,
    issue: issueDetails,
    targetComment: {
      id: targetComment.id,
      databaseId: targetComment.databaseId,
      url: targetComment.url,
      author: targetComment.author?.login ?? null,
      createdAt: targetComment.createdAt,
    },
    vote: {
      choice,
      reaction: voteSpec.reaction,
      content: reactionResult.content ?? voteSpec.restContent,
    },
  };
}
