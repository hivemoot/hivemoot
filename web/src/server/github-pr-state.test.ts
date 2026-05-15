import { describe, it, expect, vi } from "vitest";
import {
  getPullRequestState,
  getPullRequestMergeState,
  deriveCiState,
  PullRequestNotFoundError,
  GitHubAPIError,
  type CiState,
} from "./github-pr-state";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

interface MockEndpoint {
  /** URL substring to match. */
  match: string;
  /** Response body (JSON-stringified by the helper). */
  body: unknown;
  /** Status code. Defaults to 200. */
  status?: number;
}

function makeFetchMock(endpoints: MockEndpoint[]): typeof fetch {
  return vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = endpoints.find((e) => url.includes(e.match));
    if (!match) {
      throw new Error(`Unmocked fetch URL: ${url}`);
    }
    return {
      ok: (match.status ?? 200) >= 200 && (match.status ?? 200) < 300,
      status: match.status ?? 200,
      json: async () => match.body,
      text: async () =>
        typeof match.body === "string" ? match.body : JSON.stringify(match.body),
    } as Response;
  }) as unknown as typeof fetch;
}

function prPayload(overrides: {
  sha?: string;
  labels?: string[];
  mergeable_state?: string | null;
} = {}) {
  return {
    head: { sha: overrides.sha ?? "abc123" },
    labels: (overrides.labels ?? []).map((name) => ({ name })),
    // Use `in` instead of `??` so `null` passes through (vs. being
    // coerced to the "clean" default — the GitHub API returns null
    // while it computes mergeable_state, and we want that path
    // exercised by the test).
    mergeable_state:
      "mergeable_state" in overrides ? overrides.mergeable_state : "clean",
  };
}

// ---------------------------------------------------------------------------
// deriveCiState — unit tests on the normalization helper
// ---------------------------------------------------------------------------

describe("deriveCiState", () => {
  const emptyStatus = { state: "pending", total_count: 0 };

  it("'no_checks' when no check-runs and no legacy statuses (CI not configured)", () => {
    expect(
      deriveCiState({ checkRuns: [], truncated: false, status: emptyStatus }),
    ).toBe("no_checks" satisfies CiState);
  });

  it("'truncated' when GitHub returned more check-runs than fit in one page (>100)", () => {
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "success" }],
        truncated: true,
        status: emptyStatus,
      }),
    ).toBe("truncated");
  });

  it("'success' when all check-runs completed with passing conclusions and no failing legacy status", () => {
    expect(
      deriveCiState({
        checkRuns: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "neutral" },
          { status: "completed", conclusion: "skipped" },
        ],
        truncated: false,
        status: emptyStatus,
      }),
    ).toBe("success");
  });

  it("'failure' on any failing check-run conclusion (failure, cancelled, timed_out, action_required, stale)", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
    ]) {
      expect(
        deriveCiState({
          checkRuns: [{ status: "completed", conclusion }],
          truncated: false,
          status: emptyStatus,
        }),
      ).toBe("failure");
    }
  });

  it("'failure' on completed check-run with null conclusion (defensive — should not happen in practice)", () => {
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: null }],
        truncated: false,
        status: emptyStatus,
      }),
    ).toBe("failure");
  });

  it("'pending' on queued/in-progress check-runs (no failures yet)", () => {
    expect(
      deriveCiState({
        checkRuns: [{ status: "queued", conclusion: null }],
        truncated: false,
        status: emptyStatus,
      }),
    ).toBe("pending");
    expect(
      deriveCiState({
        checkRuns: [{ status: "in_progress", conclusion: null }],
        truncated: false,
        status: emptyStatus,
      }),
    ).toBe("pending");
  });

  it("legacy status: 'failure' overrides 'success' from check-runs", () => {
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "success" }],
        truncated: false,
        status: { state: "failure", total_count: 1 },
      }),
    ).toBe("failure");
  });

  it("legacy status: 'error' is treated as failure (builder pass-1 fix — GitHub's combined-status enum includes 'error', and bot's isCIPassing blocks anything != 'success')", () => {
    // Pre-fix, the reducer only branched on literal 'failure', so
    // green check-runs + legacy 'error' fell through to 'success',
    // letting resolve-action merge a PR with a broken external check.
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "success" }],
        truncated: false,
        status: { state: "error", total_count: 1 },
      }),
    ).toBe("failure");
  });

  it("legacy status: unknown value (defensive against GitHub enum expansion) → failure", () => {
    // If GitHub ever adds a new state value, we want fail-closed
    // behavior, not silent merge-eligible.
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "success" }],
        truncated: false,
        status: { state: "neutral_future_value", total_count: 1 },
      }),
    ).toBe("failure");
  });

  it("legacy status: 'pending' counts as pending even when check-runs all succeeded", () => {
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "success" }],
        truncated: false,
        status: { state: "pending", total_count: 1 },
      }),
    ).toBe("pending");
  });

  it("legacy status: 'success' alone (no check-runs) → 'success'", () => {
    expect(
      deriveCiState({
        checkRuns: [],
        truncated: false,
        status: { state: "success", total_count: 1 },
      }),
    ).toBe("success");
  });

  it("legacy status with total_count=0 is ignored regardless of `state`", () => {
    // GitHub returns `state: "pending"` with total_count=0 when no
    // statuses are configured. That must NOT mark the PR as pending.
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "success" }],
        truncated: false,
        status: { state: "pending", total_count: 0 },
      }),
    ).toBe("success");
  });

  it("check-run failure overrides legacy success (failure dominates)", () => {
    expect(
      deriveCiState({
        checkRuns: [{ status: "completed", conclusion: "failure" }],
        truncated: false,
        status: { state: "success", total_count: 1 },
      }),
    ).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// getPullRequestState — integration through the fetch mock
// ---------------------------------------------------------------------------

describe("getPullRequestState", () => {
  it("returns labels + headSha + mergeableState + ciState=success on the happy path", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/42", body: prPayload({ sha: "deadbeef", labels: ["hivemoot:automerge", "ready"] }) },
      {
        match: "/commits/deadbeef/check-runs",
        body: {
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "success" }],
        },
      },
      { match: "/commits/deadbeef/status", body: { state: "success", total_count: 0 } },
    ]);

    const result = await getPullRequestState({
      token: "ghs_test",
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      fetchImpl,
    });

    expect(result).toEqual({
      headSha: "deadbeef",
      labels: ["hivemoot:automerge", "ready"],
      ciState: "success",
      mergeableState: "clean",
    });
  });

  it("throws PullRequestNotFoundError on 404 from /pulls", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/99", body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      getPullRequestState({
        token: "ghs_test",
        owner: "hivemoot",
        repo: "hivemoot",
        prNumber: 99,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PullRequestNotFoundError);
  });

  it("throws GitHubAPIError on non-404, non-2xx response", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/", body: "rate-limited", status: 403 },
    ]);

    await expect(
      getPullRequestState({
        token: "ghs_test",
        owner: "hivemoot",
        repo: "hivemoot",
        prNumber: 42,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(GitHubAPIError);
  });

  it("throws GitHubAPIError if check-runs call fails (PR succeeds, CI lookup explodes)", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/42", body: prPayload() },
      { match: "/check-runs", body: "internal error", status: 500 },
      { match: "/status", body: { state: "success", total_count: 0 } },
    ]);

    await expect(
      getPullRequestState({
        token: "ghs_test",
        owner: "hivemoot",
        repo: "hivemoot",
        prNumber: 42,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(GitHubAPIError);
  });

  it("returns ciState='truncated' when GitHub reports more check-runs than fit (>100)", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/42", body: prPayload() },
      {
        match: "/check-runs",
        body: {
          total_count: 250,
          check_runs: Array.from({ length: 100 }, () => ({
            status: "completed",
            conclusion: "success",
          })),
        },
      },
      { match: "/status", body: { state: "success", total_count: 0 } },
    ]);

    const result = await getPullRequestState({
      token: "ghs_test",
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      fetchImpl,
    });
    expect(result.ciState).toBe("truncated");
  });

  it("returns mergeableState=null when GitHub is still computing it", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/42", body: prPayload({ mergeable_state: null }) },
      { match: "/check-runs", body: { total_count: 0, check_runs: [] } },
      { match: "/status", body: { state: "pending", total_count: 0 } },
    ]);

    const result = await getPullRequestState({
      token: "ghs_test",
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      fetchImpl,
    });
    expect(result.mergeableState).toBeNull();
  });

  it("returns labels=[] when PR has no labels (not undefined / null)", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/42", body: prPayload({ labels: [] }) },
      { match: "/check-runs", body: { total_count: 0, check_runs: [] } },
      { match: "/status", body: { state: "pending", total_count: 0 } },
    ]);

    const result = await getPullRequestState({
      token: "ghs_test",
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      fetchImpl,
    });
    expect(result.labels).toEqual([]);
  });

  it("sends the bearer token + GitHub API version on every call", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe("Bearer ghs_my_token");
      expect(headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(headers?.Accept).toBe("application/vnd.github+json");

      if (url.includes("/pulls/")) {
        return {
          ok: true,
          status: 200,
          json: async () => prPayload(),
          text: async () => "",
        } as Response;
      }
      if (url.includes("/check-runs")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 0, check_runs: [] }),
          text: async () => "",
        } as Response;
      }
      // /status
      return {
        ok: true,
        status: 200,
        json: async () => ({ state: "pending", total_count: 0 }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    await getPullRequestState({
      token: "ghs_my_token",
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("hits the PR endpoint first, then check-runs + status in parallel against the resolved head SHA", async () => {
    // Pin the dependency: PR fetch must complete before CI fetches
    // fire (they need head_sha). The two CI calls are parallel.
    const callOrder: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/pulls/")) {
        callOrder.push("pr");
        return {
          ok: true,
          status: 200,
          json: async () => prPayload({ sha: "feedface" }),
          text: async () => "",
        } as Response;
      }
      if (url.includes("/commits/feedface/check-runs")) {
        callOrder.push("checks");
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 0, check_runs: [] }),
          text: async () => "",
        } as Response;
      }
      if (url.includes("/commits/feedface/status")) {
        callOrder.push("status");
        return {
          ok: true,
          status: 200,
          json: async () => ({ state: "pending", total_count: 0 }),
          text: async () => "",
        } as Response;
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    await getPullRequestState({
      token: "ghs_test",
      owner: "hivemoot",
      repo: "hivemoot",
      prNumber: 42,
      fetchImpl,
    });

    // PR is first; checks + status follow in either order.
    expect(callOrder[0]).toBe("pr");
    expect(callOrder.slice(1).sort()).toEqual(["checks", "status"]);
  });
});

describe("getPullRequestMergeState", () => {
  it("returns GitHub's merged state and merge commit", async () => {
    const fetchImpl = makeFetchMock([
      {
        match: "/pulls/42",
        body: {
          state: "closed",
          merged: true,
          merge_commit_sha: "feedface",
          head: { sha: "deadbeef" },
        },
      },
    ]);

    await expect(
      getPullRequestMergeState({
        token: "ghs_test",
        owner: "hivemoot",
        repo: "hivemoot",
        prNumber: 42,
        fetchImpl,
      }),
    ).resolves.toEqual({
      state: "closed",
      merged: true,
      mergeCommitSha: "feedface",
      headSha: "deadbeef",
    });
  });

  it("throws PullRequestNotFoundError on 404", async () => {
    const fetchImpl = makeFetchMock([
      { match: "/pulls/99", body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      getPullRequestMergeState({
        token: "ghs_test",
        owner: "hivemoot",
        repo: "hivemoot",
        prNumber: 99,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PullRequestNotFoundError);
  });
});
