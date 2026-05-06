"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MarkdownContent } from "../../MarkdownContent";
import {
  heartbeatFreshnessDotClass,
  heartbeatFreshnessTitle,
  participantHeartbeatFreshness,
  participantStatusCounts,
  relativeTime,
  statusLabel,
  statusPillClass,
  subjectGithubUrl,
  subjectLabel,
} from "../room-helpers";
import type {
  RoomContribution,
  RoomDetailResponse,
  RoomEvent,
  RoomParticipant,
} from "../types";

const REFRESH_INTERVAL_MS = 30_000;

type FetchState =
  | { status: "loading" }
  | { status: "ready"; data: RoomDetailResponse }
  | { status: "not_found" }
  | { status: "error"; message: string };

export default function RoomDetail({ roomId }: { roomId: string }) {
  const [state, setState] = useState<FetchState>({ status: "loading" });

  const fetchDetail = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/rooms/${encodeURIComponent(roomId)}`,
        { cache: "no-store" },
      );
      if (res.status === 404) {
        setState({ status: "not_found" });
        return;
      }
      if (!res.ok) {
        const text = await res.text();
        setState({
          status: "error",
          message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        });
        return;
      }
      const body = (await res.json()) as RoomDetailResponse;
      setState({ status: "ready", data: body });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [roomId]);

  useEffect(() => {
    // See RoomsList for the rationale on the cascading-render
    // exemption — same polling-fetch UX pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDetail();
    const interval = setInterval(() => {
      void fetchDetail();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchDetail]);

  return (
    <div className="space-y-6">
      <nav className="text-xs text-zinc-500">
        <Link href="/dashboard/rooms" className="hover:text-zinc-300">
          ← Back to all war rooms
        </Link>
      </nav>

      {state.status === "loading" && (
        <p className="text-sm text-zinc-500">Loading room…</p>
      )}

      {state.status === "not_found" && (
        <div className="rounded-lg border border-white/5 bg-zinc-900/50 p-6">
          <p className="text-sm text-zinc-300">
            Room <span className="font-mono">{roomId}</span> not found.
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            It may have expired (30-day retention after close), or it
            belongs to a different installation.
          </p>
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="text-sm text-red-300">{state.message}</p>
          <button
            type="button"
            onClick={fetchDetail}
            className="mt-2 text-xs text-red-300 underline hover:text-red-200"
          >
            Retry
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <RoomDetailContent roomId={roomId} data={state.data} />
      )}
    </div>
  );
}

function RoomDetailContent({
  roomId,
  data,
}: {
  roomId: string;
  data: RoomDetailResponse;
}) {
  const { core, participants, contributions, events } = data;
  const partCounts = participantStatusCounts(participants);
  const githubUrl = subjectGithubUrl(core.subject_ref);

  return (
    <>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClass(core.status)}`}
          >
            {statusLabel(core.status)}
          </span>
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            {subjectLabel(core.subject_type)}
          </span>
        </div>
        <h1 className="text-xl font-semibold text-zinc-100">
          {githubUrl ? (
            <a
              href={githubUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono hover:text-honey-400"
            >
              {core.subject_ref} ↗
            </a>
          ) : (
            <span className="font-mono">{core.subject_ref}</span>
          )}
        </h1>
        {/* `grid-cols-[auto_1fr]` keeps the label column at its
            content width so values sit right next to their labels
            instead of being pushed to the far right of the page
            (which `grid-cols-2`'s 50/50 split caused on wide
            viewports). */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-500">
          <dt>Room ID</dt>
          <dd className="font-mono text-zinc-400">{roomId}</dd>
          <dt>Manager</dt>
          <dd className="font-mono text-zinc-400">{core.manager}</dd>
          <dt>Opened</dt>
          <dd className="text-zinc-400">{relativeTime(core.opened_at)}</dd>
          {core.closed_at && (
            <>
              <dt>Closed</dt>
              <dd className="text-zinc-400">
                {relativeTime(core.closed_at)}
                {core.closed_reason && ` · ${core.closed_reason}`}
              </dd>
            </>
          )}
        </dl>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">
          Participants ({partCounts.total})
        </h2>
        {partCounts.total === 0 ? (
          <p className="text-sm text-zinc-500">
            No participants have RSVP&apos;d yet.
          </p>
        ) : (
          <p className="mb-3 text-xs text-zinc-500">
            {partCounts.resolved} resolved · {partCounts.pending} pending ·{" "}
            {partCounts.withdrew} withdrew · {partCounts.timed_out} timed out
          </p>
        )}
        {partCounts.total > 0 && <ParticipantsTable participants={participants} />}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">
          Contributions ({Object.keys(contributions).length})
        </h2>
        {Object.keys(contributions).length === 0 ? (
          <p className="text-sm text-zinc-500">No contributions submitted.</p>
        ) : (
          <ContributionsList contributions={contributions} />
        )}
      </section>

      {core.decision && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-300">Decision</h2>
          <DecisionBlock decision={core.decision} />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">
          Recent events ({events.length})
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">No events yet.</p>
        ) : (
          <EventsList events={events} />
        )}
      </section>
    </>
  );
}

function ParticipantsTable({
  participants,
}: {
  participants: Record<string, RoomParticipant>;
}) {
  const rows = Object.entries(participants).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase text-zinc-500">
        <tr>
          <th className="py-1 pr-4">Role</th>
          <th className="py-1 pr-4">Agent</th>
          <th className="py-1 pr-4">Status</th>
          {/* Renamed from "RSVP'd" — heartbeats now bump rsvp_at every
              ~45s for pending participants (PRs A + C of the
              JOB_LIFECYCLE_UNIFICATION RFC), so the column reflects
              ongoing liveness, not just the initial RSVP. */}
          <th className="py-1">Heartbeat</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-white/5">
        {rows.map(([role, p]) => {
          const freshness = participantHeartbeatFreshness(p);
          return (
            <tr key={role}>
              <td className="py-1.5 pr-4 font-medium text-zinc-200">{role}</td>
              <td className="py-1.5 pr-4 font-mono text-xs text-zinc-400">
                {p.agent_id}
              </td>
              <td className="py-1.5 pr-4 text-zinc-300">{p.status}</td>
              <td className="py-1.5 text-xs text-zinc-500">
                <span
                  className="inline-flex items-center gap-1.5"
                  title={heartbeatFreshnessTitle(freshness)}
                >
                  <span
                    aria-label={`heartbeat ${freshness}`}
                    className={`inline-block h-2 w-2 rounded-full ${heartbeatFreshnessDotClass(freshness)}`}
                  />
                  {relativeTime(p.rsvp_at)}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Pick a deterministic Tailwind color class for a role's avatar
 * circle. Same role always gets the same hue across refreshes so
 * an operator can scan a long thread and recognize "the green one
 * is guard" without re-reading every label.
 */
function roleAccentClass(role: string): string {
  // Cheap hash → palette index. The palette is hand-picked to
  // stay legible against the zinc-950 page background while
  // keeping enough contrast between adjacent hues.
  const palette = [
    "bg-emerald-500/20 text-emerald-300 ring-emerald-500/30",
    "bg-sky-500/20 text-sky-300 ring-sky-500/30",
    "bg-amber-500/20 text-amber-300 ring-amber-500/30",
    "bg-rose-500/20 text-rose-300 ring-rose-500/30",
    "bg-violet-500/20 text-violet-300 ring-violet-500/30",
    "bg-teal-500/20 text-teal-300 ring-teal-500/30",
  ];
  let hash = 0;
  for (let i = 0; i < role.length; i++) {
    hash = (hash * 31 + role.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function ContributionsList({
  contributions,
}: {
  contributions: Record<string, RoomContribution>;
}) {
  return (
    <ol className="space-y-4">
      {Object.entries(contributions)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([role, c]) => {
          const initial = role.charAt(0).toUpperCase() || "?";
          return (
            <li key={role} className="flex gap-3">
              {/* Avatar — role initial, deterministic accent color
                  per role. Operators can pattern-match on color
                  across a long thread without re-reading labels. */}
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ring-1 ${roleAccentClass(role)}`}
                aria-hidden="true"
              >
                {initial}
              </div>
              <div className="min-w-0 flex-1 rounded-2xl border border-white/5 bg-zinc-900/60 px-4 py-3">
                {/* Header: role · verdict · timestamp. Time pushed
                    to the right via ml-auto so the visual rhythm
                    is consistent with chat clients (sender top-left,
                    timestamp top-right). */}
                <header className="mb-2 flex items-center gap-2 text-xs">
                  <span className="font-medium text-zinc-200">{role}</span>
                  {c.withdrawn ? (
                    <span className="rounded-full bg-zinc-700/30 px-2 py-0.5 text-zinc-400">
                      withdrawn
                    </span>
                  ) : (
                    c.body?.verdict !== undefined && (
                      <span className="rounded-full bg-honey-500/10 px-2 py-0.5 font-medium text-honey-400 ring-1 ring-honey-500/20">
                        {String(c.body.verdict)}
                      </span>
                    )
                  )}
                  {c.contributed_at && (
                    <span className="ml-auto text-zinc-500">
                      {relativeTime(c.contributed_at)}
                    </span>
                  )}
                </header>
                {c.withdrawn ? (
                  // Muted body for withdrawals — keep the slot but
                  // don't render the (typically empty) raw_md as a
                  // chat message; it's not a real contribution.
                  <p className="text-xs italic text-zinc-500">
                    Withdrew without contributing.
                  </p>
                ) : (
                  <>
                    {c.body?.summary !== undefined && (
                      <p className="mb-2 text-sm font-medium text-zinc-200">
                        {String(c.body.summary)}
                      </p>
                    )}
                    {c.raw_md && (
                      <MarkdownContent>{c.raw_md}</MarkdownContent>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
    </ol>
  );
}

function DecisionBlock({
  decision,
}: {
  decision: NonNullable<RoomDetailResponse["core"]["decision"]>;
}) {
  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span>
          <span className="text-emerald-400">●</span> synthesized{" "}
          {relativeTime(decision.synthesized_at)}
        </span>
        <span>·</span>
        <span className="font-mono">{decision.synthesis_runner}</span>
        <span>·</span>
        <span>through seq {decision.sequence_closed}</span>
      </div>
      <MarkdownContent>{decision.content}</MarkdownContent>
    </div>
  );
}

function EventsList({ events }: { events: RoomEvent[] }) {
  return (
    <ol className="space-y-1 text-xs">
      {events.map((e) => (
        <li
          key={e.seq}
          className="flex items-baseline gap-3 rounded border border-white/5 bg-zinc-900/30 px-2 py-1"
        >
          <span className="font-mono text-zinc-600">#{e.seq}</span>
          <span className="font-medium text-zinc-300">{e.event_type}</span>
          <span className="text-zinc-500">
            by{" "}
            <span className="font-mono">
              {e.actor_role}/{e.actor_id}
            </span>
          </span>
          <span className="ml-auto text-zinc-600">
            {relativeTime(e.timestamp)}
          </span>
        </li>
      ))}
    </ol>
  );
}
