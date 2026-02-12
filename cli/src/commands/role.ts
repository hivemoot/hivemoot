import { loadTeamConfig } from "../config/loader.js";
import { CliError, type RoleOptions, type RoleConfig, type TeamConfig } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { formatRole } from "../output/formatter.js";
import { jsonRole } from "../output/json.js";

function resolveRoleConfig(teamConfig: TeamConfig, roleName: string): RoleConfig {
  if (!Object.hasOwn(teamConfig.roles, roleName)) {
    const available = Object.keys(teamConfig.roles).join(", ");
    throw new CliError(
      `ROLE_NOT_FOUND: Role '${roleName}' not found. Available: ${available}. Run: hivemoot roles`,
      "ROLE_NOT_FOUND",
      1,
    );
  }

  return teamConfig.roles[roleName];
}

export async function roleCommand(roleName: string, options: RoleOptions): Promise<void> {
  const repo = await resolveRepo(options.repo);
  const teamConfig = await loadTeamConfig(repo);
  const role = resolveRoleConfig(teamConfig, roleName);

  if (options.json) {
    console.log(jsonRole(roleName, role));
  } else {
    console.log(formatRole(roleName, role, `${repo.owner}/${repo.repo}`));
  }
}
