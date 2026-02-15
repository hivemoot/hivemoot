import { describe, it, expect, vi, beforeEach } from "vitest";
import yaml from "js-yaml";
import { CliError } from "./types.js";

vi.mock("../github/client.js", () => ({
  gh: vi.fn(),
}));

import { gh } from "../github/client.js";
import { loadTeamConfig } from "./loader.js";

const mockedGh = vi.mocked(gh);

function encode(yamlContent: string): string {
  return JSON.stringify({ content: Buffer.from(yamlContent).toString("base64") });
}

const validYaml = yaml.dump({
  team: {
    roles: {
      engineer: {
        description: "A software engineer",
        instructions: "Write clean code and tests.",
      },
    },
  },
});

const repo = { owner: "hivemoot", repo: "test-repo" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadTeamConfig", () => {
  it("parses a valid config", async () => {
    mockedGh.mockResolvedValue(encode(validYaml));

    const config = await loadTeamConfig(repo);

    expect(config.roles.engineer).toEqual({
      description: "A software engineer",
      instructions: "Write clean code and tests.",
    });
    expect(mockedGh).toHaveBeenCalledWith([
      "api",
      "repos/hivemoot/test-repo/contents/.github/hivemoot.yml",
    ]);
  });

  it("parses config with multiple roles", async () => {
    const multiRoleYaml = yaml.dump({
      team: {
        name: "My Team",
        roles: {
          engineer: {
            description: "Engineer role",
            instructions: "Build things.",
          },
          reviewer: {
            description: "Reviewer role",
            instructions: "Review things.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(multiRoleYaml));

    const config = await loadTeamConfig(repo);

    expect(Object.keys(config.roles)).toEqual(["engineer", "reviewer"]);
    expect(config.name).toBe("My Team");
  });

  it("parses config with onboarding text", async () => {
    const withOnboarding = yaml.dump({
      team: {
        onboarding: "Welcome to the project.\nRead CONTRIBUTING.md first.",
        roles: {
          engineer: {
            description: "Engineer",
            instructions: "Build things.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(withOnboarding));

    const config = await loadTeamConfig(repo);

    expect(config.onboarding).toBe("Welcome to the project.\nRead CONTRIBUTING.md first.");
  });

  it("returns undefined onboarding when field is absent", async () => {
    mockedGh.mockResolvedValue(encode(validYaml));

    const config = await loadTeamConfig(repo);

    expect(config.onboarding).toBeUndefined();
  });

  it("silently ignores unknown fields", async () => {
    const yamlWithExtras = yaml.dump({
      team: {
        roles: {
          engineer: {
            description: "Engineer",
            instructions: "Do things.",
            model: "gpt-4",
            max_turns: 5,
            unknown_field: true,
          },
        },
      },
      governance: { voting: true },
    });
    mockedGh.mockResolvedValue(encode(yamlWithExtras));

    const config = await loadTeamConfig(repo);

    expect(config.roles.engineer).toEqual({
      description: "Engineer",
      instructions: "Do things.",
    });
  });

  it("throws CONFIG_NOT_FOUND on 404", async () => {
    mockedGh.mockRejectedValue(new CliError("HTTP 404 Not Found", "GH_ERROR"));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
      message: expect.stringContaining("No .github/hivemoot.yml found"),
    });
  });

  it("throws NO_TEAM_CONFIG when team section is missing", async () => {
    const noTeamYaml = yaml.dump({ version: 1 });
    mockedGh.mockResolvedValue(encode(noTeamYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "NO_TEAM_CONFIG",
    });
  });

  it("throws INVALID_CONFIG when roles object is empty", async () => {
    const emptyRolesYaml = yaml.dump({ team: { roles: {} } });
    mockedGh.mockResolvedValue(encode(emptyRolesYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("at least one role"),
    });
  });

  it("throws INVALID_CONFIG for invalid role slug", async () => {
    const badSlugYaml = yaml.dump({
      team: {
        roles: {
          "Invalid-Slug": {
            description: "Bad slug",
            instructions: "Nope.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(badSlugYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("invalid role slug"),
    });
  });

  it("throws INVALID_CONFIG for role slug starting with number", async () => {
    const numSlugYaml = yaml.dump({
      team: {
        roles: {
          "1engineer": {
            description: "Starts with number",
            instructions: "Nope.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(numSlugYaml));

    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("invalid role slug"),
    });
  });

  it("throws INVALID_CONFIG when description is missing", async () => {
    const noDescYaml = yaml.dump({
      team: {
        roles: {
          engineer: {
            instructions: "Do stuff.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(noDescYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("missing a description"),
    });
  });

  it("throws INVALID_CONFIG when instructions is missing", async () => {
    const noInstYaml = yaml.dump({
      team: {
        roles: {
          engineer: {
            description: "An engineer",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(noInstYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("missing instructions"),
    });
  });

  it("throws INVALID_CONFIG when description exceeds 500 chars", async () => {
    const longDescYaml = yaml.dump({
      team: {
        roles: {
          engineer: {
            description: "x".repeat(501),
            instructions: "Do things.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(longDescYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("description exceeds"),
    });
  });

  it("throws INVALID_CONFIG when onboarding is not a string", async () => {
    const badOnboarding = yaml.dump({
      team: {
        onboarding: 42,
        roles: {
          engineer: {
            description: "Engineer",
            instructions: "Build things.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(badOnboarding));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("onboarding must be a string"),
    });
  });

  it("throws INVALID_CONFIG when onboarding exceeds 10000 chars", async () => {
    const longOnboarding = yaml.dump({
      team: {
        onboarding: "x".repeat(10_001),
        roles: {
          engineer: {
            description: "Engineer",
            instructions: "Build things.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(longOnboarding));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("onboarding exceeds"),
    });
  });

  it("accepts onboarding at exact max length", async () => {
    const exactOnboarding = yaml.dump({
      team: {
        onboarding: "o".repeat(10_000),
        roles: {
          engineer: {
            description: "Engineer",
            instructions: "Build things.",
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(exactOnboarding));

    const config = await loadTeamConfig(repo);
    expect(config.onboarding).toHaveLength(10_000);
  });

  it("throws INVALID_CONFIG when instructions exceeds 10000 chars", async () => {
    const longInstYaml = yaml.dump({
      team: {
        roles: {
          engineer: {
            description: "Engineer",
            instructions: "x".repeat(10_001),
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(longInstYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("instructions exceeds"),
    });
  });

  it("throws INVALID_CONFIG for invalid YAML syntax", async () => {
    const badYaml = "{ invalid: yaml: [broken";
    mockedGh.mockResolvedValue(encode(badYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("throws INVALID_CONFIG for non-object YAML", async () => {
    const scalarYaml = "just a string";
    mockedGh.mockResolvedValue(encode(scalarYaml));

    await expect(loadTeamConfig(repo)).rejects.toThrow(CliError);
    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
  });

  it("re-throws non-404 gh errors", async () => {
    const otherError = new CliError("Rate limited", "RATE_LIMITED");
    mockedGh.mockRejectedValue(otherError);

    await expect(loadTeamConfig(repo)).rejects.toBe(otherError);
  });

  it("accepts description and instructions at exact max length", async () => {
    const exactLimitYaml = yaml.dump({
      team: {
        roles: {
          engineer: {
            description: "d".repeat(500),
            instructions: "i".repeat(10_000),
          },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(exactLimitYaml));

    const config = await loadTeamConfig(repo);
    expect(config.roles.engineer.description).toHaveLength(500);
    expect(config.roles.engineer.instructions).toHaveLength(10_000);
  });
});
