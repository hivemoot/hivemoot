import type { RepoRef } from "../config/types.js";
import { gh } from "./client.js";

export interface VoteInfo {
  reaction: string;  // emoji: "👍" | "👎" | "😕" | "👀" | "🎉" | "❤️" | "🚀"
  createdAt: string; // ISO timestamp of the reaction
}

export type VoteMap = Map<number, VoteInfo>;

const METADATA_RE = /<!--\s*hivemoot-metadata:\s*(\{[\s\S]*?\})\s*-->/;

const REACTION_EMOJI: Record<string, string> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  CONFUSED: "😕",
  EYES: "👀",
  HOORAY: "🎉",
  HEART: "❤️",
  ROCKET: "🚀",
  LAUGH: "😄",
};

interface GraphQLComment {
  id: string;
  body: string;
  createdAt: string;
  reactions: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes: Array<{
      content: string;
      createdAt: string;
      user: { login: string } | null;
    }>;
  };
}

interface IssueCommentsConnection {
  pageInfo?: {
    hasPreviousPage?: boolean;
    startCursor?: string | null;
  };
  nodes: GraphQLComment[];
}

interface IssueCommentsResponse {
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
        nodes: Array<{
          content: string;
          createdAt: string;
          user: { login: string } | null;
        }>;
      };
    } | null;
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
          body
          createdAt
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

function isVotingComment(body: string): boolean {
  const match = body.match(METADATA_RE);
  if (!match) return false;
  try {
    const meta = JSON.parse(match[1]);
    return meta.type === "voting";
  } catch {
    return false;
  }
}

function findLatestVotingComment(comments: GraphQLComment[]): GraphQLComment | undefined {
  let votingComment: GraphQLComment | undefined;
  for (const comment of comments) {
    if (isVotingComment(comment.body)) {
      votingComment = comment;
    }
  }
  return votingComment;
}

function extractUserVote(
  reactions: Array<{ content: string; createdAt: string; user: { login: string } | null }>,
  currentUser: string,
): VoteInfo | undefined {
  for (const reaction of reactions) {
    if (reaction.user?.login === currentUser) {
      const emoji = REACTION_EMOJI[reaction.content] ?? reaction.content;
      return { reaction: emoji, createdAt: reaction.createdAt };
    }
  }
  return undefined;
}

async function fetchIssueCommentsPage(
  repo: RepoRef,
  issueNumber: number,
  commentsCursor: string | null,
): Promise<IssueCommentsConnection | undefined> {
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
  if (commentsCursor) {
    args.push("-F", `commentsCursor=${commentsCursor}`);
  } else {
    args.push("-f", "commentsCursor=");
  }

  const raw = await gh(args);
  const response: IssueCommentsResponse = JSON.parse(raw);
  return response.data?.repository?.issue?.comments;
}

async function fetchAdditionalReactions(
  commentId: string,
  currentUser: string,
  reactionsCursor: string | null,
): Promise<VoteInfo | undefined> {
  let cursor = reactionsCursor;
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

    const vote = extractUserVote(reactions.nodes, currentUser);
    if (vote) return vote;

    if (!reactions.pageInfo?.hasNextPage) break;
    cursor = reactions.pageInfo.endCursor ?? null;
  }

  return undefined;
}

async function fetchVoteForIssue(
  repo: RepoRef,
  issueNumber: number,
  currentUser: string,
): Promise<VoteInfo | undefined> {
  let commentsCursor: string | null = null;
  while (true) {
    const commentsConnection = await fetchIssueCommentsPage(repo, issueNumber, commentsCursor);
    if (!commentsConnection) return undefined;

    const votingComment = findLatestVotingComment(commentsConnection.nodes);
    if (votingComment) {
      const vote = extractUserVote(votingComment.reactions.nodes, currentUser);
      if (vote) return vote;

      if (votingComment.reactions.pageInfo?.hasNextPage) {
        return fetchAdditionalReactions(
          votingComment.id,
          currentUser,
          votingComment.reactions.pageInfo.endCursor ?? null,
        );
      }
      return undefined;
    }

    if (!commentsConnection.pageInfo?.hasPreviousPage) return undefined;
    commentsCursor = commentsConnection.pageInfo.startCursor ?? null;
    if (!commentsCursor) return undefined;
  }
}

/**
 * Fetch the current user's vote reactions on voting-phase issues.
 * Returns a map from issue number to vote info.
 * Returns empty map when inputs are empty — avoids unnecessary API calls.
 */
export async function fetchVotes(
  repo: RepoRef,
  issueNumbers: number[],
  currentUser: string,
): Promise<VoteMap> {
  const map: VoteMap = new Map();
  if (issueNumbers.length === 0 || !currentUser) return map;

  const results = await Promise.allSettled(
    issueNumbers.map((num) => fetchVoteForIssue(repo, num, currentUser)),
  );

  for (let i = 0; i < issueNumbers.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value) {
      map.set(issueNumbers[i], result.value);
    }
  }

  return map;
}
