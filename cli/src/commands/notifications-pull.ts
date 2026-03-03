import { CliError } from "../config/types.js";
import { fetchNotificationsPull, type NotificationsPullResult } from "../github/fetch-notifications.js";

export interface NotificationsPullOptions {
  repo: string;
  reason?: string;
  stateFile?: string;
  json?: boolean;
}

function formatResult(result: NotificationsPullResult): string {
  const lines: string[] = [
    `NOTIFICATIONS PULL — ${result.repo}`,
    `reasons: ${result.reasons.join(", ")}`,
    `count: ${result.notifications.length}`,
  ];

  if (result.notifications.length === 0) {
    lines.push("(no unread notifications)");
    return lines.join("\n");
  }

  lines.push("");
  for (const n of result.notifications) {
    const label = `${n.itemType ?? "Unknown"} #${n.number ?? "?"}`;
    lines.push(`[${n.reason}] ${label}: ${n.title}`);
    if (n.url) {
      lines.push(`  ${n.url}`);
    }
    lines.push(`  threadId: ${n.threadId}  updatedAt: ${n.updatedAt}`);
  }

  return lines.join("\n");
}

export async function notificationsPullCommand(
  options: NotificationsPullOptions,
): Promise<void> {
  const rawReasons = options.reason ?? "*";
  const reasons = rawReasons
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  if (reasons.length === 0) {
    throw new CliError(
      "At least one reason is required (or use \"*\" for all reasons).",
      "GH_ERROR",
      1,
    );
  }

  let result: NotificationsPullResult;
  try {
    result = await fetchNotificationsPull(
      options.repo,
      reasons,
      options.stateFile,
    );
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(err.message, err.code, Math.max(err.exitCode, 3));
    }
    throw new CliError(
      err instanceof Error ? err.message : String(err),
      "GH_ERROR",
      3,
    );
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatResult(result));
  }
}
