"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  countRoomsByFilter,
  hasDiffDriftedPostVerdict,
  isRoomStuck,
  relativeTime,
  roomMatchesFilter,
  roomMatchesSubjectQuery,
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
  // Substring match against subject_ref. Empty = no filter.  Like
  // `filter`, this is component state only — no URL sync.
  const [search, setSearch] = useState<string>("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const router = useRouter();

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
    const filtered = state.rooms.filter(
      (r) =>
        roomMatchesFilter(r, filter) && roomMatchesSubjectQuery(r, search),
    );
    return sortRoomsByStuckness(filtered);
  }, [state, filter, search]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
            War Rooms
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Active and past governance synthesis rooms for this installation.
            Refreshes every 30 seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreatorOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-honey-500/15 px-3 py-1.5 text-sm font-medium text-honey-300 ring-1 ring-honey-500/40 transition-colors hover:bg-honey-500/25"
        >
          <span aria-hidden="true">+</span>
          <span>New war-room</span>
        </button>
      </header>

      {creatorOpen && (
        <CreateRoomModal
          onClose={() => setCreatorOpen(false)}
          onCreated={(roomId) => {
            setCreatorOpen(false);
            router.push(`/dashboard/rooms/${roomId}`);
          }}
        />
      )}

      {state.status === "ready" && state.rooms.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterBar
            current={filter}
            onChange={setFilter}
            counts={counts}
          />
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Filter by subject (e.g. owner/repo#42)"
          />
        </div>
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
              No rooms match the current filter
              {search.trim() !== "" && ` and search "${search.trim()}"`}.
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

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <label
      className="flex items-center gap-2 rounded-full bg-zinc-800/60 px-3 py-1 text-xs ring-1 ring-white/5 focus-within:ring-honey-500/40"
    >
      <span className="sr-only">Filter rooms by subject</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 text-zinc-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5l3 3" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-64 max-w-full bg-transparent text-zinc-200 placeholder:text-zinc-500 focus:outline-none"
      />
      {value !== "" && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="text-zinc-500 hover:text-zinc-300"
        >
          ×
        </button>
      )}
    </label>
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
  // "Diff drifted post-verdict" — closed room received a `subject_updated`
  // rejection (PR head SHA advanced past what the verdict reviewed).
  // Closes hivemoot/hivemoot#605 (Option A): the merge-gate (Option C)
  // will read the same marker in a follow-up PR.
  const drifted = hasDiffDriftedPostVerdict(room);
  const driftTitle = drifted
    ? `Subject_updated rejected at ${room.last_post_close_drift_at}` +
      (room.last_post_close_drift_head_sha
        ? ` (head ${room.last_post_close_drift_head_sha.slice(0, 7)})`
        : "")
    : undefined;
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
            {drifted && (
              <span
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300 ring-1 ring-amber-500/30"
                title={driftTitle}
              >
                diff drifted
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

const TITLE_MAX_LENGTH = 200;

/**
 * Modal form for operator-driven war-room creation. Currently only
 * `general` (free-form coordination) — repo-anchored types are
 * bot-driven with deterministic roomIds and would risk colliding
 * with future bot creates if we accepted them here. The API route
 * enforces the same allowlist server-side.
 */
function CreateRoomModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (roomId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = title.trim();
  const isValid = trimmed.length > 0 && trimmed.length <= TITLE_MAX_LENGTH;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject_type: "general",
          subject_ref: trimmed,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof body.message === "string"
            ? body.message
            : `Failed to create room (HTTP ${res.status})`,
        );
        setSubmitting(false);
        return;
      }
      if (typeof body.roomId !== "string") {
        setError("Server didn't return a roomId.");
        setSubmitting(false);
        return;
      }
      onCreated(body.roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-room-title"
        className="w-full max-w-md rounded-lg border border-white/10 bg-zinc-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="create-room-title"
          className="text-lg font-semibold text-zinc-100"
        >
          New war-room
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Create an ad-hoc room. Agents on this installation will discover
          and engage with it like any other room — no special handling.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-zinc-300">Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What is this room about?"
              maxLength={TITLE_MAX_LENGTH}
              autoFocus
              className="mt-1 block w-full rounded-md border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-honey-500/60 focus:outline-none"
            />
            <span className="mt-1 block text-xs text-zinc-600">
              {trimmed.length}/{TITLE_MAX_LENGTH}
            </span>
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300"
            >
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              className="rounded-md bg-honey-500/15 px-3 py-1.5 text-sm font-medium text-honey-300 ring-1 ring-honey-500/40 hover:bg-honey-500/25 disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
