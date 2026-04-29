import { hivemootGet } from "../hivemoot/client.js";
import type {
  SubjectType,
  WatchingRoom,
  WatchingRoomsResponse,
} from "../hivemoot/types.js";

export interface RoomsWatchOptions {
  interval?: number;
  once?: boolean;
  token?: string;
  apiUrl?: string;
  json?: boolean;
}

const SUBJECT_LABEL: Record<SubjectType, string> = {
  pr_review: "pr_review",
  mention_response: "mention",
  issue_triage: "issue",
};

const DEFAULT_INTERVAL_SECS = 30;

/**
 * Pure single-tick poll. Diffs the current `/watching` response
 * against `seen` (mutated in place), emits each newly-appearing
 * room via `emit`, and prunes rooms that have left the watching
 * set so a `subject_updated` re-eligibility produces a fresh emit
 * on the next return.
 *
 * `seen` is keyed by roomId and stores the LAST OBSERVED
 * `WatchingRoom` so removal events carry the room's real prior
 * state (status, subject, participants at the moment it left
 * /watching) instead of fabricated zeros. A room can leave the
 * watching set for several reasons — this role resolved /
 * withdrew, OR the room closed entirely, OR a visibility predicate
 * flipped — and downstream JSON consumers need the actual
 * pre-removal state to log / branch correctly.
 *
 * Extracted for testability — the long-running loop in
 * `roomsWatchCommand` is just `while (!stopped) { pollWatchingOnce; sleep }`.
 */
export async function pollWatchingOnce(args: {
  seen: Map<string, WatchingRoom>;
  emit: (room: WatchingRoom, kind: "new" | "removed") => void;
  fetcher?: () => Promise<WatchingRoomsResponse>;
  options: RoomsWatchOptions;
}): Promise<void> {
  const fetchResp =
    args.fetcher
    ?? (() =>
      hivemootGet<WatchingRoomsResponse>({
        apiUrl: args.options.apiUrl,
        token: args.options.token,
        path: "/api/rooms/watching",
      }));

  const result = await fetchResp();
  const currentIds = new Set(result.rooms.map((r) => r.core.roomId));

  // Emit removals first (so the operator sees "X left" before "Y arrived"
  // when both happen on the same tick — feels more natural in a stream).
  // The emitted room is the LAST OBSERVED state from `seen`, not a
  // fabricated stub — closes #565 builder R1 (downstream JSON
  // consumers were getting status="closed" / zeros for any
  // removal regardless of the actual cause).
  for (const [id, lastSeen] of args.seen) {
    if (!currentIds.has(id)) {
      args.emit(lastSeen, "removed");
      args.seen.delete(id);
    }
  }

  for (const room of result.rooms) {
    const id = room.core.roomId;
    if (!args.seen.has(id)) {
      args.emit(room, "new");
    }
    // Always update the last-seen snapshot so participants /
    // currentSequence on the eventual removal reflect the latest
    // observed state, not whatever was first seen on the new emit.
    args.seen.set(id, room);
  }
}

export function formatNewRoom(room: WatchingRoom): string {
  const subj = SUBJECT_LABEL[room.core.subject_type] ?? room.core.subject_type;
  const participantCount = Object.keys(room.participants).length;
  const participantList =
    participantCount > 0
      ? ` participants=[${Object.entries(room.participants)
          .map(([role, p]) => `${role}:${p.status}`)
          .sort()
          .join(",")}]`
      : "";
  return `[NEW]     [${room.core.status}] ${subj} ${room.core.subject_ref}  room=${room.core.roomId}  seq=${room.currentSequence}${participantList}`;
}

export function formatRemovedRoom(room: WatchingRoom): string {
  return `[REMOVED] room=${room.core.roomId}`;
}

/** Sleep helper using setTimeout. Resolves with `false` after the
 * delay, or `true` if signal triggered. Promise resolves so the
 * loop's await returns and a SIGINT handler can flip the stop flag.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function roomsWatchCommand(
  options: RoomsWatchOptions,
): Promise<void> {
  const intervalMs = (options.interval ?? DEFAULT_INTERVAL_SECS) * 1000;
  const seen = new Map<string, WatchingRoom>();

  const emit = (room: WatchingRoom, kind: "new" | "removed"): void => {
    if (options.json) {
      console.log(JSON.stringify({ event: kind, ...room }));
      return;
    }
    if (kind === "new") {
      console.log(formatNewRoom(room));
    } else {
      console.log(formatRemovedRoom(room));
    }
  };

  // Default-mode header so an operator running with no rooms knows
  // the watcher is alive.
  if (!options.json && !options.once) {
    console.log(
      `WATCHING /api/rooms/watching every ${options.interval ?? DEFAULT_INTERVAL_SECS}s — Ctrl+C to stop`,
    );
  }

  // First tick.
  await pollWatchingOnce({ seen, emit, options });

  if (options.once) return;

  // Long-poll loop — interruptible via SIGINT (Node's default
  // behavior on Ctrl+C kills the process; we don't need explicit
  // signal handling for V1).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(intervalMs);
    try {
      await pollWatchingOnce({ seen, emit, options });
    } catch (err) {
      // Transient errors (network blip, 5xx) shouldn't kill the
      // loop — log and keep watching. Auth errors (CliError exit 2)
      // would also land here; for those the operator likely wants
      // to know AND keep retrying isn't useful, but for V1 the
      // simpler "always continue" is the consistent choice. Operator
      // can Ctrl+C if they see a stream of auth errors.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[watch] poll failed: ${msg}`);
    }
  }
}
