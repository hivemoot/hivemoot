import { CliError, type RepoRef } from "../config/types.js";
import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";
import { TRUSTED_QUEEN_LOGINS } from "./issue-vote.js";
import { GOVERNANCE_LABEL_ALIASES } from "../summary/utils.js";

// ── Phase detection ────────────────────────────────────────────────

const PHASE_KEYS = [
  "DISCUSSION",
  "VOTING",
  "EXTENDED_VOTING",
  "READY_TO_IMPLEMENT",
  "REJECTED",
  "INCONCLUSIVE",
  "IMPLEMENTED",
] as const;

function buildPhaseLabelMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of PHASE_KEYS) {
    const phaseName = key.toLowerCase().replace(/_/g, "-");
    const aliases = GOVERNANCE_LABEL_ALIASES[key];
    for (const alias of aliases) {
      map.set(alias.toLowerCase(), phaseName);
    }
  }
  return map;
}

const PHASE_LABEL_MAP = buildPhaseLabelMap();

function extractPhase(labels: string[]): string | null {
  for (const label of labels) {
    const phase = PHASE_LABEL_MAP.get(label.toLowerCase());
    if (phase) return phase;
  }
  return null;
}

// ── Output types ───────────────────────────────────────────────────

export interface IssueSnapshotVotingComment {
  id: string;
  databaseId: number;
  url: string;
  createdAt: string;
  thumbsUp: number;
  thumbsDown: number;
  yourVote: string | null; // "👍" | "👎" | null
}

export interface IssueSnapshotQueenSummary {
  url: string;
  createdAt: string;
  bodyPreview: string; // first 500 chars, stripped of metadata block
}

export interface IssueSnapshotResult {
  schemaVersion: 1;
  kind: "issue_snapshot";
  generatedAt: string;
  repo: RepoRef;
  issue: {
    number: number;
    title: string;
    url: string;
    state: string;
    phase: string | null;
    labels: string[];
    assignees: string[];
    author: string | null;
    createdAt: string;
    updatedAt: string;
  };
  queenSummary?: IssueSnapshotQueenSummary;
  votingComment?: IssueSnapshotVotingComment;
}

// ── Internal helpers ───────────────────────────────────────────────

const TRUSTED_QUEEN_LOGINS_SET = new Set<string>(TRUSTED_QUEEN_LOGINS);
const METADATA_RE = /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/;
const BODY_PREVIEW_LENGTH = 500;

const REACTION_EMOJI: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
};

function parseMeta(body: string): Record<string, unknown> | undefined {
  const match = body.match(METADATA_RE);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stripMetadataComment(body: string): string {
  return body.replace(METADATA_RE, "").trim();
}

// ── REST: issue metadata ───────────────────────────────────────────

interface IssueViewResponse {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
}

async function fetchIssueMetadata(
  repo: RepoRef,
  issueNumber: number,
): Promise<IssueViewResponse> {
  const raw = await gh([
    "issue",
    "view",
    String(issueNumber),
    "-R",
    `${repo.owner}/${repo.repo}`,
    "--json",
    "number,title,url,state,labels,assignees,author,createdAt,updatedAt",
  ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(
      "Failed to parse issue metadata from gh CLI",
      "GH_ERROR",
      1,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      `Issue #${issueNumber} not found in ${repo.owner}/${repo.repo}.`,
      "GH_NOT_FOUND",
      1,
    );
  }

  return parsed as IssueViewResponse;
}

// ── GraphQL: comments ──────────────────────────────────────────────

interface GraphQLCommentNode {
  id: string;
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  author: { login: string } | null;
  reactions: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    nodes: Array<{
      content: string;
      createdAt: string;
      user: { login: string } | null;
    }>;
  };
}

interface CommentsConnection {
  pageInfo?: {
    hasPreviousPage?: boolean;
    startCursor?: string | null;
  };
  nodes: GraphQLCommentNode[];
}

interface IssueCommentsQueryResponse {
  data?: {
    repository?: {
      issue?: {
        comments: CommentsConnection;
      } | null;
    };
  };
}

const ISSUE_COMMENTS_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!, $commentsCursor: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
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
          reactions(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              content
              createdAt
              user { login }
            }
          }
        }
      }
    }
  }
}`;

const COMMENT_REACTIONS_QUERY = `
query ($commentId: ID!, $reactionsCursor: String) {
  node(id: $commentId) {
    ... on IssueComment {
      reactions(first: 100, after: $reactionsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          content
          createdAt
          user { login }
        }
      }
    }
  }
}`;

type ReactionNode = GraphQLCommentNode["reactions"]["nodes"][number];

interface CommentReactionsResponse {
  data: {
    node: {
      reactions: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes: ReactionNode[];
      };
    } | null;
  };
}

async function fetchAllReactionsForComment(
  commentId: string,
  initialReactions: GraphQLCommentNode["reactions"],
): Promise<ReactionNode[]> {
  const all: ReactionNode[] = [...initialReactions.nodes];

  if (!initialReactions.pageInfo?.hasNextPage || !initialReactions.pageInfo.endCursor) {
    return all;
  }

  let cursor: string | null = initialReactions.pageInfo.endCursor;
  while (cursor) {
    const raw = await gh([
      "api",
      "graphql",
      "-f",
      `query=${COMMENT_REACTIONS_QUERY}`,
      "-F",
      `commentId=${commentId}`,
      "-F",
      `reactionsCursor=${cursor}`,
    ]);
    const response = JSON.parse(raw) as CommentReactionsResponse;
    const reactions = response.data?.node?.reactions;
    if (!reactions) break;

    all.push(...reactions.nodes);

    if (!reactions.pageInfo?.hasNextPage) break;
    cursor = reactions.pageInfo.endCursor ?? null;
  }

  return all;
}

async function fetchCommentsPage(
  repo: RepoRef,
  issueNumber: number,
  cursor: string | null,
): Promise<CommentsConnection | undefined> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${ISSUE_COMMENTS_QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.repo}`,
    "-F",
    `number=${issueNumber}`,
  ];

  if (cursor) {
    args.push("-F", `commentsCursor=${cursor}`);
  } else {
    args.push("-f", "commentsCursor=");
  }

  const raw = await gh(args);
  const response = JSON.parse(raw) as IssueCommentsQueryResponse;
  return response.data?.repository?.issue?.comments;
}

// Paginates newest → older, stopping as soon as both types are found on a page.
// Within each page, nodes are chronological (oldest → newest), so last-wins
// gives the most recent match on that page. A match on a newer page takes
// precedence over anything on an older page.
async function findLatestQueenComments(
  repo: RepoRef,
  issueNumber: number,
): Promise<{ voting?: GraphQLCommentNode; summary?: GraphQLCommentNode }> {
  let cursor: string | null = null;
  let latestVoting: GraphQLCommentNode | undefined;
  let latestSummary: GraphQLCommentNode | undefined;

  while (true) {
    const connection = await fetchCommentsPage(repo, issueNumber, cursor);
    if (!connection) break;

    let pageVoting: GraphQLCommentNode | undefined;
    let pageSummary: GraphQLCommentNode | undefined;

    for (const comment of connection.nodes) {
      const authorLogin = comment.author?.login ?? "";
      if (!TRUSTED_QUEEN_LOGINS_SET.has(authorLogin)) continue;
      const meta = parseMeta(comment.body);
      if (!meta || meta.issueNumber !== issueNumber) continue;
      if (meta.type === "voting") pageVoting = comment;
      else if (meta.type === "summary") pageSummary = comment;
    }

    // Newer page wins: only record if not already found on a later page.
    if (pageVoting && !latestVoting) latestVoting = pageVoting;
    if (pageSummary && !latestSummary) latestSummary = pageSummary;

    // Stop as soon as both are found.
    if (latestVoting && latestSummary) break;

    if (!connection.pageInfo?.hasPreviousPage) break;
    cursor = connection.pageInfo.startCursor ?? null;
    if (!cursor) break;
  }

  return { voting: latestVoting, summary: latestSummary };
}

// ── Main export ────────────────────────────────────────────────────

export async function buildIssueSnapshot(
  repo: RepoRef,
  issueNumber: number,
): Promise<IssueSnapshotResult> {
  const generatedAt = new Date().toISOString();

  const [issueData, { voting: latestVoting, summary: latestSummary }] = await Promise.all([
    fetchIssueMetadata(repo, issueNumber),
    findLatestQueenComments(repo, issueNumber),
  ]);

  const labels = issueData.labels.map((l) => l.name);
  const phase = extractPhase(labels);

  // Resolve yourVote if there is a voting comment.
  let currentUser: string | null = null;
  if (latestVoting) {
    try {
      currentUser = await fetchCurrentUser();
    } catch {
      // Best-effort — yourVote will be null if user lookup fails.
    }
  }

  let votingComment: IssueSnapshotVotingComment | undefined;
  if (latestVoting) {
    // Paginate through all reactions so tallies and yourVote are accurate even
    // when the voting comment has more than 100 reactions.
    const allReactions = await fetchAllReactionsForComment(
      latestVoting.id,
      latestVoting.reactions,
    );

    const thumbsUp = allReactions.filter((r) => r.content === "THUMBS_UP").length;
    const thumbsDown = allReactions.filter((r) => r.content === "THUMBS_DOWN").length;

    let yourVote: string | null = null;
    if (currentUser) {
      const yourReaction = allReactions.find((r) => r.user?.login === currentUser);
      if (yourReaction) {
        yourVote = REACTION_EMOJI[yourReaction.content] ?? null;
      }
    }

    votingComment = {
      id: latestVoting.id,
      databaseId: latestVoting.databaseId,
      url: latestVoting.url,
      createdAt: latestVoting.createdAt,
      thumbsUp,
      thumbsDown,
      yourVote,
    };
  }

  let queenSummary: IssueSnapshotQueenSummary | undefined;
  if (latestSummary) {
    queenSummary = {
      url: latestSummary.url,
      createdAt: latestSummary.createdAt,
      bodyPreview: stripMetadataComment(latestSummary.body).slice(
        0,
        BODY_PREVIEW_LENGTH,
      ),
    };
  }

  return {
    schemaVersion: 1,
    kind: "issue_snapshot",
    generatedAt,
    repo,
    issue: {
      number: issueData.number,
      title: issueData.title,
      url: issueData.url,
      state: issueData.state.toLowerCase(),
      phase,
      labels,
      assignees: issueData.assignees.map((a) => a.login),
      author: issueData.author?.login ?? null,
      createdAt: issueData.createdAt,
      updatedAt: issueData.updatedAt,
    },
    queenSummary,
    votingComment,
  };
}
