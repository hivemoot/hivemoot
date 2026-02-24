import { type RepoRef } from "../config/types.js";
import { resolveRepo } from "../github/repo.js";
import { buildPrSnapshot, type PullRequestSnapshotResult } from "../github/workflow.js";

export interface PrSnapshotOptions {
  repo?: string;
  json?: boolean;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

function formatSnapshot(snapshot: PullRequestSnapshotResult): string {
  const linked = snapshot.linkedIssues.length > 0
    ? snapshot.linkedIssues.map((issue) => {
      const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "no-labels";
      return `#${issue.number} (${labels})`;
    }).join(", ")
    : "none";

  const failingRequired = snapshot.checks.requiredFailing.map((check) => check.name);
  const pendingRequired = snapshot.checks.requiredPending.map((check) => check.name);

  const lines = [
    `PR SNAPSHOT — ${formatRepo(snapshot.repo)}#${snapshot.pr.number}`,
    `${snapshot.pr.title}`,
    `linked issues: ${linked}`,
    `mergeable: ${snapshot.pr.mergeable ?? "UNKNOWN"}`,
    `required checks failing: ${failingRequired.length > 0 ? failingRequired.join(", ") : "none"}`,
    `required checks pending: ${pendingRequired.length > 0 ? pendingRequired.join(", ") : "none"}`,
  ];

  if (snapshot.warnings.length > 0) {
    lines.push("warnings:");
    for (const item of snapshot.warnings) {
      lines.push(`- ${item.code}: ${item.message}`);
    }
  }

  return lines.join("\n");
}

export async function prSnapshotCommand(
  prRef: string,
  options: PrSnapshotOptions,
): Promise<void> {
  const repo = await resolveRepo(options.repo);
  const snapshot = await buildPrSnapshot(repo, prRef);

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(formatSnapshot(snapshot));
}
