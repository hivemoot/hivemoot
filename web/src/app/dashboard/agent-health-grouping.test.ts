import { describe, expect, it } from "vitest";

import {
  buildGroups,
  getGroupStatus,
  type GroupableAgent,
} from "./agent-health-grouping";

function makeAgent(overrides: Partial<GroupableAgent>): GroupableAgent {
  return {
    agent_id: "worker",
    repo: "hivemoot/hivemoot",
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
  it("groups by repo and sorts groups by worst status then alphabetically", () => {
    const agents = [
      makeAgent({ agent_id: "a", repo: "z/repo", status: "failed" }),
      makeAgent({ agent_id: "b", repo: "a/repo", status: "failed" }),
      makeAgent({ agent_id: "c", repo: "b/repo", status: "late" }),
      makeAgent({ agent_id: "d", repo: "c/repo", status: "unknown" }),
      makeAgent({ agent_id: "e", repo: "d/repo", status: "ok" }),
      makeAgent({ agent_id: "f", repo: "d/repo", status: "failed" }),
    ];

    const groups = buildGroups(agents, "repo");

    expect(groups.map((group) => group.name)).toEqual([
      "a/repo",
      "d/repo",
      "z/repo",
      "b/repo",
      "c/repo",
    ]);

    const mixedStatusGroup = groups.find((group) => group.name === "d/repo");
    expect(mixedStatusGroup?.statusCounts).toEqual({
      failed: 1,
      late: 0,
      unknown: 0,
      ok: 1,
    });
  });

  it("groups by agent id in agent mode", () => {
    const sharedAgent = "worker";
    const agents = [
      makeAgent({ agent_id: sharedAgent, repo: "hivemoot/hivemoot", status: "ok" }),
      makeAgent({ agent_id: sharedAgent, repo: "hivemoot/colony", status: "late" }),
      makeAgent({ agent_id: "builder", repo: "hivemoot/colony", status: "ok" }),
    ];

    const groups = buildGroups(agents, "agent");
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
