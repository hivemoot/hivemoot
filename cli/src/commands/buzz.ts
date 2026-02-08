import { CliError, type BuzzOptions } from "../config/types.js";
import { loadTeamConfig } from "../config/loader.js";
import { resolveRepo } from "../github/repo.js";
import { fetchIssues } from "../github/issues.js";
import { fetchPulls } from "../github/pulls.js";
import { fetchCurrentUser } from "../github/user.js";
import { buildSummary } from "../summary/builder.js";
import { formatBuzz, formatStatus } from "../output/formatter.js";
import { jsonBuzz, jsonStatus } from "../output/json.js";

export async function buzzCommand(options: BuzzOptions): Promise<void> {
  const repo = await resolveRepo(options.repo);
  const fetchLimit = options.fetchLimit ?? 200;

  const [issues, prs, currentUser] = await Promise.all([
    fetchIssues(repo, fetchLimit),
    fetchPulls(repo, fetchLimit),
    fetchCurrentUser(),
  ]);

  const summary = buildSummary(repo, issues, prs, currentUser);

  if (issues.length >= fetchLimit) {
    summary.notes.push(`Only the first ${fetchLimit} issues were fetched. Use --fetch-limit to increase.`);
  }
  if (prs.length >= fetchLimit) {
    summary.notes.push(`Only the first ${fetchLimit} PRs were fetched. Use --fetch-limit to increase.`);
  }

  if (options.role) {
    const teamConfig = await loadTeamConfig(repo);
    if (!Object.hasOwn(teamConfig.roles, options.role)) {
      const available = Object.keys(teamConfig.roles).join(", ");
      throw new CliError(
        `Role '${options.role}' not found. Available: ${available}. Run: hivemoot roles`,
        "ROLE_NOT_FOUND",
        1,
      );
    }
    const roleConfig = teamConfig.roles[options.role];

    if (options.json) {
      console.log(jsonBuzz(options.role, roleConfig, summary));
    } else {
      console.log(formatBuzz(options.role, roleConfig, summary, options.limit));
    }
  } else {
    if (options.json) {
      console.log(jsonStatus(summary));
    } else {
      console.log(formatStatus(summary, options.limit));
    }
  }
}
