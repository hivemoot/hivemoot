import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/loader.js", () => ({
  loadTeamConfig: vi.fn(),
}));

vi.mock("../github/repo.js", () => ({
  resolveRepo: vi.fn(),
}));

vi.mock("../output/formatter.js", () => ({
  formatRoles: vi.fn(),
}));

vi.mock("../output/json.js", () => ({
  jsonRoles: vi.fn(),
}));

import { loadTeamConfig } from "../config/loader.js";
import { resolveRepo } from "../github/repo.js";
import { formatRoles } from "../output/formatter.js";
import { jsonRoles } from "../output/json.js";
import { rolesCommand } from "./roles.js";
import type { TeamConfig } from "../config/types.js";

const mockedResolveRepo = vi.mocked(resolveRepo);
const mockedLoadTeamConfig = vi.mocked(loadTeamConfig);
const mockedFormatRoles = vi.mocked(formatRoles);
const mockedJsonRoles = vi.mocked(jsonRoles);

const testTeamConfig: TeamConfig = {
  roles: {
    engineer: {
      description: "Engineer role",
      instructions: "Build things.",
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveRepo.mockResolvedValue({ owner: "hivemoot", repo: "test" });
  mockedLoadTeamConfig.mockResolvedValue(testTeamConfig);
});

describe("rolesCommand", () => {
  it("outputs formatted text by default", async () => {
    mockedFormatRoles.mockReturnValue("Roles:\n  engineer — Engineer role");

    await rolesCommand({});

    expect(mockedResolveRepo).toHaveBeenCalledWith(undefined);
    expect(mockedLoadTeamConfig).toHaveBeenCalledWith({ owner: "hivemoot", repo: "test" });
    expect(mockedFormatRoles).toHaveBeenCalledWith(testTeamConfig, "hivemoot/test");
    expect(console.log).toHaveBeenCalledWith("Roles:\n  engineer — Engineer role");
  });

  it("outputs JSON when --json flag is set", async () => {
    mockedJsonRoles.mockReturnValue('{"roles":{"engineer":{}}}');

    await rolesCommand({ json: true });

    expect(mockedJsonRoles).toHaveBeenCalledWith(testTeamConfig);
    expect(console.log).toHaveBeenCalledWith('{"roles":{"engineer":{}}}');
    expect(mockedFormatRoles).not.toHaveBeenCalled();
  });

  it("passes --repo flag to resolveRepo", async () => {
    mockedFormatRoles.mockReturnValue("output");

    await rolesCommand({ repo: "owner/custom-repo" });

    expect(mockedResolveRepo).toHaveBeenCalledWith("owner/custom-repo");
  });
});
