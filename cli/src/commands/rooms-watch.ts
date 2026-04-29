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
 * Extracted for testability — the long-running loop in
 * `roomsWatchCommand` is just `while (!stopped) { pollWatchingOnce; sleep }`.
 */
export async function pollWatchingOnce(args: {
  seen: Set<string>;
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
  // Removed-rooms aren't in `currentIds`, so we materialize a placeholder
  // pulled from an in-memory cache of last-seen entries, but for V1 we
  // only emit the roomId since we don't need the full record back.
  for (const id of args.seen) {
    if (!currentIds.has(id)) {
      // The full WatchingRoom is gone; pass a minimal stub so callers
      // can render the removal line. Only `core.roomId` is meaningful
      // for a removal event.
      args.emit(
        {
          core: {
            roomId: id,
            manager: "",
            subject_type: "pr_review",
            subject_ref: "",
            opened_at: "",
            timing_config: {
              max_age_secs: 0,
              rsvp_deadline_secs: 0,
              contribution_deadline_secs: 0,
            },
            status: "closed",
          },
          participants: {},
          currentSequence: 0,
        },
        "removed",
      );
      args.seen.delete(id);
    }
  }

  for (const room of result.rooms) {
    const id = room.core.roomId;
    if (!args.seen.has(id)) {
      args.emit(room, "new");
      args.seen.add(id);
    }
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
  const seen = new Set<string>();

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
