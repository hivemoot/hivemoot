/**
 * Queen observer pass — the cloud-side stuck-room metric emitter
 * that runs in place of the manager loop when `queen_mode=local`
 * (D8 + G5).
 *
 * What it does NOT do (deliberately):
 *   - claim synthesis
 *   - call the LLM
 *   - post any GitHub comment
 *   - mutate any room state
 *
 * What it DOES do: list the installation's rooms, filter to ones
 * that are eligible for synthesis (`awaiting_contributions` past
 * the quiet-period gate, all participants resolved), and emit a
 * structured `queen.observer.stuck_rooms` log event with the
 * counts at G5's thresholds (warn ≥5 min, alarm ≥15 min).
 *
 * The dashboard surfaces this signal alongside the agent's self-
 * reported heartbeat — together they detect the failure mode
 * "agent says it's healthy but rooms are piling up unsynthesized"
 * (guard pass-1's classic cloud-as-watchdog argument).
 *
 * **Why this lives in the cloud bot's queen-tick path even when
 * the cloud doesn't synthesize anymore**: cloud retains the
 * webhook handler surface in local mode (D8/G21), so the
 * cloud is the canonical writer of room state. Putting the
 * stuck-room signal on the same path keeps observability
 * load-bearing — independent of whether the agent on the hive is
 * up. Without this signal, a hung hive queen is silent.
 */

import type { RoomCoreWithId } from "@hivemoot/war-room";

const WARN_THRESHOLD_MS = 5 * 60 * 1000;
const ALARM_THRESHOLD_MS = 15 * 60 * 1000;

export interface QueenObserverResult {
  /** Total open rooms (`awaiting_contributions` + `deciding`). */
  totalOpen: number;
  /** Rooms in `awaiting_contributions` past warn threshold (≥5 min). */
  stuckWarn: number;
  /** Rooms in `awaiting_contributions` past alarm threshold (≥15 min). */
  stuckAlarm: number;
  /**
   * Time (ms) of the OLDEST `awaiting_contributions` room's
   * `opened_at`, or null if none. Lets the dashboard render an
   * age-of-oldest signal without re-querying.
   */
  oldestOpenedAtMs: number | null;
  /**
   * Always 0 in observer mode — kept on the result shape so the
   * dashboard query treats observer + manager-loop ticks
   * identically (G35: PR 5 dashboard renders one signal regardless
   * of mode).
   */
  claimed: 0;
  postsSucceeded: 0;
}

interface ObserverArgs {
  /** Pre-fetched rooms (caller already paid the listRooms cost). */
  rooms: RoomCoreWithId[];
  /** Now in ms since epoch — defaults to `Date.now()`. */
  nowMs?: number;
  /**
   * Logger sink. Same interface as the manager-loop adapter so
   * dashboard log queries work uniformly (G35).
   */
  log?: {
    info?: (event: string, fields: Record<string, unknown>) => void;
    warn?: (event: string, fields: Record<string, unknown>) => void;
  };
  /** Installation id, for log fields. */
  installationId: string;
}

/**
 * Run one observer tick. Pure: only reads the supplied rooms and
 * logs. Returns aggregated counts.
 */
export function runQueenObserverPass(args: ObserverArgs): QueenObserverResult {
  const nowMs = args.nowMs ?? Date.now();
  const result: QueenObserverResult = {
    totalOpen: 0,
    stuckWarn: 0,
    stuckAlarm: 0,
    oldestOpenedAtMs: null,
    claimed: 0,
    postsSucceeded: 0,
  };

  for (const room of args.rooms) {
    if (room.status !== "awaiting_contributions" && room.status !== "deciding") {
      continue;
    }
    result.totalOpen += 1;

    // Stuck-room signal applies only to awaiting_contributions —
    // `deciding` rooms are by definition mid-claim and time out via
    // the watchdog's claim-TTL recovery, not the stuck-room metric.
    if (room.status !== "awaiting_contributions") continue;

    const openedAtMs = Date.parse(room.opened_at);
    if (!Number.isFinite(openedAtMs)) continue;

    if (result.oldestOpenedAtMs === null || openedAtMs < result.oldestOpenedAtMs) {
      result.oldestOpenedAtMs = openedAtMs;
    }

    const ageMs = nowMs - openedAtMs;
    if (ageMs >= WARN_THRESHOLD_MS) result.stuckWarn += 1;
    if (ageMs >= ALARM_THRESHOLD_MS) result.stuckAlarm += 1;
  }

  // Always emit an info event so the dashboard can pick up the
  // signal even when counts are 0 (the dashboard heartbeat needs
  // a steady cadence, not a "missing data" gap that looks like
  // outage).
  args.log?.info?.("queen.observer.stuck_rooms", {
    installationId: args.installationId,
    totalOpen: result.totalOpen,
    stuckWarn: result.stuckWarn,
    stuckAlarm: result.stuckAlarm,
    oldestOpenedAtMs: result.oldestOpenedAtMs,
    warnThresholdMs: WARN_THRESHOLD_MS,
    alarmThresholdMs: ALARM_THRESHOLD_MS,
    nowMs,
  });

  // Escalate to warn-level only on alarm threshold breach so
  // dashboard alerting filters can subscribe to the warn channel
  // without drowning in steady-state info noise (G5 thresholds:
  // warn=5min, alarm=15min — alarm is the actionable one).
  if (result.stuckAlarm > 0) {
    args.log?.warn?.("queen.observer.stuck_rooms_alarm", {
      installationId: args.installationId,
      stuckAlarm: result.stuckAlarm,
      alarmThresholdMs: ALARM_THRESHOLD_MS,
    });
  }

  return result;
}

export const QUEEN_OBSERVER_THRESHOLDS = {
  warnMs: WARN_THRESHOLD_MS,
  alarmMs: ALARM_THRESHOLD_MS,
} as const;
