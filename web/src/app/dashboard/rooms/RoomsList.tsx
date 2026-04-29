"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  relativeTime,
  statusLabel,
  statusPillClass,
  subjectLabel,
} from "./room-helpers";
import type { RoomCoreWithId } from "./types";

const REFRESH_INTERVAL_MS = 30_000;

type FetchState =
  | { status: "loading" }
  | { status: "ready"; rooms: RoomCoreWithId[] }
  | { status: "error"; message: string };

export default function RoomsList() {
  const [state, setState] = useState<FetchState>({ status: "loading" });

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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
          War Rooms
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Active and recently-closed governance synthesis rooms for this
          installation. Refreshes every 30 seconds.
        </p>
      </header>

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

      {state.status === "ready" && state.rooms.length > 0 && (
        <ul className="divide-y divide-white/5 overflow-hidden rounded-lg border border-white/5 bg-zinc-900/50">
          {state.rooms.map((room) => (
            <RoomRow key={room.roomId} room={room} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RoomRow({ room }: { room: RoomCoreWithId }) {
  return (
    <li>
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
