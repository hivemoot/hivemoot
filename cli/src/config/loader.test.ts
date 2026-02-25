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

function deepNestingYaml(levels: number): string {
  const lines = [
    "team:",
    "  roles:",
    "    engineer:",
    "      description: Engineer",
    "      instructions: Build things.",
    "  extra:",
  ];

  for (let i = 0; i < levels; i += 1) {
    lines.push(`${"  ".repeat(i + 2)}layer${i}:`);
  }
  lines.push(`${"  ".repeat(levels + 2)}leaf: value`);

  return `${lines.join("\n")}\n`;
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

  it("uses hardened YAML parser options", async () => {
    mockedGh.mockResolvedValue(encode(validYaml));
    const loadSpy = vi.spyOn(yaml, "load");

    await loadTeamConfig(repo);

    expect(loadSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        schema: yaml.JSON_SCHEMA,
        listener: expect.any(Function),
      }),
    );
    loadSpy.mockRestore();
  });

  it("allows YAML aliases with a low anchor count", async () => {
    const aliasYaml = `
shared: &shared
  description: Engineer
  instructions: Build things.
team:
  roles:
    engineer: *shared
`;
    mockedGh.mockResolvedValue(encode(aliasYaml));

    const config = await loadTeamConfig(repo);
    expect(config.roles.engineer).toEqual({
      description: "Engineer",
      instructions: "Build things.",
    });
  });

  it("rejects excessive YAML anchors (over 100)", async () => {
    const anchors = Array.from({ length: 101 }, (_, i) =>
      `a${i}: &a${i}\n  description: Role ${i}\n  instructions: Do things.`,
    ).join("\n");
    const refs = Array.from({ length: 101 }, (_, i) =>
      `role${i}: *a${i}`,
    ).join("\n    ");
    const aliasYaml = `${anchors}\nteam:\n  roles:\n    ${refs}\n`;
    mockedGh.mockResolvedValue(encode(aliasYaml));

    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("YAML anchors exceed maxAnchorCount (100)"),
    });
  });

  it("rejects overly nested YAML", async () => {
    mockedGh.mockResolvedValue(encode(deepNestingYaml(45)));

    await expect(loadTeamConfig(repo)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("invalid YAML"),
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

  // ── team.focus parsing ──────────────────────────────────────────

  it("parses focus.default as a string", async () => {
    const focusYaml = yaml.dump({
      team: {
        focus: { default: "Focus on PR reviews first." },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Focus on PR reviews first.");
  });

  it("returns undefined focus when focus key is absent", async () => {
    mockedGh.mockResolvedValue(encode(validYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("returns undefined focus when focus is a plain string (not nested object)", async () => {
    const flatFocusYaml = yaml.dump({
      team: {
        focus: "prs-only",
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(flatFocusYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("returns undefined focus when focus.default is missing", async () => {
    const noDefaultYaml = yaml.dump({
      team: {
        focus: { other: "value" },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(noDefaultYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("returns undefined focus when focus.default is empty or whitespace", async () => {
    const emptyDefaultYaml = yaml.dump({
      team: {
        focus: { default: "   " },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(emptyDefaultYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("trims whitespace from focus.default", async () => {
    const paddedYaml = yaml.dump({
      team: {
        focus: { default: "  Review PRs  " },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(paddedYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Review PRs");
  });

  it("returns undefined focus when focus.default is not a string", async () => {
    const numericDefaultYaml = yaml.dump({
      team: {
        focus: { default: 42 },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(numericDefaultYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("returns undefined focus when focus is an array", async () => {
    const arrayFocusYaml = yaml.dump({
      team: {
        focus: ["prs", "issues"],
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(arrayFocusYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  // ── team.focuses (new format) ────────────────────────────────────

  it("resolves focus from activeFocus + focuses block", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "routine-maintenance",
        focuses: {
          default: { objective: "Work on any ready-to-implement issue." },
          "routine-maintenance": { objective: "Clear the review queue. No new code." },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Clear the review queue. No new code.");
  });

  it("falls back to default block when activeFocus is absent", async () => {
    const focusesYaml = yaml.dump({
      team: {
        focuses: {
          default: { objective: "Work on any ready-to-implement issue." },
          "routine-maintenance": { objective: "Clear the review queue." },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Work on any ready-to-implement issue.");
  });

  it("falls back to defaultFocus when activeFocus block is missing", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "nonexistent",
        defaultFocus: "routine-maintenance",
        focuses: {
          "routine-maintenance": { objective: "Clear the review queue." },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Clear the review queue.");
  });

  it("returns undefined when focuses is present but all candidates are missing", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "nonexistent",
        focuses: {
          other: { objective: "Something else." },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("trims whitespace from focus block objective", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "default",
        focuses: {
          default: { objective: "  Review PRs first.  " },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Review PRs first.");
  });

  it("ignores focuses block with non-object entries", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "default",
        focuses: {
          default: "not an object",
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("prefers focuses over legacy focus.default when both are present", async () => {
    const bothYaml = yaml.dump({
      team: {
        activeFocus: "default",
        focuses: {
          default: { objective: "New format objective." },
        },
        focus: { default: "Old format objective." },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(bothYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("New format objective.");
  });

  it("accepts focus objective at exactly max length (2000 chars)", async () => {
    const obj = "x".repeat(2_000);
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "default",
        focuses: {
          default: { objective: obj },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe(obj);
  });

  it("skips focus objective exceeding max length (2001 chars)", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "default",
        focuses: {
          default: { objective: "x".repeat(2_001) },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("skips focus block with name exceeding max length (65 chars)", async () => {
    const longName = "a".repeat(65);
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: longName,
        focuses: {
          [longName]: { objective: "Something." },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("ignores legacy focus.default when focuses is present but all candidates miss", async () => {
    // focuses takes precedence when present; if all candidates miss, the result
    // is undefined rather than falling back to legacy focus.default.
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "nonexistent",
        focuses: {
          other: { objective: "Something else." },
        },
        focus: { default: "This valid legacy value is intentionally ignored." },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBeUndefined();
  });

  it("resolves from default key when activeFocus misses and defaultFocus is absent", async () => {
    const focusesYaml = yaml.dump({
      team: {
        activeFocus: "nonexistent",
        focuses: {
          default: { objective: "Fallback via default key." },
        },
        roles: {
          engineer: { description: "Engineer", instructions: "Build things." },
        },
      },
    });
    mockedGh.mockResolvedValue(encode(focusesYaml));

    const config = await loadTeamConfig(repo);

    expect(config.focus).toBe("Fallback via default key.");
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
