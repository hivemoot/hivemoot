import type { RolesOptions } from "../config/types.js";
import { loadTeamConfig } from "../config/loader.js";
import { resolveRepo } from "../github/repo.js";
import { formatRoles } from "../output/formatter.js";
import { jsonRoles } from "../output/json.js";

export async function rolesCommand(options: RolesOptions): Promise<void> {
  const repo = await resolveRepo(options.repo);
  const teamConfig = await loadTeamConfig(repo);

  if (options.json) {
    console.log(jsonRoles(teamConfig));
  } else {
    console.log(formatRoles(teamConfig, `${repo.owner}/${repo.repo}`));
  }
}
