/**
 * GitHub Discussions GraphQL Operations
 *
 * Manages the Colony Journal discussion: a single locked discussion
 * where the bot appends daily standup comments as a timeline.
 *
 * Uses GitHub's GraphQL API because Discussions have no REST endpoint.
 */

import type { GraphQLClient } from "./graphql-queries.js";
import { parseMetadata, type StandupMetadata } from "./bot-comments.js";
import { logger } from "./logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface DiscussionCategory {
  id: string;
  name: string;
}

export interface RepoDiscussionInfo {
  repoId: string;
  repoCreatedAt: string;
  hasDiscussions: boolean;
  categories: DiscussionCategory[];
}

export interface ColonyJournal {
  discussionId: string;
  number: number;
}

export interface StandupCommentResult {
  commentId: string;
  url: string;
}

// ───────────────────────────────────────────────────────────────────────────────
// GraphQL Queries
// ───────────────────────────────────────────────────────────────────────────────

const GET_REPO_DISCUSSION_INFO_QUERY = `
  query getRepoDiscussionInfo($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      id
      createdAt
      hasDiscussionsEnabled
      discussionCategories(first: 25) {
        nodes {
          id
          name
        }
      }
    }
  }
`;

interface RepoDiscussionInfoResponse {
  repository: {
    id: string;
    createdAt: string;
    hasDiscussionsEnabled: boolean;
    discussionCategories: {
      nodes: Array<DiscussionCategory | null>;
    };
  };
}

const FIND_COLONY_JOURNAL_QUERY = `
  query findColonyJournal($owner: String!, $repo: String!, $categoryId: ID!) {
    repository(owner: $owner, name: $repo) {
      discussions(categoryId: $categoryId, first: 25, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes {
          id
          number
          title
          locked
        }
      }
    }
  }
`;

interface FindColonyJournalResponse {
  repository: {
    discussions: {
      nodes: Array<{
        id: string;
        number: number;
        title: string;
        locked: boolean;
      } | null>;
    };
  };
}

const CREATE_DISCUSSION_MUTATION = `
  mutation createDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
    createDiscussion(input: {repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body}) {
      discussion {
        id
        number
        url
      }
    }
  }
`;

interface CreateDiscussionResponse {
  createDiscussion: {
    discussion: {
      id: string;
      number: number;
      url: string;
    };
  };
}

const LOCK_LOCKABLE_MUTATION = `
  mutation lockLockable($lockableId: ID!) {
    lockLockable(input: {lockableId: $lockableId}) {
      lockedRecord {
        locked
      }
    }
  }
`;

const ADD_DISCUSSION_COMMENT_MUTATION = `
  mutation addDiscussionComment($discussionId: ID!, $body: String!) {
    addDiscussionComment(input: {discussionId: $discussionId, body: $body}) {
      comment {
        id
        url
      }
    }
  }
`;

interface AddDiscussionCommentResponse {
  addDiscussionComment: {
    comment: {
      id: string;
      url: string;
    };
  };
}

const GET_LAST_DISCUSSION_COMMENTS_QUERY = `
  query getLastDiscussionComments($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      discussion(number: $number) {
        comments(last: 10) {
          nodes {
            body
            createdAt
          }
        }
      }
    }
  }
`;

interface LastDiscussionCommentsResponse {
  repository: {
    discussion: {
      comments: {
        nodes: Array<{
          body: string;
          createdAt: string;
        } | null>;
      };
    } | null;
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────────

const COLONY_JOURNAL_TITLE = "Colony Journal";
const COLONY_JOURNAL_BODY = `# Colony Journal

Daily standup reports from the Hivemoot Queen.

Each comment below is one day's Colony Report — a snapshot of governance pipeline status, implementation activity, and the Queen's editorial take.

This discussion is locked to keep the timeline clean. Only the Queen posts here.

---
buzz buzz 🐝 Hivemoot Queen`;

const MS_PER_DAY = 86_400_000;

// ───────────────────────────────────────────────────────────────────────────────
// Functions
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Get repository discussion info including categories and creation date.
 */
export async function getRepoDiscussionInfo(
  client: GraphQLClient,
  owner: string,
  repo: string
): Promise<RepoDiscussionInfo> {
  const response = await client.graphql<RepoDiscussionInfoResponse>(
    GET_REPO_DISCUSSION_INFO_QUERY,
    { owner, repo }
  );

  return {
    repoId: response.repository.id,
    repoCreatedAt: response.repository.createdAt,
    hasDiscussions: response.repository.hasDiscussionsEnabled,
    categories: response.repository.discussionCategories.nodes.filter(
      (node): node is DiscussionCategory => node !== null
    ),
  };
}

/**
 * Find existing Colony Journal discussion or create + lock a new one.
 *
 * Searches the given category for a discussion with "Colony Journal" in the title.
 * On first run, creates the discussion and locks it so only the bot can comment.
 */
export async function findOrCreateColonyJournal(
  client: GraphQLClient,
  repoId: string,
  categoryId: string,
  owner: string,
  repo: string
): Promise<ColonyJournal> {
  // Search for existing journal
  const searchResponse = await client.graphql<FindColonyJournalResponse>(
    FIND_COLONY_JOURNAL_QUERY,
    { owner, repo, categoryId }
  );

  const existing = searchResponse.repository.discussions.nodes.find(
    (d): d is NonNullable<typeof d> =>
      d !== null && d.title.includes(COLONY_JOURNAL_TITLE)
  );

  if (existing) {
    // Lock if somehow unlocked (idempotent safety)
    if (!existing.locked) {
      logger.info(`Locking existing Colony Journal discussion #${existing.number}`);
      await client.graphql(LOCK_LOCKABLE_MUTATION, { lockableId: existing.id });
    }
    return { discussionId: existing.id, number: existing.number };
  }

  // First run: create the journal discussion
  logger.info(`Creating Colony Journal discussion in ${owner}/${repo}`);

  const createResponse = await client.graphql<CreateDiscussionResponse>(
    CREATE_DISCUSSION_MUTATION,
    {
      repositoryId: repoId,
      categoryId,
      title: COLONY_JOURNAL_TITLE,
      body: COLONY_JOURNAL_BODY,
    }
  );

  const discussion = createResponse.createDiscussion.discussion;
  logger.info(`Created Colony Journal discussion #${discussion.number}: ${discussion.url}`);

  // Lock the discussion so only the bot comments
  await client.graphql(LOCK_LOCKABLE_MUTATION, { lockableId: discussion.id });
  logger.info(`Locked Colony Journal discussion #${discussion.number}`);

  return { discussionId: discussion.id, number: discussion.number };
}

/**
 * Add a standup comment to the Colony Journal discussion.
 *
 * Uses write-then-verify: if the mutation throws a network error,
 * checks whether the comment was actually created before failing.
 */
export async function addStandupComment(
  client: GraphQLClient,
  discussionId: string,
  body: string,
  owner: string,
  repo: string,
  discussionNumber: number,
  reportDate: string
): Promise<StandupCommentResult> {
  try {
    const response = await client.graphql<AddDiscussionCommentResponse>(
      ADD_DISCUSSION_COMMENT_MUTATION,
      { discussionId, body }
    );

    return {
      commentId: response.addDiscussionComment.comment.id,
      url: response.addDiscussionComment.comment.url,
    };
  } catch (error) {
    // Write-then-verify: check if the comment was actually created despite the error
    logger.warn(
      `addDiscussionComment threw, verifying if comment was created: ${(error as Error).message}`
    );

    try {
      const lastDate = await getLastStandupDate(client, owner, repo, discussionNumber);
      if (lastDate === reportDate) {
        logger.info("Comment was created despite error (write-then-verify succeeded)");
        return { commentId: "verified-after-error", url: "" };
      }
    } catch (verifyError) {
      logger.warn(
        `Verification query also failed: ${(verifyError as Error).message}`
      );
    }

    // Original mutation error propagates (not masked by verification failure)
    throw error;
  }
}

/**
 * Get the date from the most recent standup comment's metadata tag.
 * Returns null if no standup comment found or metadata is unparseable.
 *
 * Used for idempotency: if the last comment has today's date, skip posting.
 */
export async function getLastStandupDate(
  client: GraphQLClient,
  owner: string,
  repo: string,
  discussionNumber: number
): Promise<string | null> {
  const response = await client.graphql<LastDiscussionCommentsResponse>(
    GET_LAST_DISCUSSION_COMMENTS_QUERY,
    { owner, repo, number: discussionNumber }
  );

  const comments = response.repository.discussion?.comments.nodes;
  if (!comments || comments.length === 0) {
    return null;
  }

  // Check comments from newest to oldest for a standup metadata tag
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (!comment) continue;

    const metadata = parseMetadata(comment.body);
    if (metadata?.type === "standup") {
      return (metadata as StandupMetadata).date;
    }
  }

  return null;
}

/**
 * Compute the colony day number for a specific report date (UTC calendar day).
 * Day 0 is the repo creation calendar day, incrementing daily.
 */
export function computeDayNumber(repoCreatedAt: string, reportDate: string): number {
  const createdAt = new Date(repoCreatedAt);
  const createdDayUTC = Date.UTC(
    createdAt.getUTCFullYear(),
    createdAt.getUTCMonth(),
    createdAt.getUTCDate()
  );

  const [year, month, day] = reportDate.split("-").map(Number);
  const reportDayUTC = Date.UTC(year, month - 1, day);

  return Math.max(0, Math.floor((reportDayUTC - createdDayUTC) / MS_PER_DAY));
}
