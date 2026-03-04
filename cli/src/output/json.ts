import type { RepoSummary, RoleConfig, TeamConfig } from "../config/types.js";

function summaryPayload(summary: RepoSummary): Record<string, unknown> {
  const suppressed = new Set(summary.suppressedSections ?? []);
  const s = <T>(key: string, value: T): T | [] => (suppressed.has(key) ? ([] as []) : value);

  return {
    notifications: summary.notifications,
    unackedMentions: summary.unackedMentions ?? [],
    repo: `${summary.repo.owner}/${summary.repo.repo}`,
    currentUser: summary.currentUser,
    driveDiscussion: s("driveDiscussion", summary.driveDiscussion),
    driveImplementation: s("driveImplementation", summary.driveImplementation),
    voteOn: s("voteOn", summary.voteOn),
    discuss: s("discuss", summary.discuss),
    implement: s("implement", summary.implement),
    unclassified: s("unclassified", summary.unclassified ?? []),
    reviewPRs: s("reviewPRs", summary.reviewPRs),
    draftPRs: s("draftPRs", summary.draftPRs),
    addressFeedback: s("addressFeedback", summary.addressFeedback),
    recentlyClosedByYou: summary.recentlyClosedByYou ?? [],
    needsHuman: summary.needsHuman,
    repositoryHealth: summary.repositoryHealth,
    prioritySignals: summary.prioritySignals ?? [],
    ...(summary.focus ? { focus: summary.focus } : {}),
    notes: summary.notes,
  };
}

export function jsonBuzz(
  roleName: string,
  role: RoleConfig,
  summary: RepoSummary,
  onboarding?: string,
): string {
  return JSON.stringify(
    {
      ...(onboarding !== undefined && { onboarding }),
      role: {
        name: roleName,
        description: role.description,
        instructions: role.instructions,
      },
      summary: summaryPayload(summary),
    },
    null,
    2,
  );
}

export function jsonStatus(summary: RepoSummary): string {
  return JSON.stringify(summaryPayload(summary), null, 2);
}

export function jsonRoles(teamConfig: TeamConfig): string {
  const roles = Object.entries(teamConfig.roles).map(([slug, role]) => ({
    name: slug,
    description: role.description,
  }));

  return JSON.stringify({ roles }, null, 2);
}

export function jsonRole(roleName: string, role: RoleConfig, onboarding?: string): string {
  return JSON.stringify(
    {
      ...(onboarding !== undefined && { onboarding }),
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
