import { CliError } from "../config/types.js";
import { hivemootGet } from "../hivemoot/client.js";
import type { RoomEvent, RoomEventsResponse } from "../hivemoot/types.js";

export interface RoomsEventsOptions {
  since?: number;
  limit?: number;
  token?: string;
  apiUrl?: string;
  json?: boolean;
}

const ROOM_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatEvents(roomId: string, events: readonly RoomEvent[]): string {
  const lines: string[] = [];
  lines.push(`WAR ROOM EVENTS ${roomId} — ${events.length} event${events.length === 1 ? "" : "s"}`);
  if (events.length === 0) {
    lines.push("(no events in range)");
    return lines.join("\n");
  }
  lines.push("");
  for (const ev of events) {
    lines.push(
      `#${ev.seq}  ${ev.timestamp}  ${ev.event_type}  by ${ev.actor_role}/${ev.actor_id}`,
    );
    // Body is event-type-specific (bounded ≤ 8 KiB serialized per
    // server). Render compact JSON on a continuation line so
    // operators see what changed without losing single-line
    // grep-ability of the headline.
    if (Object.keys(ev.body).length > 0) {
      lines.push(`    body: ${JSON.stringify(ev.body)}`);
    }
  }
  return lines.join("\n");
}

export async function roomsEventsCommand(
  roomId: string,
  options: RoomsEventsOptions,
): Promise<void> {
  if (!ROOM_ID_REGEX.test(roomId)) {
    throw new CliError(
      `roomId must be a UUIDv4 (e.g. 8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef); got ${JSON.stringify(roomId)}`,
      "INVALID_OPTION",
      1,
    );
  }
  if (options.since !== undefined && options.since < 0) {
    throw new CliError(
      "--since must be a non-negative integer (seq cursor)",
      "INVALID_OPTION",
      1,
    );
  }
  // Server clamps `limit` to [1, 500]; surface obvious mistakes
  // before a round-trip.
  if (options.limit !== undefined && (options.limit < 1 || options.limit > 500)) {
    throw new CliError(
      "--limit must be between 1 and 500",
      "INVALID_OPTION",
      1,
    );
  }

  const result = await hivemootGet<RoomEventsResponse>({
    apiUrl: options.apiUrl,
    token: options.token,
    path: `/api/rooms/${roomId}/events`,
    query: { since: options.since, limit: options.limit },
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatEvents(result.roomId, result.events));
  }
}
