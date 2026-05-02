"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  countRoomsByFilter,
  isRoomStuck,
  relativeTime,
  roomMatchesFilter,
  sortRoomsByStuckness,
  statusLabel,
  statusPillClass,
  subjectLabel,
  type RoomStatusFilter,
} from "./room-helpers";
import type { RoomCoreWithId } from "./types";

const REFRESH_INTERVAL_MS = 30_000;

type FetchState =
  | { status: "loading" }
  | { status: "ready"; rooms: RoomCoreWithId[] }
  | { status: "error"; message: string };

const FILTER_ORDER: ReadonlyArray<{
  value: RoomStatusFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
  { value: "expired", label: "Expired" },
];

export default function RoomsList() {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // Default to "all" so the operator sees every room on first
  // load — including the recently-closed ones that motivated this
  // filter UI in the first place.  Stored in component state only
  // (no querystring sync) since the rooms list is a transient
  // operator inspection surface, not a shareable view.
  const [filter, setFilter] = useState<RoomStatusFilter>("all");

  const fetchRooms = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/rooms?limit=50", {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        setState({
          status: "error",
          message: `Failed to load rooms (HTTP ${res.status}): ${text.slice(0, 200)}`,
        });
        return;
      }
      const body = (await res.json()) as { rooms?: RoomCoreWithId[] };
      setState({ status: "ready", rooms: body.rooms ?? [] });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    // Initial fetch + 30s polling. The async fetch triggers a
    // cascading setState (loading → ready) which the React 19
    // strict rule flags; for polling-fetch UX this cascade is
    // intentional (the initial loading state is useful for users
    // waiting on the first response). Mirrors TasksDashboard's
    // existing polling pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchRooms();
    const interval = setInterval(() => {
      void fetchRooms();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchRooms]);

  // Counts cover the full fetched set (not the filtered one) so the
  // chip labels stay stable as the operator switches filters — and
  // the operator can see at a glance how many rooms each bucket
  // holds before clicking.
  const counts = useMemo(
    () =>
      state.status === "ready"
        ? countRoomsByFilter(state.rooms)
        : { all: 0, active: 0, closed: 0, expired: 0 },
    [state],
  );

  const visibleRooms = useMemo(() => {
    if (state.status !== "ready") return [];
    const filtered = state.rooms.filter((r) => roomMatchesFilter(r, filter));
    return sortRoomsByStuckness(filtered);
  }, [state, filter]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
          War Rooms
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Active and past governance synthesis rooms for this installation.
          Refreshes every 30 seconds.
        </p>
      </header>

      {state.status === "ready" && state.rooms.length > 0 && (
        <FilterBar
          current={filter}
          onChange={setFilter}
          counts={counts}
        />
      )}

      {state.status === "loading" && (
        <p className="text-sm text-zinc-500">Loading rooms…</p>
      )}

      {state.status === "error" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm text-red-300">{state.message}</p>
          <button
            type="button"
            onClick={fetchRooms}
            className="mt-2 text-xs text-red-300 underline hover:text-red-200"
          >
            Retry
          </button>
        </div>
      )}

      {state.status === "ready" && state.rooms.length === 0 && (
        <div className="rounded-lg border border-white/5 bg-zinc-900/50 p-6 text-center">
          <p className="text-sm text-zinc-400">
            No war rooms yet. Rooms appear when the bot creates one for a
            PR review or @hivemoot mention.
          </p>
        </div>
      )}

      {state.status === "ready" &&
        state.rooms.length > 0 &&
        visibleRooms.length === 0 && (
          <div className="rounded-lg border border-white/5 bg-zinc-900/50 p-6 text-center">
            <p className="text-sm text-zinc-400">
              No rooms match the current filter.
            </p>
          </div>
        )}

      {state.status === "ready" && visibleRooms.length > 0 && (
        // Sort by stuck-ness DESC (most-stuck active rooms at top)
        // then terminal rooms by opened_at DESC. Per
        // WAR_ROOM_DESIGN.md L1247 — operators see rooms that
        // need attention without filtering. Closes #553 builder R1.
        <ul className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/5 bg-zinc-900/50">
          {visibleRooms.map((room) => (
            <RoomRow key={room.roomId} room={room} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterBar({
  current,
  onChange,
  counts,
}: {
  current: RoomStatusFilter;
  onChange: (next: RoomStatusFilter) => void;
  counts: Record<RoomStatusFilter, number>;
}) {
  return (
    <nav
      aria-label="Filter rooms by status"
      className="flex flex-wrap items-center gap-2"
    >
      {FILTER_ORDER.map(({ value, label }) => {
        const active = current === value;
        const count = counts[value];
        const baseClass =
          "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition-colors";
        const stateClass = active
          ? "bg-honey-500/15 text-honey-300 ring-1 ring-honey-500/40"
          : "bg-zinc-800/60 text-zinc-400 ring-1 ring-white/5 hover:bg-zinc-800 hover:text-zinc-200";
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={`${baseClass} ${stateClass}`}
          >
            <span>{label}</span>
            <span
              className={
                active
                  ? "rounded-full bg-honey-500/20 px-1.5 text-[10px] tabular-nums text-honey-200"
                  : "rounded-full bg-zinc-700/60 px-1.5 text-[10px] tabular-nums text-zinc-300"
              }
            >
              {count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function RoomRow({ room }: { room: RoomCoreWithId }) {
  // Red highlight when past 80% of the relevant deadline
  // (`quiet_period_secs` for awaiting_contributions / deciding;
  // heartbeat-model rooms have no separate awaiting_rsvp state).
  // Per WAR_ROOM_DESIGN.md L1248.
  const stuck = isRoomStuck(room.opened_at, room.status, room.timing_config);
  const stuckHighlight = stuck
    ? "border-l-2 border-red-500/60 bg-red-500/5"
    : "";
  return (
    <li className={stuckHighlight}>
      <Link
        href={`/dashboard/rooms/${room.roomId}`}
        className="block px-4 py-3 transition-colors hover:bg-white/5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClass(room.status)}`}
            >
              {statusLabel(room.status)}
            </span>
            {stuck && (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-300 ring-1 ring-red-500/30">
                near deadline
              </span>
            )}
            <span className="text-xs uppercase tracking-wide text-zinc-500">
              {subjectLabel(room.subject_type)}
            </span>
            <span className="font-mono text-sm text-zinc-300">
              {room.subject_ref}
            </span>
          </div>
          <span className="text-xs text-zinc-500">
            opened {relativeTime(room.opened_at)}
            {room.closed_at && ` · closed ${relativeTime(room.closed_at)}`}
          </span>
        </div>
      </Link>
    </li>
  );
}
