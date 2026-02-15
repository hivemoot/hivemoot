import yaml from "js-yaml";
import { gh } from "../github/client.js";
import type { HivemootConfig, TeamConfig, RepoRef, RoleConfig } from "./types.js";
import { CliError } from "./types.js";

const ROLE_SLUG_RE = /^[a-z][a-z0-9_]{0,49}$/;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 10_000;
const MAX_ONBOARDING_LENGTH = 10_000;

function validateTeamConfig(raw: HivemootConfig): TeamConfig {
  if (!raw.team) {
    throw new CliError(
      "No team config in .github/hivemoot.yml. Run: hivemoot init",
      "NO_TEAM_CONFIG",
      1,
    );
  }

  const { team } = raw;

  if (team.onboarding !== undefined) {
    if (typeof team.onboarding !== "string") {
      throw new CliError(
        "Config error: team.onboarding must be a string",
        "INVALID_CONFIG",
        1,
      );
    }

    if (team.onboarding.length > MAX_ONBOARDING_LENGTH) {
      throw new CliError(
        `Config error: team.onboarding exceeds ${MAX_ONBOARDING_LENGTH} characters`,
        "INVALID_CONFIG",
        1,
      );
    }
  }

  if (!team.roles || typeof team.roles !== "object" || Object.keys(team.roles).length === 0) {
    throw new CliError(
      "Config error: team.roles must contain at least one role",
      "INVALID_CONFIG",
      1,
    );
  }

  const validatedRoles: Record<string, RoleConfig> = {};

  for (const [slug, role] of Object.entries(team.roles)) {
    if (!ROLE_SLUG_RE.test(slug)) {
      throw new CliError(
        `Config error: invalid role slug "${slug}" — must match /^[a-z][a-z0-9_]{0,49}$/`,
        "INVALID_CONFIG",
        1,
      );
    }

    if (typeof role !== "object" || role === null) {
      throw new CliError(
        `Config error: role "${slug}" must be an object`,
        "INVALID_CONFIG",
        1,
      );
    }

    const r = role as unknown as Record<string, unknown>;

    if (typeof r.description !== "string" || r.description.length === 0) {
      throw new CliError(
        `Config error: role "${slug}" is missing a description`,
        "INVALID_CONFIG",
        1,
      );
    }

    if (r.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new CliError(
        `Config error: role "${slug}" description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
        "INVALID_CONFIG",
        1,
      );
    }

    if (typeof r.instructions !== "string" || r.instructions.length === 0) {
      throw new CliError(
        `Config error: role "${slug}" is missing instructions`,
        "INVALID_CONFIG",
        1,
      );
    }

    if (r.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      throw new CliError(
        `Config error: role "${slug}" instructions exceeds ${MAX_INSTRUCTIONS_LENGTH} characters`,
        "INVALID_CONFIG",
        1,
      );
    }

    validatedRoles[slug] = {
      description: r.description,
      instructions: r.instructions,
    };
  }

  return {
    name: typeof team.name === "string" ? team.name : undefined,
    onboarding: typeof team.onboarding === "string" ? team.onboarding : undefined,
    roles: validatedRoles,
  };
}

export async function loadTeamConfig(repo: RepoRef): Promise<TeamConfig> {
  let rawJson: string;

  try {
    rawJson = await gh([
      "api",
      `repos/${repo.owner}/${repo.repo}/contents/.github/hivemoot.yml`,
    ]);
  } catch (err) {
    if (err instanceof Error && /404|Not Found/i.test(err.message)) {
      throw new CliError(
        "No .github/hivemoot.yml found. Run: hivemoot init",
        "CONFIG_NOT_FOUND",
        1,
      );
    }
    throw err;
  }

  let content: string;
  try {
    const parsed = JSON.parse(rawJson);
    content = Buffer.from(parsed.content, "base64").toString("utf-8");
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new CliError(
      `Config error: failed to decode .github/hivemoot.yml content${detail}`,
      "INVALID_CONFIG",
      1,
    );
  }

  let config: HivemootConfig;
  try {
    config = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as HivemootConfig;
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : "";
    throw new CliError(
      `Config error: invalid YAML in .github/hivemoot.yml${detail}`,
      "INVALID_CONFIG",
      1,
    );
  }

  if (typeof config !== "object" || config === null) {
    throw new CliError(
      "Config error: .github/hivemoot.yml must be a YAML object",
      "INVALID_CONFIG",
      1,
    );
  }

  return validateTeamConfig(config);
}
