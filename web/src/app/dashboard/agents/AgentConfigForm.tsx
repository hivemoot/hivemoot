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
  type AgentTokensResponse,
  type AgentTriggers,
  type CreateAgentPayload,
  type CreateAgentResponse,
  type EngineCatalogEntry,
  type FleetAgent,
  type FleetErrorBody,
  type FleetMetaResponse,
  type SkillCatalogEntry,
  type TokenSummary,
  type TriggerKey,
  type UpdateAgentPayload,
  type UpdateAgentResponse,
  defaultTriggers,
  FLEET_ERROR_CODE,
} from "./types";
import { previewCapabilities, tokenCoversCapabilities } from "./capabilities";
import { TRIGGER_LABELS, TRIGGER_ORDER } from "./shared";

// ---------------------------------------------------------------------------
// Constants (mirror backend bounds in @/server/fleet-store)
// ---------------------------------------------------------------------------

const MAX_SYSTEM_PROMPT_CHARS = 16_000;
const MAX_SCHEDULE_PROMPT_CHARS = 2_000;
const NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

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
    case FLEET_ERROR_CODE.INVALID_TOKEN:
      return (
        body.message ||
        "The selected token no longer exists. Pick another token, or create one on Credentials."
      );
    case FLEET_ERROR_CODE.TOKEN_NOT_SCOPED:
      return (
        body.message ||
        "The selected token isn't scoped to any repo. Scope it on Credentials first, then link it here."
      );
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
// Token picker — link an EXISTING capability token (nothing is minted)
// ---------------------------------------------------------------------------

/** Loading state for the linkable-token catalog (fetched on mount). */
type TokensState =
  | { kind: "loading" }
  | { kind: "loaded"; tokens: TokenSummary[] }
  | { kind: "error"; message: string };

function CapabilityChips({ caps }: { caps: string[] }) {
  if (caps.length === 0) {
    return <span className="text-xs text-zinc-600">No capabilities</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {caps.map((cap) => (
        <span
          key={cap}
          className="rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-zinc-400"
        >
          {cap}
        </span>
      ))}
    </div>
  );
}

function TokenPicker({
  tokensState,
  selectedName,
  onSelect,
  selectedToken,
  scoped,
  capabilityWarning,
  onRetry,
}: {
  tokensState: TokensState;
  selectedName: string;
  onSelect: (name: string) => void;
  /** The resolved summary for `selectedName`, or undefined when none is picked. */
  selectedToken: TokenSummary | undefined;
  /** True when the selected token has ≥1 allowed repo. */
  scoped: boolean;
  /** Non-blocking warning when the token can't cover the agent's triggers. */
  capabilityWarning: string | null;
  onRetry: () => void;
}) {
  if (tokensState.kind === "loading") {
    return <LoadingState label="Loading tokens…" />;
  }

  if (tokensState.kind === "error") {
    return (
      <div className="space-y-3">
        <ErrorBanner tone="red">{tokensState.message}</ErrorBanner>
        <Button variant="secondary" size="sm" type="button" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  const { tokens } = tokensState;

  if (tokens.length === 0) {
    return (
      <ErrorBanner tone="amber">
        No agent tokens yet. Create a repo-scoped token on{" "}
        <a href="/dashboard/settings/byok" className="underline hover:text-amber-300">
          Credentials
        </a>{" "}
        first, then link it here.
      </ErrorBanner>
    );
  }

  const repos = selectedToken?.policy?.allowed_repos ?? [];

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="agent-token" className={LABEL_CLASS}>
          Token <span className="text-red-400/70">(required)</span>
        </label>
        <select
          id="agent-token"
          value={selectedName}
          onChange={(e) => onSelect(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value="">Select a token…</option>
          {tokens.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.agent_role})
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-zinc-600">
          The agent acts through this existing token. Its repo policy defines where the agent
          operates. Manage tokens on{" "}
          <a href="/dashboard/settings/byok" className="underline hover:text-zinc-400">
            Credentials
          </a>
          .
        </p>
      </div>

      {selectedToken && (
        <div className="space-y-4 rounded-lg border border-white/[0.04] bg-white/[0.02] p-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-400">Token capabilities</p>
            <CapabilityChips caps={selectedToken.capabilities} />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-400">Repo scope</p>
            {scoped ? (
              <p className="text-sm text-zinc-300">
                This agent will operate on:{" "}
                <span className="font-mono text-zinc-200">{repos.join(", ")}</span>
              </p>
            ) : (
              <ErrorBanner tone="amber">
                This token isn&apos;t scoped to any repo — scope it on{" "}
                <a href="/dashboard/settings/byok" className="underline hover:text-amber-300">
                  Credentials
                </a>{" "}
                first. The agent can&apos;t be created until then.
              </ErrorBanner>
            )}
          </div>

          {capabilityWarning && <ErrorBanner tone="amber">{capabilityWarning}</ErrorBanner>}
        </div>
      )}
    </div>
  );
}

/**
 * Map missing capabilities back to the human-facing trigger they belong to so
 * the warning reads in operator terms ("Tasks trigger enabled but this token
 * can't claim tasks") instead of raw capability strings.
 */
function describeMissingCapabilityTriggers(missing: string[]): string {
  const notes: string[] = [];
  if (missing.some((c) => c.startsWith("tasks."))) {
    notes.push("Tasks trigger enabled but this token can't claim tasks.");
  }
  if (missing.some((c) => c.startsWith("rooms."))) {
    notes.push("War-rooms trigger enabled but this token can't participate in rooms.");
  }
  if (missing.includes("agent_health.report")) {
    notes.push("This token can't report agent health.");
  }
  return notes.join(" ");
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

  // Prefill (create-only) from ?name= for the "Adopt" flow. ?repo= is gone —
  // the repo now comes from the linked token's policy.
  const prefillName = !isEdit ? (searchParams.get("name") ?? "") : "";

  const [meta, setMeta] = useState<MetaState>({ kind: "loading" });
  const [tokensState, setTokensState] = useState<TokensState>({ kind: "loading" });

  // ---- form fields ----
  const [name, setName] = useState(initial?.name ?? prefillName);
  const [displayName, setDisplayName] = useState(initial?.display_name ?? "");
  const [engine, setEngine] = useState(initial?.engine ?? "");
  const [agentTokenName, setAgentTokenName] = useState(initial?.agent_token_name ?? "");
  const [skills, setSkills] = useState<Set<string>>(() => new Set(initial?.skills ?? []));
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? "");
  const [triggers, setTriggers] = useState<AgentTriggers>(initial?.triggers ?? defaultTriggers());

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

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

  // ---- load linkable tokens ----
  // Same request-id guard pattern as loadMeta — a Retry mid-flight or an unmount
  // discards the stale response. Cookie-auth GET, no fresh-session needed.
  const tokensRequestRef = useRef(0);
  const loadTokens = useCallback(async () => {
    const requestId = ++tokensRequestRef.current;
    setTokensState({ kind: "loading" });
    try {
      const res = await fetch("/api/dashboard/agent-tokens", { cache: "no-store" });
      if (requestId !== tokensRequestRef.current) return;
      if (!res.ok) {
        if (res.status === 401) {
          setSessionExpired(true);
          setTokensState({ kind: "error", message: "Session expired." });
          return;
        }
        setTokensState({ kind: "error", message: "Failed to load tokens." });
        return;
      }
      const data = (await res.json()) as AgentTokensResponse;
      if (requestId !== tokensRequestRef.current) return;
      setTokensState({ kind: "loaded", tokens: data.tokens ?? [] });
    } catch {
      if (requestId !== tokensRequestRef.current) return;
      setTokensState({ kind: "error", message: "Network error — could not reach server." });
    }
  }, []);

  useEffect(() => {
    const run = () => void loadTokens();
    run();
  }, [loadTokens]);

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

  // The token the operator linked (resolved against the loaded catalog).
  const selectedToken = useMemo<TokenSummary | undefined>(() => {
    if (tokensState.kind !== "loaded" || !agentTokenName) return undefined;
    return tokensState.tokens.find((t) => t.name === agentTokenName);
  }, [tokensState, agentTokenName]);

  // A token must be scoped to ≥1 repo — that's where the agent operates. An
  // unscoped token blocks submit (the server rejects it with TOKEN_NOT_SCOPED).
  const tokenScoped = (selectedToken?.policy?.allowed_repos?.length ?? 0) > 0;

  // Non-blocking warning when the linked token can't grant what the enabled
  // triggers need (e.g. the tasks trigger is on but the token can't claim
  // tasks). Surfaced as guidance — the server is the authority and may still
  // refuse, but we never hard-block on a coverage gap here.
  const capabilityWarning = useMemo<string | null>(() => {
    if (!selectedToken) return null;
    const { covered, missing } = tokenCoversCapabilities(selectedToken.capabilities, capabilities);
    if (covered) return null;
    const missingTriggers = describeMissingCapabilityTriggers(missing);
    return `This token is missing ${missing.join(", ")}. ${missingTriggers}`;
  }, [selectedToken, capabilities]);

  // ---- client-side validation (fast feedback; server re-validates) ----
  function clientValidate(): string | null {
    if (!isEdit) {
      if (!NAME_REGEX.test(name)) {
        return "Name must be a lowercase identifier starting with a letter (≤32 chars, a–z 0–9 _ -).";
      }
    }
    if (!agentTokenName) return "Pick a token for this agent.";
    // The token must be scoped to a repo — that's where the agent works. We
    // block here for fast feedback; the server enforces the same rule
    // (TOKEN_NOT_SCOPED). Only enforce when the catalog has loaded and resolved
    // the selection, so a slow token fetch never blocks a valid submit.
    if (selectedToken && !tokenScoped) {
      return "The selected token isn't scoped to any repo. Scope it on Credentials first, then link it here.";
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
        // PATCH only mutable fields. display_name can be cleared via null. The
        // linked token is editable — re-pointing an agent at a different scoped
        // token is allowed.
        const body: UpdateAgentPayload = {
          display_name: trimmedDisplay.length > 0 ? trimmedDisplay : null,
          engine,
          skills: Array.from(skills),
          system_prompt: systemPrompt,
          triggers,
          agent_token_name: agentTokenName,
        };
        res = await fetch(`/api/dashboard/fleet/agents/${encodeURIComponent(initial!.name)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        const body: CreateAgentPayload = {
          name,
          ...(trimmedDisplay.length > 0 ? { display_name: trimmedDisplay } : {}),
          engine,
          skills: Array.from(skills),
          system_prompt: systemPrompt,
          triggers,
          agent_token_name: agentTokenName,
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
      // Nothing is minted anymore — go straight to the new agent's detail page.
      router.refresh();
      router.push(`/dashboard/agents/${encodeURIComponent(data.agent.name)}`);
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
      setSubmitting(false);
    }
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
        <SectionHeader title="Identity" description="Who this agent is." />

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
              stable identity.
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
      </Card>

      {/* Token — links an existing scoped capability token. */}
      <Card padding="md" className="space-y-4">
        <SectionHeader
          title="Token"
          description="The existing capability token this agent acts through. Its repo policy defines where the agent operates."
        />
        <TokenPicker
          tokensState={tokensState}
          selectedName={agentTokenName}
          onSelect={setAgentTokenName}
          selectedToken={selectedToken}
          scoped={tokenScoped}
          capabilityWarning={capabilityWarning}
          onRetry={loadTokens}
        />
      </Card>

      {/* Runtime */}
      <Card padding="md" className="space-y-5">
        <SectionHeader title="Runtime" description="The engine this agent runs on." />

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
        <Button
          type="submit"
          variant="primary"
          size="md"
          // An unscoped token can never produce a valid agent (no repos to
          // operate on) — the server rejects it, so block the submit. Coverage
          // warnings, by contrast, never disable the button.
          disabled={submitting || (selectedToken !== undefined && !tokenScoped)}
        >
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
    </form>
  );
}
