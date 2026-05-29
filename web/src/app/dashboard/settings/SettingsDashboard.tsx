"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Button, Card, ErrorBanner, LoadingState, PageHeader } from "@/app/dashboard/ui";

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
      // Override editing is disabled until PR 4 ships the D12
      // structured-YAML schema (merge_conventions /
      // additional_blockers). The store route rejects any non-null
      // override today (PR 1 pass-2). We still surface the *current*
      // value as read-only context for operators.
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
        // PR 1 pass-2 rejects any non-null override; the structured
        // YAML schema lands in PR 4 (D12). Until then we only ever
        // send the queen_mode field — the override stays at whatever
        // the route already has. Once D12 lands, this function gets
        // a `body.queen_prompt_override = parsedYaml ?? null` line.
        const body: Record<string, unknown> = {
          queen_mode: draftMode,
        };

        const res = await fetch(SETTINGS_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 409) {
          const err = (await res.json()) as PostError;
          if (err.blocked) {
            // Close the modal before surfacing the blocked banner —
            // otherwise the modal stays open over the banner and
            // the operator can't read why their flip was blocked.
            setConfirmFlip(null);
            setSave({ kind: "blocked", blocked: err.blocked });
            return;
          }
        }
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as PostError;
          // Same as the 409 path: dismiss the modal so the inline
          // error message under the Save button is visible.
          setConfirmFlip(null);
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
        // Network / parse failures must also close the modal —
        // the modal's "Confirm flip" stays in saving state forever
        // otherwise.
        setConfirmFlip(null);
        setSave({
          kind: "error",
          message: err instanceof Error ? err.message : "Save failed",
        });
      }
    },
    [draftMode],
  );

  if (load.kind === "loading") {
    return <LoadingState label="Loading settings…" />;
  }

  if (load.kind === "error") {
    return (
      <Card padding="lg">
        <h2 className="mb-2 text-lg font-semibold text-red-400">
          Couldn&apos;t load settings
        </h2>
        <ErrorBanner tone="red">{load.message}</ErrorBanner>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void fetchSettings()}
          className="mt-4"
        >
          Retry
        </Button>
      </Card>
    );
  }

  const { settings } = load;
  const modeChanged = draftMode !== settings.queen_mode;
  // Override editing is disabled until PR 4 lands the D12 schema —
  // dirty state tracks mode only. Once the schema editor ships,
  // this becomes `modeChanged || overrideChanged`.
  const dirty = modeChanged;

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          <>
            Per-installation configuration. See also{" "}
            <Link href="/dashboard/settings/byok" className="text-honey-400 hover:underline">
              BYOK credentials
            </Link>
            .
          </>
        }
      />

      <Card padding="lg" className="mb-8">
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
            Structured prompt override
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-zinc-500">
              The structured override (D12 — <code>merge_conventions</code>{" "}
              and <code>additional_blockers</code>) lands in a follow-up
              release. Free-form strings are rejected by the API today,
              so the editor is read-only until then. The current stored
              value, if any, is shown below.
            </p>
            <pre className="w-full overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-400">
              {draftOverride.length > 0 ? draftOverride : "(no override set)"}
            </pre>
          </div>
        </details>

        <div className="mt-6 flex items-center gap-3">
          <Button
            variant="primary"
            type="button"
            disabled={!dirty || save.kind === "saving"}
            onClick={() => {
              if (modeChanged) setConfirmFlip(draftMode);
              else void handleSave();
            }}
          >
            {save.kind === "saving" ? "Saving…" : "Save"}
          </Button>
          {dirty && save.kind !== "saving" && (
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setDraftMode(settings.queen_mode);
                setDraftOverride(settings.queen_prompt_override ?? "");
                setSave({ kind: "idle" });
              }}
            >
              Cancel
            </Button>
          )}
          {save.kind === "error" && (
            <p className="text-sm text-red-400">{save.message}</p>
          )}
        </div>

        {save.kind === "blocked" && (
          <BlockedRoomsBanner blocked={save.blocked} />
        )}
      </Card>

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
      <Card padding="lg" className="w-full max-w-lg shadow-2xl">
        <h3 id="flip-modal-title" className="text-lg font-semibold text-[#fafafa]">
          Confirm mode flip: {currentMode} → {targetMode}
        </h3>
        <p className="mt-3 text-sm text-zinc-300">{message}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="secondary"
            type="button"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? "Flipping…" : "Confirm flip"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
