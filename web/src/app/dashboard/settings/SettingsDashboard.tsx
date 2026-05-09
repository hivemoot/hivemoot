"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type QueenMode = "cloud" | "local";

interface QueenSettings {
  installation_id: string;
  queen_mode: QueenMode;
  queen_prompt_override: string | null;
}

interface BlockedReason {
  reason: "rooms_in_flight";
  counts: {
    deciding: number;
    decided_pending_action: number;
    stranded_merge: number;
    /** PR 2 (#641) guard pass-1 G2: queen-tick is mid-flight. */
    tick_running: number;
  };
  sampleRoomIds: string[];
}

interface PostError {
  code: string;
  message: string;
  blocked?: BlockedReason;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; settings: QueenSettings }
  | { kind: "error"; message: string };

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "blocked"; blocked: BlockedReason }
  | { kind: "error"; message: string };

const SETTINGS_URL = "/api/dashboard/queen-settings";

/** Client-side cap on the override blob (G4 — guard pass-1 hardening
 * on PR 5). 16 KiB is generous for a YAML config and well under any
 * Redis hash-field limit. The route handler should match this cap
 * (PR 1 follow-up); without a server-side cap an authenticated
 * operator can still POST a larger blob via curl. */
const OVERRIDE_MAX_CHARS = 16 * 1024;

export default function SettingsDashboard() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [draftMode, setDraftMode] = useState<QueenMode>("cloud");
  const [draftOverride, setDraftOverride] = useState<string>("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [confirmFlip, setConfirmFlip] = useState<QueenMode | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const res = await fetch(SETTINGS_URL, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as PostError;
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      const settings = (await res.json()) as QueenSettings;
      setLoad({ kind: "loaded", settings });
      setDraftMode(settings.queen_mode);
      setDraftOverride(settings.queen_prompt_override ?? "");
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load settings",
      });
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const handleSave = useCallback(
    async () => {
      setSave({ kind: "saving" });
      try {
        const body: Record<string, unknown> = {
          queen_mode: draftMode,
        };
        // Send override field only when it changed; null clears, string sets,
        // omit leaves untouched (matches the route contract from PR 1).
        const current =
          load.kind === "loaded" ? load.settings.queen_prompt_override : null;
        const trimmed = draftOverride.trim();
        const newVal = trimmed.length > 0 ? trimmed : null;
        if (newVal !== current) body.queen_prompt_override = newVal;

        const res = await fetch(SETTINGS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 409) {
          const err = (await res.json()) as PostError;
          if (err.blocked) {
            setSave({ kind: "blocked", blocked: err.blocked });
            return;
          }
        }
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as PostError;
          setSave({
            kind: "error",
            message: err.message || `HTTP ${res.status}`,
          });
          return;
        }

        const settings = (await res.json()) as QueenSettings;
        setLoad({ kind: "loaded", settings });
        setDraftMode(settings.queen_mode);
        setDraftOverride(settings.queen_prompt_override ?? "");
        setSave({ kind: "idle" });
        setConfirmFlip(null);
      } catch (err) {
        setSave({
          kind: "error",
          message: err instanceof Error ? err.message : "Save failed",
        });
      }
    },
    [draftMode, draftOverride, load],
  );

  if (load.kind === "loading") {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
        <p className="text-sm text-zinc-400">Loading settings…</p>
      </div>
    );
  }

  if (load.kind === "error") {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-8">
        <h2 className="mb-2 text-lg font-semibold text-rose-300">
          Couldn&apos;t load settings
        </h2>
        <p className="text-sm text-zinc-400">{load.message}</p>
        <button
          type="button"
          onClick={() => void fetchSettings()}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
        >
          Retry
        </button>
      </div>
    );
  }

  const { settings } = load;
  const modeChanged = draftMode !== settings.queen_mode;
  const overrideChanged =
    (draftOverride.trim() || null) !== (settings.queen_prompt_override ?? null);
  const dirty = modeChanged || overrideChanged;

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-[#fafafa]">
          Settings
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Per-installation configuration. See also{" "}
          <Link href="/dashboard/credentials" className="text-honey-400 hover:underline">
            BYOK credentials
          </Link>
          . (Linking the legacy path so this works whether or not the
          BYOK relocation PR has merged; the relocation sweep will
          rewrite this on its end.)
        </p>
      </div>

      <section className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="text-lg font-semibold text-[#fafafa]">Queen execution mode</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Where war-room synthesis runs for installation{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300">
            {settings.installation_id}
          </code>
          .
        </p>

        <fieldset className="mt-6 space-y-3">
          <legend className="sr-only">Queen mode</legend>

          <ModeChoice
            value="cloud"
            label="Cloud (default)"
            description="Vercel cron runs the synthesis loop. BYOK provider key bills per token."
            current={settings.queen_mode}
            draft={draftMode}
            onSelect={setDraftMode}
          />
          <ModeChoice
            value="local"
            label="Local (hive queen)"
            description="The hive queen agent runs synthesis on Codex (flat cost). Cloud retains webhook handlers + observer-pass stuck-room metric."
            current={settings.queen_mode}
            draft={draftMode}
            onSelect={setDraftMode}
          />
        </fieldset>

        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-zinc-300 hover:text-zinc-100">
            Structured prompt override (optional)
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-zinc-500">
              YAML/text passed to the queen as additional judgment guidelines (D12).
              Leave empty to use defaults. The override is bounded by a schema in PR 3;
              today it&apos;s stored as a plain string.
            </p>
            <textarea
              value={draftOverride}
              onChange={(e) => setDraftOverride(e.target.value)}
              rows={6}
              spellCheck={false}
              maxLength={OVERRIDE_MAX_CHARS}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 focus:border-honey-500 focus:outline-none"
              placeholder="merge_conventions: |&#10;  Squash-merge only. Require all checks green before merging."
            />
            <p
              className={`text-right text-[11px] ${
                draftOverride.length > OVERRIDE_MAX_CHARS - 1024
                  ? "text-amber-400"
                  : "text-zinc-500"
              }`}
            >
              {draftOverride.length.toLocaleString()} / {OVERRIDE_MAX_CHARS.toLocaleString()} chars
            </p>
          </div>
        </details>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={!dirty || save.kind === "saving"}
            onClick={() => {
              if (modeChanged) setConfirmFlip(draftMode);
              else void handleSave();
            }}
            className="inline-flex items-center gap-2 rounded-md bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] transition-colors hover:bg-honey-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {save.kind === "saving" ? "Saving…" : "Save"}
          </button>
          {dirty && save.kind !== "saving" && (
            <button
              type="button"
              onClick={() => {
                setDraftMode(settings.queen_mode);
                setDraftOverride(settings.queen_prompt_override ?? "");
                setSave({ kind: "idle" });
              }}
              className="text-sm text-zinc-400 hover:text-zinc-200"
            >
              Cancel
            </button>
          )}
          {save.kind === "error" && (
            <p className="text-sm text-rose-300">{save.message}</p>
          )}
        </div>

        {save.kind === "blocked" && (
          <BlockedRoomsBanner blocked={save.blocked} />
        )}
      </section>

      {confirmFlip !== null && (
        <FlipConfirmModal
          targetMode={confirmFlip}
          currentMode={settings.queen_mode}
          onCancel={() => setConfirmFlip(null)}
          onConfirm={() => void handleSave()}
          saving={save.kind === "saving"}
        />
      )}
    </>
  );
}

function ModeChoice({
  value,
  label,
  description,
  current,
  draft,
  onSelect,
}: {
  value: QueenMode;
  label: string;
  description: string;
  current: QueenMode;
  draft: QueenMode;
  onSelect: (m: QueenMode) => void;
}): React.ReactElement {
  const checked = draft === value;
  const isCurrent = current === value;
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors ${
        checked
          ? "border-honey-500 bg-honey-500/5"
          : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"
      }`}
    >
      <input
        type="radio"
        name="queen-mode"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-1 h-4 w-4 accent-honey-500"
      />
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">{label}</span>
          {isCurrent && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              current
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-zinc-400">{description}</p>
      </div>
    </label>
  );
}

function BlockedRoomsBanner({ blocked }: { blocked: BlockedReason }): React.ReactElement {
  const roomCount =
    blocked.counts.deciding +
    blocked.counts.decided_pending_action +
    blocked.counts.stranded_merge;
  const tickRunning = blocked.counts.tick_running > 0;
  const headline = tickRunning && roomCount === 0
    ? "Mode flip blocked — queen-tick mid-flight"
    : `Mode flip blocked — ${roomCount} room${roomCount === 1 ? "" : "s"} in flight`;
  return (
    <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <p className="font-semibold text-amber-200">{headline}</p>
      <ul className="mt-2 space-y-1 text-xs text-zinc-400">
        {blocked.counts.deciding > 0 && (
          <li>{blocked.counts.deciding} in <code>deciding</code> (mid-claim)</li>
        )}
        {blocked.counts.decided_pending_action > 0 && (
          <li>
            {blocked.counts.decided_pending_action} in{" "}
            <code>decided_pending_action</code> (tick-N+1 merge window)
          </li>
        )}
        {blocked.counts.stranded_merge > 0 && (
          <li>
            {blocked.counts.stranded_merge} stranded merge — check the reconciler
          </li>
        )}
        {tickRunning && (
          <li>
            queen-tick is running for this installation — wait ~30s and retry.
            Without this gate the tick would finish synthesizing in the OLD
            mode (it reads queen-mode once at the top of its loop).
          </li>
        )}
      </ul>
      {blocked.sampleRoomIds.length > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          Sample rooms:{" "}
          {blocked.sampleRoomIds.map((id, i) => (
            <span key={id}>
              <Link
                href={`/dashboard/rooms/${encodeURIComponent(id)}`}
                className="font-mono text-honey-400 hover:underline"
              >
                {id.slice(0, 8)}
              </Link>
              {i < blocked.sampleRoomIds.length - 1 && ", "}
            </span>
          ))}
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Resolve the in-flight rooms before flipping. G6 force-expire is the
        operator escape valve when a claim is genuinely stuck.
      </p>
    </div>
  );
}

function FlipConfirmModal({
  targetMode,
  currentMode,
  onCancel,
  onConfirm,
  saving,
}: {
  targetMode: QueenMode;
  currentMode: QueenMode;
  onCancel: () => void;
  onConfirm: () => void;
  saving: boolean;
}): React.ReactElement {
  const message =
    targetMode === "local"
      ? `Switching to local — the hive queen becomes the only path that synthesizes verdicts and posts actions on PRs. PR discovery and room state-bumps continue via the cloud webhook handlers (so a hive queen outage by itself does not lose new PRs), but if cloud webhook delivery has degraded independently, the hive queen has no backstop. The cloud will emit a 'rooms-stuck-older-than-N-min' alarm if the local queen falls behind, but no fallback synthesis will happen. Make sure your hive queen has uptime monitoring before flipping.`
      : `Switching to cloud — Vercel cron resumes synthesis using the BYOK provider key. The hive queen stops posting; webhook handlers stay active in both modes.`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flip-modal-title"
    >
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <h3 id="flip-modal-title" className="text-lg font-semibold text-[#fafafa]">
          Confirm mode flip: {currentMode} → {targetMode}
        </h3>
        <p className="mt-3 text-sm text-zinc-300">{message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="rounded-md bg-honey-500 px-4 py-2 text-sm font-semibold text-[#111114] hover:bg-honey-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Flipping…" : "Confirm flip"}
          </button>
        </div>
      </div>
    </div>
  );
}
