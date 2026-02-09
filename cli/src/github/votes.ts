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
  body: string;
  createdAt: string;
  reactions: {
    nodes: Array<{
      content: string;
      createdAt: string;
      user: { login: string } | null;
    }>;
  };
}

interface GraphQLResponse {
  data: {
    repository: {
      issue: {
        comments: {
          nodes: GraphQLComment[];
        };
      } | null;
    };
  };
}

const QUERY = `
query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      comments(last: 50) {
        nodes {
          body
          createdAt
          reactions(first: 100) {
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

/**
 * Find the current user's reaction on the latest voting comment for a single issue.
 */
function extractVote(comments: GraphQLComment[], currentUser: string): VoteInfo | undefined {
  // Find the latest voting comment (last in array = most recent)
  let votingComment: GraphQLComment | undefined;
  for (const comment of comments) {
    if (isVotingComment(comment.body)) {
      votingComment = comment;
    }
  }
  if (!votingComment) return undefined;

  // Find the current user's reaction
  for (const reaction of votingComment.reactions.nodes) {
    if (reaction.user?.login === currentUser) {
      const emoji = REACTION_EMOJI[reaction.content] ?? reaction.content;
      return { reaction: emoji, createdAt: reaction.createdAt };
    }
  }
  return undefined;
}

async function fetchVoteForIssue(
  repo: RepoRef,
  issueNumber: number,
  currentUser: string,
): Promise<VoteInfo | undefined> {
  const raw = await gh([
    "api",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-F",
    `owner=${repo.owner}`,
    "-F",
    `repo=${repo.repo}`,
    "-F",
    `number=${issueNumber}`,
  ]);

  const response: GraphQLResponse = JSON.parse(raw);
  const comments = response.data?.repository?.issue?.comments?.nodes;
  if (!comments) return undefined;

  return extractVote(comments, currentUser);
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
