import { CliError } from "../config/types.js";
import { hivemootGet } from "../hivemoot/client.js";
import { ROOM_ID_REGEX } from "../hivemoot/types.js";
import type { RoomCore, SubjectType } from "../hivemoot/types.js";

export interface RoomsGetOptions {
  token?: string;
  apiUrl?: string;
  json?: boolean;
}

const SUBJECT_LABEL: Record<SubjectType, string> = {
  pr_review: "pr_review",
  mention_response: "mention",
  issue_triage: "issue",
};

export function formatRoom(roomId: string, room: RoomCore): string {
  const lines: string[] = [];
  const subj = SUBJECT_LABEL[room.subject_type] ?? room.subject_type;
  lines.push(`WAR ROOM ${roomId}`);
  lines.push(`  status:  ${room.status}`);
  lines.push(`  subject: ${subj} ${room.subject_ref}`);
  lines.push(`  manager: ${room.manager}`);
  lines.push(`  opened:  ${room.opened_at}`);
  if (room.closed_at) {
    const reason = room.closed_reason ? ` (${room.closed_reason})` : "";
    lines.push(`  closed:  ${room.closed_at}${reason}`);
  }
  if (room.deciding_through_sequence !== undefined) {
    lines.push(`  deciding_through_seq: ${room.deciding_through_sequence}`);
  }
  if (room.decision) {
    lines.push(
      `  decision: synthesized ${room.decision.synthesized_at} by ${room.decision.synthesis_runner} at seq=${room.decision.sequence_closed}`,
    );
  }
  lines.push(
    `  timing:  max_age=${room.timing_config.max_age_secs}s drop=${room.timing_config.drop_threshold_secs}s quiet=${room.timing_config.quiet_period_secs}s`,
  );
  return lines.join("\n");
}

export async function roomsGetCommand(
  roomId: string,
  options: RoomsGetOptions,
): Promise<void> {
  if (!ROOM_ID_REGEX.test(roomId)) {
    throw new CliError(
      `roomId must be a UUIDv4 (e.g. 8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef); got ${JSON.stringify(roomId)}`,
      "INVALID_OPTION",
      1,
    );
  }

  const room = await hivemootGet<RoomCore>({
    apiUrl: options.apiUrl,
    token: options.token,
    path: `/api/rooms/${roomId}`,
  });

  if (options.json) {
    // Emit `{ roomId, ...room }` so the JSON output associates the
    // input id with the response (mirrors how list returns
    // RoomCoreWithId — symmetry across `list` and `get`).
    console.log(JSON.stringify({ roomId, ...room }, null, 2));
  } else {
    console.log(formatRoom(roomId, room));
  }
}
