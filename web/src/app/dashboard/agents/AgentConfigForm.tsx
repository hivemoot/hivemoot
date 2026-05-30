"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Card,
  ErrorBanner,
  LoadingState,
  SectionHeader,
  Spinner,
} from "@/app/dashboard/ui";
import {
  type AgentTriggers,
  type CreateAgentResponse,
  type EngineCatalogEntry,
  type FleetAgent,
  type FleetErrorBody,
  type FleetMetaResponse,
  type SkillCatalogEntry,
  type TriggerKey,
  type UpdateAgentResponse,
  defaultTriggers,
  FLEET_ERROR_CODE,
} from "./types";
import { previewCapabilities } from "./capabilities";
import { TRIGGER_LABELS, TRIGGER_ORDER } from "./shared";

// ---------------------------------------------------------------------------
// Constants (mirror backend bounds in @/server/fleet-store)
// ---------------------------------------------------------------------------

const MAX_SYSTEM_PROMPT_CHARS = 16_000;
const MAX_SCHEDULE_PROMPT_CHARS = 2_000;
const NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;
const REPO_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const INPUT_CLASS =
  "w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20 disabled:cursor-not-allowed disabled:opacity-60";
const LABEL_CLASS = "mb-1.5 block text-xs font-medium text-zinc-400";

type FormMode = "create" | "edit";

// ---------------------------------------------------------------------------
// Meta loading (skills + engine catalogs)
// ---------------------------------------------------------------------------

type MetaState =
  | { kind: "loading" }
  | { kind: "loaded"; meta: FleetMetaResponse }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Error-code → friendly message mapping for the create/update flow
// ---------------------------------------------------------------------------

function friendlyFleetError(status: number, body: FleetErrorBody): string {
  // The shared require-installation guard returns { error, code } (no `message`).
  if (body.code === "installation_required") {
    return "Connect the Hivemoot Bot to a repo on this account before registering agents.";
  }
  switch (body.code) {
    case FLEET_ERROR_CODE.REPO_NOT_COVERED:
      return "The Hivemoot Bot isn't installed on that repo. Install it on the repo first, then try again.";
    case FLEET_ERROR_CODE.COVERAGE_CHECK_FAILED:
      return "Couldn't verify repo access right now. Please retry in a moment.";
    case FLEET_ERROR_CODE.NAME_TAKEN:
      // The backend message already names the conflict ("An agent or token
      // named 'X' already exists."); fall back to a generic line otherwise.
      return (
        body.message ||
        `The name "${body.name ?? ""}" is taken — an agent or token already uses it. Pick another name.`
      );
    case FLEET_ERROR_CODE.QUEEN_NOT_SUPPORTED:
      return body.message;
    case FLEET_ERROR_CODE.AGENT_LIMIT_REACHED:
      return "You've hit the per-installation agent limit. Delete an agent before creating another.";
    case FLEET_ERROR_CODE.RATE_LIMITED:
      return "Too many agent changes in a short window — slow down and retry shortly.";
    case FLEET_ERROR_CODE.VALIDATION:
      return body.field ? `${body.message} (${body.field})` : body.message;
    default:
      return body.message || body.error || `Request failed (HTTP ${status}).`;
  }
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function ReadOnlyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <span className={LABEL_CLASS}>{label}</span>
      <p className="rounded-lg border border-white/[0.04] bg-white/[0.02] px-3 py-2 font-mono text-sm text-zinc-300">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-zinc-600">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-honey-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-200">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-zinc-500">{description}</span>}
      </span>
    </label>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          onChange(Number.isFinite(n) ? n : min);
        }}
        className={INPUT_CLASS}
      />
      {hint && <p className="mt-1 text-xs text-zinc-600">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills multi-select
// ---------------------------------------------------------------------------

function SkillsPicker({
  catalog,
  selected,
  onToggle,
}: {
  catalog: SkillCatalogEntry[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const groups: { source: SkillCatalogEntry["source"]; label: string }[] = [
    { source: "builtin", label: "Built-in" },
    { source: "apiary", label: "Custom (apiary)" },
  ];

  return (
    <div className="space-y-4">
      {groups.map(({ source, label }) => {
        const entries = catalog.filter((s) => s.source === source);
        if (entries.length === 0) return null;
        return (
          <div key={source}>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {entries.map((skill) => {
                const isChecked = selected.has(skill.id);
                return (
                  <label
                    key={skill.id}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors ${
                      isChecked
                        ? "border-honey-500/40 bg-honey-500/[0.06]"
                        : "border-white/[0.06] bg-white/[0.02] hover:border-white/10"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => onToggle(skill.id)}
                      className="mt-0.5 h-4 w-4 accent-honey-500"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-medium text-[#fafafa]">{skill.name}</span>
                        {skill.standard && (
                          <span className="rounded bg-white/[0.06] px-1 py-0.5 text-[9px] uppercase tracking-wide text-zinc-500">
                            standard
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">
                        {skill.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger panel
// ---------------------------------------------------------------------------

function TriggerPanel({
  triggers,
  setTriggers,
}: {
  triggers: AgentTriggers;
  setTriggers: (next: AgentTriggers) => void;
}) {
  function patch<K extends TriggerKey>(key: K, next: Partial<AgentTriggers[K]>) {
    setTriggers({ ...triggers, [key]: { ...triggers[key], ...next } });
  }

  return (
    <div className="space-y-3">
      {TRIGGER_ORDER.map((key) => {
        const t = triggers[key];
        const enabled = t.enabled;
        return (
          <div
            key={key}
            className={`rounded-xl border p-4 transition-colors ${
              enabled ? "border-honey-500/30 bg-honey-500/[0.03]" : "border-white/[0.06] bg-white/[0.02]"
            }`}
          >
            <ToggleRow
              checked={enabled}
              onChange={(next) => patch(key, { enabled: next } as Partial<AgentTriggers[typeof key]>)}
              label={TRIGGER_LABELS[key]}
              description={TRIGGER_DESCRIPTIONS[key]}
            />

            {enabled && (
              <div className="mt-4 space-y-4 border-t border-white/[0.04] pt-4">
                {key === "schedule" && (
                  <ScheduleSettings
                    settings={triggers.schedule.settings}
                    onChange={(next) =>
                      patch("schedule", { settings: { ...triggers.schedule.settings, ...next } })
                    }
                  />
                )}
                {key === "pull_requests" && (
                  <PullRequestsSettings
                    settings={triggers.pull_requests.settings}
                    onChange={(next) =>
                      patch("pull_requests", {
                        settings: { ...triggers.pull_requests.settings, ...next },
                      })
                    }
                  />
                )}
                {key === "mentions" && (
                  <NumberField
                    id="trigger-mentions-poll"
                    label="Poll interval (seconds)"
                    value={triggers.mentions.settings.poll_interval_secs}
                    min={30}
                    max={3600}
                    onChange={(poll_interval_secs) =>
                      patch("mentions", {
                        settings: { ...triggers.mentions.settings, poll_interval_secs },
                      })
                    }
                    hint="How often to scan for new @mentions. 30–3600s."
                  />
                )}
                {key === "tasks" && (
                  <p className="text-xs text-zinc-500">
                    The agent claims dispatched tasks from the dashboard task queue. No extra
                    settings — enabling this grants the task capabilities shown below.
                  </p>
                )}
                {key === "war_rooms" && (
                  <ToggleRow
                    checked={triggers.war_rooms.settings.contribute}
                    onChange={(contribute) =>
                      patch("war_rooms", {
                        settings: { ...triggers.war_rooms.settings, contribute },
                      })
                    }
                    label="Contribute (vs observe only)"
                    description="When on, the agent posts contributions in war rooms. When off, it only watches/reads."
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Queen row — disabled, dashboard cannot grant it. */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 opacity-60">
        <ToggleRow
          checked={false}
          disabled
          onChange={() => {}}
          label="War-room creation / synthesis (queen)"
          description="Not available from the dashboard — issue a queen token via the admin path."
        />
      </div>
    </div>
  );
}

const TRIGGER_DESCRIPTIONS: Record<TriggerKey, string> = {
  schedule: "Run the agent on a fixed interval with a standing prompt.",
  pull_requests: "React to new PRs and review requests on the repo.",
  mentions: "Respond when the agent is @mentioned in issues or PRs.",
  tasks: "Claim and execute tasks dispatched from the dashboard.",
  war_rooms: "Participate in war-room governance discussions.",
};

function ScheduleSettings({
  settings,
  onChange,
}: {
  settings: AgentTriggers["schedule"]["settings"];
  onChange: (next: Partial<AgentTriggers["schedule"]["settings"]>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          id="schedule-interval"
          label="Interval (seconds)"
          value={settings.interval_secs}
          min={300}
          max={604800}
          onChange={(interval_secs) => onChange({ interval_secs })}
          hint="Between runs. 300s (5m) – 604800s (7d)."
        />
        <NumberField
          id="schedule-jitter"
          label="Jitter (seconds)"
          value={settings.jitter_secs}
          min={0}
          max={3600}
          onChange={(jitter_secs) => onChange({ jitter_secs })}
          hint="Random delay added per run. ≤ interval, ≤ 3600s."
        />
      </div>
      <div>
        <label htmlFor="schedule-prompt" className={LABEL_CLASS}>
          Schedule prompt <span className="text-red-400/70">(required)</span>
        </label>
        <textarea
          id="schedule-prompt"
          rows={3}
          value={settings.prompt}
          maxLength={MAX_SCHEDULE_PROMPT_CHARS}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="What should the agent do on each scheduled run?"
          className={`${INPUT_CLASS} resize-y`}
        />
        <p className="mt-1 text-right text-xs text-zinc-600">
          {settings.prompt.length.toLocaleString()} / {MAX_SCHEDULE_PROMPT_CHARS.toLocaleString()}
        </p>
      </div>
    </div>
  );
}

function PullRequestsSettings({
  settings,
  onChange,
}: {
  settings: AgentTriggers["pull_requests"]["settings"];
  onChange: (next: Partial<AgentTriggers["pull_requests"]["settings"]>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2.5">
        <ToggleRow
          checked={settings.watch_new_prs}
          onChange={(watch_new_prs) => onChange({ watch_new_prs })}
          label="Watch new PRs"
        />
        <ToggleRow
          checked={settings.watch_review_requests}
          onChange={(watch_review_requests) => onChange({ watch_review_requests })}
          label="Watch review requests"
        />
      </div>
      <div>
        <label htmlFor="pr-allowlist" className={LABEL_CLASS}>
          Author allowlist (comma-separated GitHub logins)
        </label>
        <input
          id="pr-allowlist"
          type="text"
          value={settings.author_allowlist.join(", ")}
          onChange={(e) =>
            onChange({
              author_allowlist: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="Leave empty to react to all authors"
          className={INPUT_CLASS}
        />
        <p className="mt-1 text-xs text-zinc-600">
          Empty = react to every author. Otherwise, only these logins (max 50).
        </p>
      </div>
      <NumberField
        id="pr-poll"
        label="Poll interval (seconds)"
        value={settings.poll_interval_secs}
        min={30}
        max={3600}
        onChange={(poll_interval_secs) => onChange({ poll_interval_secs })}
        hint="How often to scan for matching PRs. 30–3600s."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issued-token dialog (one-time copy, ByokPanel-style)
// ---------------------------------------------------------------------------

function IssuedTokenDialog({
  issued,
  onClose,
}: {
  issued: CreateAgentResponse;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  function handleCopy() {
    if (!navigator.clipboard?.writeText) {
      setCopyState("fail");
      return;
    }
    navigator.clipboard.writeText(issued.token).then(
      () => {
        setCopyState("ok");
        setTimeout(() => setCopyState("idle"), 2000);
      },
      () => setCopyState("fail"),
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issued-token-title"
    >
      <Card padding="lg" className="w-full max-w-lg border-honey-500/30 shadow-2xl">
        <h3 id="issued-token-title" className="text-lg font-semibold text-honey-500">
          Agent created — copy the token now
        </h3>
        <p className="mt-2 text-sm text-zinc-300">{issued.message}</p>
        <p className="mt-2 text-xs text-amber-400/90">
          Shown ONCE. Store it where the agent can read it (it provisions the agent on the hive).
          After you close this dialog, only the fingerprint is recoverable.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={issued.token}
            onFocus={(e) => e.target.select()}
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 font-mono text-xs text-[#fafafa]"
          />
          <Button type="button" variant="secondary" size="sm" onClick={handleCopy} className="shrink-0">
            {copyState === "ok" ? "Copied" : copyState === "fail" ? "Copy failed" : "Copy"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Fingerprint: <span className="font-mono text-zinc-400">····{issued.token_fingerprint}</span>
        </p>

        <div className="mt-6 flex justify-end">
          <Button type="button" variant="primary" size="md" onClick={onClose}>
            I&apos;ve stored it — continue
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main form
// ---------------------------------------------------------------------------

export function AgentConfigForm({
  mode,
  initial,
}: {
  mode: FormMode;
  /** Existing agent when editing. Ignored in create mode. */
  initial?: FleetAgent;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEdit = mode === "edit";

  // Prefill (create-only) from ?name=&repo= for the "Adopt" flow.
  const prefillName = !isEdit ? (searchParams.get("name") ?? "") : "";
  const prefillRepo = !isEdit ? (searchParams.get("repo") ?? "") : "";

  const [meta, setMeta] = useState<MetaState>({ kind: "loading" });

  // ---- form fields ----
  const [name, setName] = useState(initial?.name ?? prefillName);
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "");
  const [repo, setRepo] = useState(initial?.repo ?? prefillRepo);
  const [engine, setEngine] = useState(initial?.engine ?? "");
  const [duty, setDuty] = useState<FleetAgent["duty"]>(initial?.duty ?? "standing");
  const [skills, setSkills] = useState<Set<string>>(() => new Set(initial?.skills ?? []));
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? "");
  const [triggers, setTriggers] = useState<AgentTriggers>(initial?.triggers ?? defaultTriggers());

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [issuedToken, setIssuedToken] = useState<CreateAgentResponse | null>(null);

  // Seed create-mode defaults exactly once when the catalog first arrives:
  // pre-check standard skills + default the engine to the first catalog entry.
  // Never reseed (so an operator's deselect sticks across a poll) and never on
  // edit (the agent's saved config is authoritative).
  const seededRef = useRef(isEdit);

  // ---- load meta ----
  // A monotonically-increasing request id discards the response of any fetch
  // superseded by a newer one (e.g. a Retry while a load is in flight), so we
  // never apply stale state. All setState is post-await; seeding runs once.
  const metaRequestRef = useRef(0);
  const loadMeta = useCallback(async () => {
    const requestId = ++metaRequestRef.current;
    try {
      const res = await fetch("/api/dashboard/fleet/meta", { cache: "no-store" });
      if (requestId !== metaRequestRef.current) return;
      if (!res.ok) {
        if (res.status === 401) {
          setSessionExpired(true);
          setMeta({ kind: "error", message: "Session expired." });
          return;
        }
        setMeta({ kind: "error", message: "Failed to load form options." });
        return;
      }
      const data = (await res.json()) as FleetMetaResponse;
      if (requestId !== metaRequestRef.current) return;
      if (!seededRef.current) {
        seededRef.current = true;
        setSkills(new Set(data.skills_catalog.filter((s) => s.standard).map((s) => s.id)));
        if (data.engine_catalog.length > 0) setEngine(data.engine_catalog[0].id);
      }
      setMeta({ kind: "loaded", meta: data });
    } catch {
      if (requestId !== metaRequestRef.current) return;
      setMeta({ kind: "error", message: "Network error — could not reach server." });
    }
  }, []);

  useEffect(() => {
    // Wrapped in a local function (rather than passing loadMeta directly) so the
    // react-hooks set-state-in-effect rule sees an effect that synchronizes with
    // an external system (the fetch) rather than a bare setState dispatch. The
    // request-id guard inside loadMeta discards a response superseded by unmount
    // or a Retry, so this fire-and-forget is safe.
    const run = () => void loadMeta();
    run();
  }, [loadMeta]);

  const toggleSkill = useCallback((id: string) => {
    setSkills((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const capabilities = useMemo(
    () =>
      previewCapabilities({
        schedule: triggers.schedule.enabled,
        pull_requests: triggers.pull_requests.enabled,
        mentions: triggers.mentions.enabled,
        tasks: triggers.tasks.enabled,
        war_rooms: triggers.war_rooms.enabled,
        war_rooms_contribute: triggers.war_rooms.settings.contribute,
      }),
    [triggers],
  );

  // ---- client-side validation (fast feedback; server re-validates) ----
  function clientValidate(): string | null {
    if (!isEdit) {
      if (!NAME_REGEX.test(name)) {
        return "Name must be a lowercase identifier starting with a letter (≤32 chars, a–z 0–9 _ -).";
      }
      if (!REPO_REGEX.test(repo.trim())) {
        return "Repo must be in 'owner/name' form.";
      }
    }
    if (!engine) return "Pick an engine.";
    if (displayName.trim().length > 80) return "Display name must be ≤80 characters.";
    if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
      return `System prompt must be ≤${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters.`;
    }
    if (triggers.schedule.enabled && triggers.schedule.settings.prompt.trim().length === 0) {
      return "A schedule prompt is required when the schedule trigger is enabled.";
    }
    if (
      triggers.pull_requests.enabled &&
      !triggers.pull_requests.settings.watch_new_prs &&
      !triggers.pull_requests.settings.watch_review_requests
    ) {
      return "Enable at least one of 'watch new PRs' / 'watch review requests' for the pull-requests trigger.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const validationError = clientValidate();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError(null);

    const trimmedDisplay = displayName.trim();

    try {
      let res: Response;
      if (isEdit) {
        // PATCH only mutable fields. display_name can be cleared via null.
        const body = {
          display_name: trimmedDisplay.length > 0 ? trimmedDisplay : null,
          engine,
          duty,
          skills: Array.from(skills),
          system_prompt: systemPrompt,
          triggers,
        };
        res = await fetch(`/api/dashboard/fleet/agents/${encodeURIComponent(initial!.name)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        const body = {
          name,
          ...(trimmedDisplay.length > 0 ? { display_name: trimmedDisplay } : {}),
          repo: repo.trim(),
          engine,
          duty,
          skills: Array.from(skills),
          system_prompt: systemPrompt,
          triggers,
        };
        res = await fetch("/api/dashboard/fleet/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      if (res.status === 401) {
        setSessionExpired(true);
        setSubmitting(false);
        return;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => ({
          code: "",
          message: `Request failed (HTTP ${res.status}).`,
        }))) as FleetErrorBody;
        setFormError(friendlyFleetError(res.status, body));
        setSubmitting(false);
        return;
      }

      if (isEdit) {
        const data = (await res.json()) as UpdateAgentResponse;
        // Refresh server data so the detail page reflects the saved config.
        router.refresh();
        // Reset the dirty system-prompt baseline by routing back to the agent.
        router.push(`/dashboard/agents/${encodeURIComponent(data.agent.name)}`);
        return;
      }

      const data = (await res.json()) as CreateAgentResponse;
      // Show the once-only token; routing happens when the dialog closes.
      setIssuedToken(data);
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  function handleTokenDialogClose() {
    if (!issuedToken) return;
    const created = issuedToken.agent.name;
    setIssuedToken(null);
    router.push(`/dashboard/agents/${encodeURIComponent(created)}`);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (sessionExpired) {
    return (
      <ErrorBanner tone="red">
        Session expired.{" "}
        <a href="/setup" className="underline hover:text-red-300">
          Re-authenticate via Setup
        </a>{" "}
        to manage agents.
      </ErrorBanner>
    );
  }

  if (meta.kind === "loading") {
    return <LoadingState label="Loading form options…" />;
  }

  if (meta.kind === "error") {
    return (
      <Card padding="lg">
        <ErrorBanner tone="red">{meta.message}</ErrorBanner>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            setMeta({ kind: "loading" });
            void loadMeta();
          }}
          className="mt-4"
        >
          Retry
        </Button>
      </Card>
    );
  }

  const { skills_catalog, engine_catalog } = meta.meta;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {formError && <ErrorBanner tone="red">{formError}</ErrorBanner>}

      {/* Identity */}
      <Card padding="md" className="space-y-5">
        <SectionHeader title="Identity" description="Who this agent is and where it works." />

        {isEdit ? (
          <ReadOnlyField label="Name" value={initial!.name} hint="Immutable after creation." />
        ) : (
          <div>
            <label htmlFor="agent-name" className={LABEL_CLASS}>
              Name <span className="text-red-400/70">(required)</span>
            </label>
            <input
              id="agent-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. reviewer"
              autoComplete="off"
              className={`${INPUT_CLASS} font-mono`}
            />
            <p className="mt-1 text-xs text-zinc-600">
              Lowercase id, starts with a letter, ≤32 chars (a–z 0–9 _ -). Used as the agent&apos;s
              stable identity and token name.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="agent-display-name" className={LABEL_CLASS}>
            Display name <span className="text-zinc-600">(optional)</span>
          </label>
          <input
            id="agent-display-name"
            type="text"
            value={displayName}
            maxLength={80}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Friendly label shown in the dashboard"
            className={INPUT_CLASS}
          />
        </div>

        {isEdit ? (
          <ReadOnlyField label="Repo" value={initial!.repo} hint="Immutable after creation." />
        ) : (
          <div>
            <label htmlFor="agent-repo" className={LABEL_CLASS}>
              Repo <span className="text-red-400/70">(required)</span>
            </label>
            <input
              id="agent-repo"
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/name"
              autoComplete="off"
              className={`${INPUT_CLASS} font-mono`}
            />
            <p className="mt-1 text-xs text-zinc-600">
              The repo the agent operates on. The Hivemoot Bot must be installed there.
            </p>
          </div>
        )}
      </Card>

      {/* Runtime */}
      <Card padding="md" className="space-y-5">
        <SectionHeader title="Runtime" description="The engine and dispatch model." />

        <div>
          <label htmlFor="agent-engine" className={LABEL_CLASS}>
            Engine
          </label>
          <select
            id="agent-engine"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            className={INPUT_CLASS}
          >
            {engine_catalog.length === 0 && <option value="">No engines available</option>}
            {engine_catalog.map((e: EngineCatalogEntry) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className={LABEL_CLASS}>Duty</span>
          <div className="inline-flex rounded-lg border border-white/[0.06] p-1">
            {(["standing", "dispatch"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDuty(d)}
                aria-pressed={duty === d}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  duty === d
                    ? "border border-honey-500/40 bg-honey-500/10 text-honey-400"
                    : "border border-transparent text-zinc-400 hover:text-zinc-300"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-zinc-600">
            {duty === "standing"
              ? "Standing agents run continuously on their own triggers."
              : "Dispatch agents are activated to claim specific dispatched work."}
          </p>
        </div>
      </Card>

      {/* Skills */}
      <Card padding="md" className="space-y-4">
        <SectionHeader
          title="Skills"
          description={`Capabilities bundled into the agent's runtime. ${skills.size} selected.`}
        />
        <SkillsPicker catalog={skills_catalog} selected={skills} onToggle={toggleSkill} />
      </Card>

      {/* System prompt */}
      <Card padding="md" className="space-y-3">
        <SectionHeader title="System prompt" description="Base instructions passed to the agent." />
        <textarea
          id="agent-system-prompt"
          rows={10}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Persistent instructions that frame everything this agent does…"
          className={`${INPUT_CLASS} resize-y font-mono`}
        />
        <p
          className={`text-right text-xs ${
            systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS ? "text-red-400" : "text-zinc-600"
          }`}
        >
          {systemPrompt.length.toLocaleString()} / {MAX_SYSTEM_PROMPT_CHARS.toLocaleString()}
        </p>
      </Card>

      {/* Triggers */}
      <Card padding="md" className="space-y-4">
        <SectionHeader
          title="Triggers"
          description="When and how this agent activates. Each trigger you enable grants the matching capabilities below."
        />
        <TriggerPanel triggers={triggers} setTriggers={setTriggers} />
      </Card>

      {/* Capability preview */}
      <Card padding="md" className="space-y-3">
        <SectionHeader
          title="Capabilities this agent will receive"
          description="Least-privilege token scopes derived from the enabled triggers. Recomputed on every save."
        />
        <div className="flex flex-wrap gap-2">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="rounded-md bg-honey-500/10 px-2 py-1 font-mono text-xs text-honey-400"
            >
              {cap}
            </span>
          ))}
        </div>
      </Card>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" size="md" disabled={submitting}>
          {submitting ? (
            <span className="flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5 animate-spin" />
              {isEdit ? "Saving…" : "Creating…"}
            </span>
          ) : isEdit ? (
            "Save changes"
          ) : (
            "Create agent"
          )}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={submitting}
          onClick={() =>
            router.push(
              isEdit ? `/dashboard/agents/${encodeURIComponent(initial!.name)}` : "/dashboard/agents",
            )
          }
        >
          Cancel
        </Button>
      </div>

      {issuedToken && <IssuedTokenDialog issued={issuedToken} onClose={handleTokenDialogClose} />}
    </form>
  );
}
