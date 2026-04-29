import { CliError } from "../config/types.js";
import { hivemootGet } from "../hivemoot/client.js";
import type {
  ListedRoom,
  ListRoomsResponse,
  SubjectType,
} from "../hivemoot/types.js";

export interface RoomsListOptions {
  limit?: number;
  token?: string;
  apiUrl?: string;
  json?: boolean;
}

const SUBJECT_LABEL: Record<SubjectType, string> = {
  pr_review: "pr_review",
  mention_response: "mention",
  issue_triage: "issue",
};

/**
 * Best-effort relative time. ISO inputs that fail to parse fall back
 * to the raw string so the human reader still sees *something*.
 */
function relativeTime(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 48) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 14) return `${diffDay}d ago`;
  return iso.slice(0, 10);
}

export function formatRoomsList(rooms: readonly ListedRoom[]): string {
  const lines: string[] = [`WAR ROOMS — ${rooms.length} room${rooms.length === 1 ? "" : "s"}`];

  if (rooms.length === 0) {
    lines.push("(no rooms in this installation)");
    return lines.join("\n");
  }

  lines.push("");
  for (const room of rooms) {
    const subj = SUBJECT_LABEL[room.subject_type] ?? room.subject_type;
    const opened = relativeTime(room.opened_at);
    const closedSuffix = room.closed_at
      ? `, closed ${relativeTime(room.closed_at)}${room.closed_reason ? ` (${room.closed_reason})` : ""}`
      : "";
    lines.push(
      `[${room.status}] ${subj} ${room.subject_ref} — opened ${opened}${closedSuffix}`,
    );
    lines.push(`  roomId: ${room.roomId}  manager: ${room.manager}`);
  }

  return lines.join("\n");
}

export async function roomsListCommand(
  options: RoomsListOptions,
): Promise<void> {
  // Server clamps `limit` to [1, 200]; surface the obvious caller mistake
  // before a round-trip rather than shipping noise to the API.
  if (options.limit !== undefined && (options.limit < 1 || options.limit > 200)) {
    throw new CliError(
      "limit must be between 1 and 200",
      "INVALID_OPTION",
      1,
    );
  }

  const result = await hivemootGet<ListRoomsResponse>({
    apiUrl: options.apiUrl,
    token: options.token,
    path: "/api/rooms",
    query: { limit: options.limit },
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatRoomsList(result.rooms));
  }
}
