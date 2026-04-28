/**
 * Tests for `GitHubDecisionPoster` and `RecordingDecisionPoster`
 * (G'.4). Mocks the octokit's `createComment` so the tests don't
 * make network calls.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DecisionPostError,
  GitHubDecisionPoster,
  RecordingDecisionPoster,
  type CommentingOctokit,
  type PostDecisionArgs,
} from "./decision-poster.js";

function makeOctokit(opts: {
  htmlUrl?: string;
  throws?: unknown;
} = {}): { octokit: CommentingOctokit; createCommentFn: ReturnType<typeof vi.fn> } {
  const createCommentFn = vi.fn().mockImplementation(async () => {
    if (opts.throws) throw opts.throws;
    return {
      data: {
        html_url: opts.htmlUrl,
      },
    };
  });
  const octokit: CommentingOctokit = {
    rest: {
      issues: {
        createComment: createCommentFn,
      },
    },
  };
  return { octokit, createCommentFn };
}

const PR_ARGS: PostDecisionArgs = {
  subjectType: "pr_review",
  subjectRef: "owner/repo#42",
  content: "## Synthesis — owner/repo#42\n\n**Verdict:** `APPROVE`\n\nLGTM.",
  roomId: "01234567-89ab-4cde-9012-3456789abcde",
};

describe("GitHubDecisionPoster.postDecision — pr_review subjects", () => {
  it("posts a comment with the decision content and returns html_url", async () => {
    const { octokit, createCommentFn } = makeOctokit({
      htmlUrl: "https://github.com/owner/repo/pull/42#issuecomment-123",
    });
    const poster = new GitHubDecisionPoster({ octokit });
    const result = await poster.postDecision(PR_ARGS);
    expect(result.attempted).toBe(true);
    expect(result.commentUrl).toBe(
      "https://github.com/owner/repo/pull/42#issuecomment-123",
    );
    expect(createCommentFn).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
      body: PR_ARGS.content,
    });
  });

  it("returns null commentUrl when API response lacks html_url", async () => {
    // Defensive: GitHub API spec says html_url is always returned,
    // but if a future API version changes shape we don't want to
    // crash; null is the sentinel.
    const { octokit } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    const result = await poster.postDecision(PR_ARGS);
    expect(result.attempted).toBe(true);
    expect(result.commentUrl).toBeNull();
  });

  it("propagates octokit errors (caller's manager loop maps to postsFailed++)", async () => {
    const { octokit } = makeOctokit({
      throws: new Error("API rate limit exceeded"),
    });
    const poster = new GitHubDecisionPoster({ octokit });
    await expect(poster.postDecision(PR_ARGS)).rejects.toThrow(
      /API rate limit/,
    );
  });

  it("parses owner/repo with hyphens and dots", async () => {
    const { octokit, createCommentFn } = makeOctokit({
      htmlUrl: "https://github.com/x/y.z-2/pull/9#issuecomment-1",
    });
    const poster = new GitHubDecisionPoster({ octokit });
    await poster.postDecision({
      ...PR_ARGS,
      subjectRef: "my-org/repo.with.dots-and-dashes#9",
    });
    expect(createCommentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "my-org",
        repo: "repo.with.dots-and-dashes",
        issue_number: 9,
      }),
    );
  });
});

describe("GitHubDecisionPoster.postDecision — non-pr_review subjects (V1 skip)", () => {
  it("skips mention_response (V1: pr_review only)", async () => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    const result = await poster.postDecision({
      ...PR_ARGS,
      subjectType: "mention_response",
    });
    expect(result.attempted).toBe(false);
    expect(result.commentUrl).toBeNull();
    expect(createCommentFn).not.toHaveBeenCalled();
  });

  it("skips issue_triage (V1: pr_review only)", async () => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    const result = await poster.postDecision({
      ...PR_ARGS,
      subjectType: "issue_triage",
    });
    expect(result.attempted).toBe(false);
    expect(createCommentFn).not.toHaveBeenCalled();
  });
});

describe("GitHubDecisionPoster.postDecision — malformed subject_ref", () => {
  it("throws DecisionPostError on shape mismatch (no slash)", async () => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    await expect(
      poster.postDecision({ ...PR_ARGS, subjectRef: "no-slash#42" }),
    ).rejects.toBeInstanceOf(DecisionPostError);
    expect(createCommentFn).not.toHaveBeenCalled();
  });

  it("throws DecisionPostError on missing PR number", async () => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    await expect(
      poster.postDecision({ ...PR_ARGS, subjectRef: "owner/repo#" }),
    ).rejects.toBeInstanceOf(DecisionPostError);
    expect(createCommentFn).not.toHaveBeenCalled();
  });

  it("throws DecisionPostError on non-numeric PR number", async () => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    await expect(
      poster.postDecision({ ...PR_ARGS, subjectRef: "owner/repo#abc" }),
    ).rejects.toBeInstanceOf(DecisionPostError);
    expect(createCommentFn).not.toHaveBeenCalled();
  });

  it("DecisionPostError carries the roomId for log correlation", async () => {
    const { octokit } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    try {
      await poster.postDecision({ ...PR_ARGS, subjectRef: "bad" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DecisionPostError);
      expect((err as DecisionPostError).roomId).toBe(PR_ARGS.roomId);
    }
  });
});

describe("RecordingDecisionPoster", () => {
  it("records calls and returns a fake URL for pr_review", async () => {
    const poster = new RecordingDecisionPoster();
    const result = await poster.postDecision(PR_ARGS);
    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]).toEqual(PR_ARGS);
    expect(result.attempted).toBe(true);
    expect(result.commentUrl).toContain(PR_ARGS.roomId);
  });

  it("returns attempted=false for non-pr_review subjects", async () => {
    const poster = new RecordingDecisionPoster();
    const result = await poster.postDecision({
      ...PR_ARGS,
      subjectType: "mention_response",
    });
    expect(result.attempted).toBe(false);
    expect(result.commentUrl).toBeNull();
    // Still records the call (so tests can verify the loop tried).
    expect(poster.calls).toHaveLength(1);
  });
});
