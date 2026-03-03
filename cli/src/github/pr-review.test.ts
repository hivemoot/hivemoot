import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError } from "../config/types.js";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

vi.mock("./user.js", () => ({
  fetchCurrentUser: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchCurrentUser } from "./user.js";
import { buildPrReviewResult } from "./pr-review.js";

const mockedGh = vi.mocked(gh);
const mockedFetchCurrentUser = vi.mocked(fetchCurrentUser);

const REPO = { owner: "hivemoot", repo: "hivemoot" };
const PR_NUMBER = 99;
const HEAD_SHA = "abc1234defabc1234defabc1234defabc1234def";
const USER = "hivemoot-worker";

function makePrInfoResponse(overrides: { author?: string | null } = {}): string {
  return JSON.stringify({
    number: PR_NUMBER,
    headRefOid: HEAD_SHA,
    author: overrides.author !== undefined ? { login: overrides.author } : { login: "hivemoot-other" },
  });
}

function makeReview(overrides: Partial<{
  user: string | null;
  state: string;
  commit_id: string;
  html_url: string;
  id: number;
}>): object {
  return {
    id: overrides.id ?? 1,
    user: overrides.user !== undefined ? { login: overrides.user } : { login: USER },
    state: overrides.state ?? "APPROVED",
    commit_id: overrides.commit_id ?? HEAD_SHA,
    html_url: `https://github.com/hivemoot/hivemoot/pull/${PR_NUMBER}#pullrequestreview-${overrides.id ?? 1}`,
  };
}

function makeSubmitResponse(id = 200): string {
  return JSON.stringify({
    html_url: `https://github.com/hivemoot/hivemoot/pull/${PR_NUMBER}#pullrequestreview-${id}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchCurrentUser.mockResolvedValue(USER);
});

describe("buildPrReviewResult — single-page reviews", () => {
  it("detects existing terminal review and returns already_reviewed", async () => {
    // gh pr view → fetchPrBasicInfo
    mockedGh.mockResolvedValueOnce(makePrInfoResponse());
    // gh api --paginate --slurp reviews → single page wrapped in outer array
    mockedGh.mockResolvedValueOnce(
      JSON.stringify([[makeReview({ state: "APPROVED" })]]),
    );

    const result = await buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "", false);

    expect(result.code).toBe("already_reviewed");
    expect(result.priorState).toBe("APPROVED");
  });

  it("submits review when no terminal review exists", async () => {
    mockedGh.mockResolvedValueOnce(makePrInfoResponse());
    // No reviews
    mockedGh.mockResolvedValueOnce(JSON.stringify([[]]));
    // Submit call
    mockedGh.mockResolvedValueOnce(makeSubmitResponse());

    const result = await buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "LGTM", false);

    expect(result.code).toBe("review_submitted");
    expect(result.reviewUrl).toContain("pullrequestreview");
  });
});

describe("buildPrReviewResult — multi-page reviews (--paginate --slurp)", () => {
  it("correctly detects terminal review spanning multiple pages", async () => {
    // Page 1: reviews from another user (not terminal for current user)
    const page1 = [
      makeReview({ id: 1, user: "hivemoot-other", state: "APPROVED" }),
      makeReview({ id: 2, user: "hivemoot-other", state: "CHANGES_REQUESTED" }),
    ];
    // Page 2: terminal review from current user at HEAD SHA
    const page2 = [
      makeReview({ id: 3, user: USER, state: "CHANGES_REQUESTED", commit_id: HEAD_SHA }),
    ];

    mockedGh.mockResolvedValueOnce(makePrInfoResponse());
    // --slurp wraps all pages into an outer array: [[...page1], [...page2]]
    mockedGh.mockResolvedValueOnce(JSON.stringify([page1, page2]));

    const result = await buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "", false);

    expect(result.code).toBe("already_reviewed");
    expect(result.priorState).toBe("CHANGES_REQUESTED");
  });

  it("does not fire gate when current user's review is on a different SHA", async () => {
    const oldSha = "0000000000000000000000000000000000000000";
    const page1 = [makeReview({ id: 1, user: USER, state: "APPROVED", commit_id: oldSha })];
    const page2 = [makeReview({ id: 2, user: "other", state: "APPROVED" })];

    mockedGh.mockResolvedValueOnce(makePrInfoResponse());
    mockedGh.mockResolvedValueOnce(JSON.stringify([page1, page2]));
    mockedGh.mockResolvedValueOnce(makeSubmitResponse(99));

    const result = await buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "", false);

    expect(result.code).toBe("review_submitted");
  });

  it("throws CliError on parse failure instead of silently returning []", async () => {
    mockedGh.mockResolvedValueOnce(makePrInfoResponse());
    // Corrupt JSON — should not silently bypass the idempotency gate
    mockedGh.mockResolvedValueOnce("not-valid-json");

    await expect(
      buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "", false),
    ).rejects.toMatchObject({ code: "GH_ERROR" });
  });
});

describe("buildPrReviewResult — own_pr warning", () => {
  it("adds own_pr warning when caller is the PR author", async () => {
    mockedGh.mockResolvedValueOnce(makePrInfoResponse({ author: USER }));
    mockedGh.mockResolvedValueOnce(JSON.stringify([[]]));
    mockedGh.mockResolvedValueOnce(makeSubmitResponse());

    const result = await buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "", false);

    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "own_pr" })]),
    );
  });
});

describe("buildPrReviewResult — dry-run", () => {
  it("resolves idempotency state without submitting", async () => {
    mockedGh.mockResolvedValueOnce(makePrInfoResponse());
    mockedGh.mockResolvedValueOnce(JSON.stringify([[]]));
    // No third call expected — dry-run should not submit

    const result = await buildPrReviewResult(REPO, String(PR_NUMBER), "approve", "", true);

    expect(result.dryRun).toBe(true);
    expect(result.code).toBe("review_submitted");
    // Only pr view + reviews calls, not the submit call
    expect(mockedGh).toHaveBeenCalledTimes(2);
  });
});
