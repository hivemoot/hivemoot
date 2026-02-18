import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { fetchRecentClosedByAuthor } from "./recent.js";

const mockGh = gh as unknown as ReturnType<typeof vi.fn>;
const repo = { owner: "hivemoot", repo: "hivemoot" };
const now = new Date("2026-02-18T10:00:00Z");

describe("fetchRecentClosedByAuthor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches closed issues and PRs for the author", async () => {
    mockGh
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce("[]");

    await fetchRecentClosedByAuthor(repo, "hivemoot-worker", now);

    expect(mockGh).toHaveBeenNthCalledWith(1, [
      "issue",
      "list",
      "-R",
      "hivemoot/hivemoot",
      "--author",
      "hivemoot-worker",
      "--state",
      "closed",
      "--search",
      "closed:>=2026-02-11 sort:updated-desc",
      "--json",
      "number,title,url,labels,closedAt",
      "--limit",
      "100",
    ]);

    expect(mockGh).toHaveBeenNthCalledWith(2, [
      "pr",
      "list",
      "-R",
      "hivemoot/hivemoot",
      "--author",
      "hivemoot-worker",
      "--state",
      "closed",
      "--search",
      "closed:>=2026-02-11 sort:updated-desc",
      "--json",
      "number,title,url,labels,state,mergedAt,closedAt",
      "--limit",
      "100",
    ]);
  });

  it("classifies merged/rejected/closed and sorts newest first", async () => {
    mockGh
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            number: 11,
            title: "Rejected idea",
            url: "https://github.com/hivemoot/hivemoot/issues/11",
            labels: [{ name: "rejected" }],
            closedAt: "2026-02-18T08:00:00Z",
          },
          {
            number: 12,
            title: "Plain close",
            url: "https://github.com/hivemoot/hivemoot/issues/12",
            labels: [],
            closedAt: "2026-02-10T08:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            number: 21,
            title: "Merged PR",
            url: "https://github.com/hivemoot/hivemoot/pull/21",
            labels: [],
            mergedAt: "2026-02-18T09:00:00Z",
            closedAt: "2026-02-18T09:00:00Z",
          },
          {
            number: 22,
            title: "Rejected PR",
            url: "https://github.com/hivemoot/hivemoot/pull/22",
            labels: [{ name: "hivemoot:rejected" }],
            mergedAt: null,
            closedAt: "2026-02-17T09:00:00Z",
          },
        ]),
      );

    const result = await fetchRecentClosedByAuthor(repo, "hivemoot-worker", now, 10, 7);

    expect(result).toEqual([
      {
        number: 21,
        title: "Merged PR",
        url: "https://github.com/hivemoot/hivemoot/pull/21",
        itemType: "pr",
        outcome: "merged",
        closedAt: "2026-02-18T09:00:00Z",
      },
      {
        number: 11,
        title: "Rejected idea",
        url: "https://github.com/hivemoot/hivemoot/issues/11",
        itemType: "issue",
        outcome: "rejected",
        closedAt: "2026-02-18T08:00:00Z",
      },
      {
        number: 22,
        title: "Rejected PR",
        url: "https://github.com/hivemoot/hivemoot/pull/22",
        itemType: "pr",
        outcome: "rejected",
        closedAt: "2026-02-17T09:00:00Z",
      },
    ]);
  });

  it("caps output to maxItems", async () => {
    mockGh
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            number: 31,
            title: "Issue one",
            url: "https://github.com/hivemoot/hivemoot/issues/31",
            labels: [],
            closedAt: "2026-02-18T08:00:00Z",
          },
          {
            number: 32,
            title: "Issue two",
            url: "https://github.com/hivemoot/hivemoot/issues/32",
            labels: [],
            closedAt: "2026-02-18T07:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            number: 41,
            title: "PR one",
            url: "https://github.com/hivemoot/hivemoot/pull/41",
            labels: [],
            mergedAt: null,
            closedAt: "2026-02-18T06:00:00Z",
          },
        ]),
      );

    const result = await fetchRecentClosedByAuthor(repo, "hivemoot-worker", now, 2, 7);

    expect(result).toHaveLength(2);
  });

  it("keeps newest closures when returned data is not ordered by closedAt", async () => {
    mockGh
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            number: 71,
            title: "Older closed issue",
            url: "https://github.com/hivemoot/hivemoot/issues/71",
            labels: [],
            closedAt: "2026-02-16T06:00:00Z",
          },
          {
            number: 72,
            title: "Newest closed issue",
            url: "https://github.com/hivemoot/hivemoot/issues/72",
            labels: [],
            closedAt: "2026-02-18T09:00:00Z",
          },
          {
            number: 73,
            title: "Mid closed issue",
            url: "https://github.com/hivemoot/hivemoot/issues/73",
            labels: [],
            closedAt: "2026-02-17T12:00:00Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            number: 81,
            title: "Older PR",
            url: "https://github.com/hivemoot/hivemoot/pull/81",
            labels: [],
            mergedAt: null,
            closedAt: "2026-02-16T01:00:00Z",
          },
          {
            number: 82,
            title: "Second newest PR",
            url: "https://github.com/hivemoot/hivemoot/pull/82",
            labels: [],
            mergedAt: "2026-02-18T08:30:00Z",
            closedAt: "2026-02-18T08:30:00Z",
          },
        ]),
      );

    const result = await fetchRecentClosedByAuthor(repo, "hivemoot-worker", now, 3, 7);

    expect(result.map((item) => item.number)).toEqual([72, 82, 73]);
  });

  it("throws CliError for malformed issue JSON", async () => {
    mockGh
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("[]");

    await expect(fetchRecentClosedByAuthor(repo, "hivemoot-worker", now)).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("closed issues"),
    });
  });

  it("throws CliError for non-array PR response", async () => {
    mockGh
      .mockResolvedValueOnce("[]")
      .mockResolvedValueOnce('{"nope":true}');

    await expect(fetchRecentClosedByAuthor(repo, "hivemoot-worker", now)).rejects.toMatchObject({
      code: "GH_ERROR",
      message: expect.stringContaining("closed pull requests"),
    });
  });
});
