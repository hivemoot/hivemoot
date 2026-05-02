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

describe("GitHubDecisionPoster.postDecision — non-PR subject types (mention / issue)", () => {
  // pr_review, mention_response, and issue_triage all share the
  // `{owner}/{repo}#{number}` ref shape; GitHub's
  // `issues.createComment` works for both PRs and plain issues, so
  // the poster handles all three uniformly.
  it("posts mention_response decisions to the mentioned issue", async () => {
    const { octokit, createCommentFn } = makeOctokit({
      htmlUrl: "https://github.com/o/r/issues/9#issuecomment-123",
    });
    const poster = new GitHubDecisionPoster({ octokit });
    const result = await poster.postDecision({
      ...PR_ARGS,
      subjectType: "mention_response",
      subjectRef: "o/r#9",
    });
    expect(result.attempted).toBe(true);
    expect(result.commentUrl).toBe(
      "https://github.com/o/r/issues/9#issuecomment-123",
    );
    expect(createCommentFn).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", issue_number: 9 }),
    );
  });

  it("posts issue_triage decisions to the triaged issue", async () => {
    const { octokit, createCommentFn } = makeOctokit({
      htmlUrl: "https://github.com/o/r/issues/42#issuecomment-456",
    });
    const poster = new GitHubDecisionPoster({ octokit });
    const result = await poster.postDecision({
      ...PR_ARGS,
      subjectType: "issue_triage",
      subjectRef: "o/r#42",
    });
    expect(result.attempted).toBe(true);
    expect(createCommentFn).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", issue_number: 42 }),
    );
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

describe("GitHubDecisionPoster.postDecision — strict subject_ref regex (R1 #540)", () => {
  // Closes #540 builder R1: prior regex `^([^/]+)/([^#]+)#(\d+)$`
  // was too permissive. Tightened to GitHub's actual charset.

  it.each([
    ["owner/repo/extra#1", "extra path segment"],
    ["owner with spaces/repo#42", "spaces in owner"],
    ["owner/repo with spaces#42", "spaces in repo"],
    ["owner//repo#42", "double slash"],
    ["owner/repo#0", "PR number zero"],
    ["owner/repo#01", "leading-zero PR number"],
    ["owner/repo#042", "leading-zero PR number multi-digit"],
    ["/repo#42", "missing owner"],
    ["owner/#42", "missing repo"],
    ["owner/repo#", "missing PR number"],
    ["owner/repo#42 ", "trailing space"],
    ["owner/repo#42\n", "trailing newline"],
    [" owner/repo#42", "leading space"],
    ["owner/repo#-1", "negative PR number"],
    ["owner/repo#1.5", "non-integer PR number"],
    ["owner/répo#42", "non-ASCII char in repo"],
    ["owner/re*po#42", "asterisk in repo"],
  ])("rejects %j (%s)", async (badRef) => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    await expect(
      poster.postDecision({ ...PR_ARGS, subjectRef: badRef }),
    ).rejects.toBeInstanceOf(DecisionPostError);
    expect(createCommentFn).not.toHaveBeenCalled();
  });

  it.each([
    ["org/repo#1", { owner: "org", repo: "repo", number: 1 }],
    ["a/b#42", { owner: "a", repo: "b", number: 42 }],
    [
      "my-org/my-repo#100",
      { owner: "my-org", repo: "my-repo", number: 100 },
    ],
    [
      "my.org/my.repo#7",
      { owner: "my.org", repo: "my.repo", number: 7 },
    ],
    [
      "my_org/my_repo#9999",
      { owner: "my_org", repo: "my_repo", number: 9999 },
    ],
    ["1org/2repo#1", { owner: "1org", repo: "2repo", number: 1 }],
  ])("accepts %j", async (goodRef, expected) => {
    const { octokit, createCommentFn } = makeOctokit({
      htmlUrl: "https://github.com/example/example/pull/1",
    });
    const poster = new GitHubDecisionPoster({ octokit });
    await poster.postDecision({ ...PR_ARGS, subjectRef: goodRef });
    expect(createCommentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: expected.owner,
        repo: expected.repo,
        issue_number: expected.number,
      }),
    );
  });

  it("rejects oversized subject_ref (DOS guard)", async () => {
    const { octokit, createCommentFn } = makeOctokit({});
    const poster = new GitHubDecisionPoster({ octokit });
    const huge = "a".repeat(300);
    await expect(
      poster.postDecision({ ...PR_ARGS, subjectRef: `${huge}/repo#1` }),
    ).rejects.toBeInstanceOf(DecisionPostError);
    expect(createCommentFn).not.toHaveBeenCalled();
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
