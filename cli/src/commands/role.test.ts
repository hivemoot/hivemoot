import { describe, it, expect, vi, beforeEach } from "vitest";
import { CliError, type TeamConfig } from "../config/types.js";

vi.mock("../config/loader.js", () => ({
  loadTeamConfig: vi.fn(),
}));

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

import { loadTeamConfig } from "../config/loader.js";
import { resolveRepo } from "../github/repo.js";
import { roleCommand } from "./role.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedLoadTeamConfig = vi.mocked(loadTeamConfig);

const testTeamConfig: TeamConfig = {
  onboarding: "Welcome to the project.\nRead CONTRIBUTING.md for the workflow.",
  roles: {
    worker: {
      description: "Builds and ships features",
      instructions: "Pick one task and finish it end-to-end.",
    },
    reviewer: {
      description: "Reviews pull requests",
      instructions: "Focus on regressions and missing tests.",
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue({ owner: "hivemoot", repo: "colony" });
  mockedLoadTeamConfig.mockResolvedValue(testTeamConfig);
});

describe("roleCommand", () => {
  it("returns expected payload for a valid role", async () => {
    await roleCommand("worker", {});

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("ONBOARDING:");
    expect(output).toContain("Welcome to the project.");
    expect(output).toContain("ROLE — hivemoot/colony");
    expect(output).toContain("Name: worker");
    expect(output).toContain("Description: Builds and ships features");
    expect(output).toContain("Instructions:");
    expect(output).toContain("Pick one task and finish it end-to-end.");
  });

  it("fails with ROLE_NOT_FOUND for an unknown role", async () => {
    await expect(roleCommand("not_a_role", {})).rejects.toThrow(CliError);
    await expect(roleCommand("not_a_role", {})).rejects.toMatchObject({
      code: "ROLE_NOT_FOUND",
      message: expect.stringContaining("ROLE_NOT_FOUND"),
    });
  });

  it("returns role JSON when --json is set", async () => {
    await roleCommand("worker", { json: true });

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      onboarding: "Welcome to the project.\nRead CONTRIBUTING.md for the workflow.",
      role: {
        name: "worker",
        description: "Builds and ships features",
        instructions: "Pick one task and finish it end-to-end.",
      },
    });
  });

  it("omits onboarding from JSON when not configured", async () => {
    mockedLoadTeamConfig.mockResolvedValue({
      roles: testTeamConfig.roles,
    });

    await roleCommand("worker", { json: true });

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed).not.toHaveProperty("onboarding");
  });

  it("passes --repo flag through resolveRepo", async () => {
    await roleCommand("worker", { repo: "owner/custom-repo" });

    expect(mockedResolveRepo).toHaveBeenCalledWith("owner/custom-repo");
  });
});
