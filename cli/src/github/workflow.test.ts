import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "./client.js";
import { buildPrPreflight, buildPrSnapshot } from "./workflow.js";

const mockedGh = vi.mocked(gh);
const repo = { owner: "hivemoot", repo: "hivemoot" };

function loadFixture(name: string): unknown {
  const path = new URL(`./__fixtures__/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPrSnapshot()", () => {
  it("emits schemaVersioned snapshot JSON contract", async () => {
    mockedGh
      .mockResolvedValueOnce(JSON.stringify({ number: 54 }))
      .mockResolvedValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 54,
                title: "CLI: add PR/issue workflow commands for agent robustness",
                url: "https://github.com/hivemoot/hivemoot/pull/54",
                state: "OPEN",
                isDraft: false,
                mergeable: "UNKNOWN",
                reviewDecision: "REVIEW_REQUIRED",
                createdAt: "2026-02-19T00:00:00Z",
                updatedAt: "2026-02-19T00:05:00Z",
                headRefName: "worker/issue-54-cli-workflow-v1",
                baseRefName: "main",
                author: { login: "hivemoot-worker" },
                closingIssuesReferences: {
                  nodes: [
                    {
                      number: 54,
                      title: "CLI: add PR/issue workflow commands for agent robustness",
                      url: "https://github.com/hivemoot/hivemoot/issues/54",
                      state: "OPEN",
                      labels: { nodes: [{ name: "hivemoot:ready-to-implement" }] },
                    },
                    {
                      number: 43,
                      title: "Blocker: Agent accounts lack push access to submit implementations",
                      url: "https://github.com/hivemoot/hivemoot/issues/43",
                      state: "OPEN",
                      labels: { nodes: [{ name: "hivemoot:discussion" }] },
                    },
                  ],
                },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "typecheck-test-build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        isRequired: true,
                      },
                      {
                        __typename: "StatusContext",
                        context: "lint",
                        state: "PENDING",
                        isRequired: true,
                      },
                      {
                        __typename: "StatusContext",
                        context: "optional-check",
                        state: "FAILURE",
                        isRequired: false,
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      );

    const snapshot = await buildPrSnapshot(repo, "54", "2026-02-19T00:00:00.000Z");
    expect(snapshot).toEqual(loadFixture("workflow-pr-snapshot.json"));
  });
});

describe("buildPrPreflight()", () => {
  it("returns deterministic blocker codes and pass=false when blocked", async () => {
    mockedGh
      .mockResolvedValueOnce(JSON.stringify({ number: 36 }))
      .mockResolvedValueOnce(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 36,
                title: "Clarify accepted closing-keyword link formats",
                url: "https://github.com/hivemoot/hivemoot/pull/36",
                state: "OPEN",
                isDraft: false,
                mergeable: "CONFLICTING",
                reviewDecision: null,
                createdAt: "2026-02-17T03:20:00Z",
                updatedAt: "2026-02-18T16:44:33Z",
                headRefName: "codex/generalize-linking-guidance",
                baseRefName: "main",
                author: { login: "hivemoot" },
                closingIssuesReferences: { nodes: [] },
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "typecheck-test-build",
                        status: "COMPLETED",
                        conclusion: "FAILURE",
                        isRequired: true,
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      );

    const preflight = await buildPrPreflight(repo, "36", "2026-02-19T00:00:00.000Z");
    expect(preflight).toEqual(loadFixture("workflow-pr-preflight-blocked.json"));
  });
});
