import { describe, expect, it } from "vitest";

import {
  buildGroups,
  getGroupStatus,
  type GroupableAgent,
} from "./agent-health-grouping";

function makeAgent(overrides: Partial<GroupableAgent>): GroupableAgent {
  return {
    agent_id: "worker",
    online: true,
    outcome: "success",
    ...overrides,
  };
}

describe("getGroupStatus", () => {
  it("prefers explicit status when provided", () => {
    expect(
      getGroupStatus(
        makeAgent({
          status: "late",
          online: true,
          outcome: "success",
        }),
      ),
    ).toBe("late");
  });

  it("maps offline agents to unknown when status is missing", () => {
    expect(getGroupStatus(makeAgent({ online: false, status: undefined }))).toBe(
      "unknown",
    );
  });

  it("maps failure or timeout outcomes to failed regardless of online state", () => {
    expect(
      getGroupStatus(makeAgent({ outcome: "failure", status: undefined })),
    ).toBe("failed");
    expect(
      getGroupStatus(makeAgent({ outcome: "timeout", status: undefined })),
    ).toBe("failed");
    expect(
      getGroupStatus(
        makeAgent({ outcome: "failure", online: false, status: undefined }),
      ),
    ).toBe("failed");
  });

  it("maps healthy outcomes to ok when status is missing", () => {
    expect(
      getGroupStatus(makeAgent({ outcome: "success", status: undefined })),
    ).toBe("ok");
    expect(getGroupStatus(makeAgent({ outcome: undefined, status: undefined }))).toBe(
      "ok",
    );
  });

  it("keeps success fallback when online is not provided", () => {
    expect(
      getGroupStatus(
        makeAgent({ outcome: "success", online: undefined, status: undefined }),
      ),
    ).toBe("ok");
  });

  it("returns unknown when status, outcome, and online are all missing", () => {
    expect(
      getGroupStatus(
        makeAgent({ outcome: undefined, online: undefined, status: undefined }),
      ),
    ).toBe("unknown");
  });
});

describe("buildGroups", () => {
  it("groups by agent id and sorts groups by worst status then alphabetically", () => {
    const agents = [
      makeAgent({ agent_id: "zeta", status: "failed" }),
      makeAgent({ agent_id: "alpha", status: "failed" }),
      makeAgent({ agent_id: "beta", status: "late" }),
      makeAgent({ agent_id: "gamma", status: "unknown" }),
      makeAgent({ agent_id: "delta", status: "ok" }),
    ];

    const groups = buildGroups(agents);

    // failed first (alpha, zeta alphabetical), then late, unknown, ok.
    expect(groups.map((group) => group.name)).toEqual([
      "alpha",
      "zeta",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  it("collapses repeated agent ids into one group and aggregates status counts", () => {
    const sharedAgent = "worker";
    const agents = [
      makeAgent({ agent_id: sharedAgent, status: "ok" }),
      makeAgent({ agent_id: sharedAgent, status: "late" }),
      makeAgent({ agent_id: "builder", status: "ok" }),
    ];

    const groups = buildGroups(agents);
    const workerGroup = groups.find((group) => group.name === sharedAgent);

    expect(workerGroup).toBeDefined();
    expect(workerGroup?.entries).toHaveLength(2);
    expect(workerGroup?.statusCounts).toEqual({
      failed: 0,
      late: 1,
      unknown: 0,
      ok: 1,
    });
  });
});
