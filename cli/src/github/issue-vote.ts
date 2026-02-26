import type { RepoRef } from "../config/types.js";
import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";

export type IssueVoteCode =
  | "vote_applied"
  | "no_voting_target"
  | "conflicting_vote"
  | "already_voted";

export interface VotingTargetComment {
  id: string;         // GraphQL node ID
  databaseId: number; // numeric REST comment ID
  url: string;
  createdAt: string;
  author: string;
}

export interface IssueVoteWarning {
  code: string;
  message: string;
}

export interface IssueVoteResult {
  schemaVersion: 1;
  kind: "issue_vote";
  generatedAt: string;
  repo: RepoRef;
  issue: number;
  vote: "up" | "down";
  dryRun: boolean;
  trustedQueenLogins: string[];
  targetComment?: VotingTargetComment;
  appliedReaction?: string;
  code: IssueVoteCode;
  warnings: IssueVoteWarning[];
}

export const TRUSTED_QUEEN_LOGINS = ["hivemoot", "hivemoot[bot]"] as const;
const TRUSTED_QUEEN_LOGINS_SET = new Set<string>(TRUSTED_QUEEN_LOGINS);

const METADATA_RE = /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/;

const VOTE_TO_CONTENT: Record<"up" | "down", string> = {
  up: "+1",
  down: "-1",
};

const VOTE_TO_GRAPHQL_CONTENT: Record<"up" | "down", string> = {
  up: "THUMBS_UP",
  down: "THUMBS_DOWN",
};

const CONFLICTING_GRAPHQL_CONTENT: Record<"up" | "down", string> = {
  up: "THUMBS_DOWN",
  down: "THUMBS_UP",
};

const VOTE_EMOJI: Record<"up" | "down", string> = {
  up: "👍",
  down: "👎",
};

interface GraphQLReactionNode {
  content: string;
  createdAt: string;
  user: { login: string } | null;
}

interface GraphQLVoteComment {
  id: string;
  databaseId: number;
  url: string;
  body: string;
  createdAt: string;
  author: { login: string } | null;
  reactions: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes: GraphQLReactionNode[];
  };
}

interface IssueCommentsConnection {
  pageInfo?: {
    hasPreviousPage?: boolean;
    startCursor?: string | null;
  };
  nodes: GraphQLVoteComment[];
}

interface IssueVoteCommentsResponse {
  data: {
    repository: {
      issue: {
        comments: IssueCommentsConnection;
      } | null;
    };
  };
}

interface CommentReactionsResponse {
  data: {
    node: {
      reactions: {
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
        nodes: GraphQLReactionNode[];
      };
    } | null;
  };
}

const ISSUE_VOTE_COMMENTS_QUERY = `
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

function parseMeta(body: string): Record<string, unknown> | undefined {
  const match = body.match(METADATA_RE);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isTrustedVotingComment(
  comment: GraphQLVoteComment,
  issueNumber: number,
): boolean {
  const authorLogin = comment.author?.login ?? "";
  if (!TRUSTED_QUEEN_LOGINS_SET.has(authorLogin)) return false;
  const meta = parseMeta(comment.body);
  if (!meta) return false;
  return meta.type === "voting" && meta.issueNumber === issueNumber;
}

function findUserReactionContent(
  reactions: GraphQLReactionNode[],
  userLogin: string,
): string | undefined {
  for (const r of reactions) {
    if (r.user?.login === userLogin) return r.content;
  }
  return undefined;
}

async function fetchCommentsPage(
  repo: RepoRef,
  issueNumber: number,
  cursor: string | null,
): Promise<IssueCommentsConnection | undefined> {
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${ISSUE_VOTE_COMMENTS_QUERY}`,
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
  const response: IssueVoteCommentsResponse = JSON.parse(raw);
  return response.data?.repository?.issue?.comments;
}

async function fetchUserReactionWithPagination(
  commentId: string,
  userLogin: string,
  initialCursor: string,
): Promise<string | undefined> {
  let cursor: string | null = initialCursor;
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
    const response: CommentReactionsResponse = JSON.parse(raw);
    const reactions = response.data?.node?.reactions;
    if (!reactions) return undefined;

    const content = findUserReactionContent(reactions.nodes, userLogin);
    if (content !== undefined) return content;

    if (!reactions.pageInfo?.hasNextPage) break;
    cursor = reactions.pageInfo.endCursor ?? null;
  }
  return undefined;
}

async function findTrustedVotingComment(
  repo: RepoRef,
  issueNumber: number,
): Promise<{ comment: GraphQLVoteComment } | undefined> {
  let cursor: string | null = null;
  while (true) {
    const connection = await fetchCommentsPage(repo, issueNumber, cursor);
    if (!connection) return undefined;

    let latestMatch: GraphQLVoteComment | undefined;
    for (const comment of connection.nodes) {
      if (isTrustedVotingComment(comment, issueNumber)) {
        latestMatch = comment;
      }
    }
    if (latestMatch) return { comment: latestMatch };

    if (!connection.pageInfo?.hasPreviousPage) return undefined;
    cursor = connection.pageInfo.startCursor ?? null;
    if (!cursor) return undefined;
  }
}

async function getUserReactionOnComment(
  comment: GraphQLVoteComment,
  userLogin: string,
): Promise<string | undefined> {
  const content = findUserReactionContent(comment.reactions.nodes, userLogin);
  if (content !== undefined) return content;

  if (comment.reactions.pageInfo?.hasNextPage && comment.reactions.pageInfo.endCursor) {
    return fetchUserReactionWithPagination(
      comment.id,
      userLogin,
      comment.reactions.pageInfo.endCursor,
    );
  }

  return undefined;
}

async function applyReaction(
  repo: RepoRef,
  commentDatabaseId: number,
  content: string,
): Promise<void> {
  await gh([
    "api",
    "-X", "POST",
    `/repos/${repo.owner}/${repo.repo}/issues/comments/${commentDatabaseId}/reactions`,
    "--raw-field", `content=${content}`,
  ]);
}

export async function buildIssueVoteResult(
  repo: RepoRef,
  issueNumber: number,
  vote: "up" | "down",
  dryRun: boolean,
): Promise<IssueVoteResult> {
  const generatedAt = new Date().toISOString();
  const trustedQueenLogins = [...TRUSTED_QUEEN_LOGINS];

  const found = await findTrustedVotingComment(repo, issueNumber);

  if (!found) {
    return {
      schemaVersion: 1,
      kind: "issue_vote",
      generatedAt,
      repo,
      issue: issueNumber,
      vote,
      dryRun,
      trustedQueenLogins,
      code: "no_voting_target",
      warnings: [],
    };
  }

  const currentUser = await fetchCurrentUser();

  const { comment } = found;
  const targetComment: VotingTargetComment = {
    id: comment.id,
    databaseId: comment.databaseId,
    url: comment.url,
    createdAt: comment.createdAt,
    author: comment.author?.login ?? "",
  };

  const existingContent = await getUserReactionOnComment(comment, currentUser);
  const requestedContent = VOTE_TO_GRAPHQL_CONTENT[vote];
  const conflictingContent = CONFLICTING_GRAPHQL_CONTENT[vote];

  if (existingContent === requestedContent) {
    return {
      schemaVersion: 1,
      kind: "issue_vote",
      generatedAt,
      repo,
      issue: issueNumber,
      vote,
      dryRun,
      trustedQueenLogins,
      targetComment,
      appliedReaction: VOTE_EMOJI[vote],
      code: "already_voted",
      warnings: [
        {
          code: "already_voted",
          message: `Already voted ${VOTE_EMOJI[vote]} on this issue.`,
        },
      ],
    };
  }

  if (existingContent === conflictingContent) {
    return {
      schemaVersion: 1,
      kind: "issue_vote",
      generatedAt,
      repo,
      issue: issueNumber,
      vote,
      dryRun,
      trustedQueenLogins,
      targetComment,
      code: "conflicting_vote",
      warnings: [],
    };
  }

  if (!dryRun) {
    await applyReaction(repo, comment.databaseId, VOTE_TO_CONTENT[vote]);
  }

  return {
    schemaVersion: 1,
    kind: "issue_vote",
    generatedAt,
    repo,
    issue: issueNumber,
    vote,
    dryRun,
    trustedQueenLogins,
    targetComment,
    appliedReaction: VOTE_EMOJI[vote],
    code: "vote_applied",
    warnings: [],
  };
}
