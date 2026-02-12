import type { RepoSummary, RoleConfig, TeamConfig } from "../config/types.js";

export function jsonBuzz(
  roleName: string,
  role: RoleConfig,
  summary: RepoSummary,
): string {
  return JSON.stringify(
    {
      role: {
        name: roleName,
        description: role.description,
        instructions: role.instructions,
      },
      summary: {
        repo: `${summary.repo.owner}/${summary.repo.repo}`,
        currentUser: summary.currentUser,
        driveDiscussion: summary.driveDiscussion,
        driveImplementation: summary.driveImplementation,
        voteOn: summary.voteOn,
        discuss: summary.discuss,
        implement: summary.implement,
        unclassified: summary.unclassified ?? [],
        reviewPRs: summary.reviewPRs,
        addressFeedback: summary.addressFeedback,
        needsHuman: summary.needsHuman,
        notes: summary.notes,
      },
    },
    null,
    2,
  );
}

export function jsonStatus(summary: RepoSummary): string {
  return JSON.stringify(
    {
      repo: `${summary.repo.owner}/${summary.repo.repo}`,
      currentUser: summary.currentUser,
      driveDiscussion: summary.driveDiscussion,
      driveImplementation: summary.driveImplementation,
      voteOn: summary.voteOn,
      discuss: summary.discuss,
      implement: summary.implement,
      unclassified: summary.unclassified ?? [],
      reviewPRs: summary.reviewPRs,
      addressFeedback: summary.addressFeedback,
      needsHuman: summary.needsHuman,
      notes: summary.notes,
    },
    null,
    2,
  );
}

export function jsonRoles(teamConfig: TeamConfig): string {
  const roles = Object.entries(teamConfig.roles).map(([slug, role]) => ({
    name: slug,
    description: role.description,
  }));

  return JSON.stringify({ roles }, null, 2);
}

export function jsonRole(roleName: string, role: RoleConfig): string {
  return JSON.stringify(
    {
      role: {
        name: roleName,
        description: role.description,
        instructions: role.instructions,
      },
    },
    null,
    2,
  );
}
