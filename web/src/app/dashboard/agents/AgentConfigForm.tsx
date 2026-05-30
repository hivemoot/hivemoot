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
  type CreateAgentPayload,
  type CreateAgentResponse,
  type EngineCatalogEntry,
  type FleetAgent,
  type FleetErrorBody,
  type FleetMetaResponse,
  type SkillCatalogEntry,
  type TokenSummary,
  type UpdateAgentPayload,
  type UpdateAgentResponse,
  defaultPlugins,
  FLEET_ERROR_CODE,
} from "./types";
import { detectCapabilityGaps, describeCapabilityGaps } from "./capabilities";
import {
  type PluginsFormState,
  MAX_SCHEDULE_PROMPT_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  buildPluginsPayload,
  githubHasWatch,
  hydratePluginsState,
  parseAuthorList,
  validateForm,
} from "./form-logic";

// ---------------------------------------------------------------------------
// Shared input styling
// ---------------------------------------------------------------------------

const INPUT_CLASS =
  "w-full rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-sm text-[#fafafa] placeholder-zinc-600 transition-colors focus:border-honey-500/50 focus:outline-none focus:ring-1 focus:ring-honey-500/20 disabled:cursor-not-allowed disabled:opacity-60";
const LABEL_CLASS = "mb-1.5 block text-xs font-medium text-zinc-400";

type FormMode = "create" | "edit";

type MetaState =
  | { kind: "loading" }
  | { kind: "loaded"; meta: FleetMetaResponse }
  | { kind: "error"; message: string };

type TokensState =
  | { kind: "loading" }
  | { kind: "loaded"; tokens: TokenSummary[] }
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
      return "One of the selected repos isn't accessible to the Hivemoot Bot. Install the bot on that repo (or deselect it), then try again.";
    case FLEET_ERROR_CODE.REPOS_UNAVAILABLE:
      return "Couldn't list the installation's repos right now. Please retry in a moment.";
    case FLEET_ERROR_CODE.NAME_TAKEN:
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

function CheckRow({
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

function InlineWarning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-400">
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Skills multi-select (builtin grid)
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
  const entries = catalog.filter((s) => s.source === "builtin");
  if (entries.length === 0) {
    return <p className="text-sm text-zinc-500">No skills available.</p>;
  }
  return (
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
  );
}

// ---------------------------------------------------------------------------
// Plugin shell — the toggle + revealed config
// ---------------------------------------------------------------------------

function PluginShell({
  enabled,
  onToggle,
  title,
  description,
  children,
}: {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        enabled ? "border-honey-500/30 bg-honey-500/[0.03]" : "border-white/[0.06] bg-white/[0.02]"
      }`}
    >
      <CheckRow checked={enabled} onChange={onToggle} label={title} description={description} />
      {enabled && children && (
        <div className="mt-4 space-y-4 border-t border-white/[0.04] pt-4">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub plugin config — repos multi-select + watches + author list + poll
// ---------------------------------------------------------------------------

function ReposPicker({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  if (available.length === 0) {
    return (
      <div className="space-y-1.5">
        <span className={LABEL_CLASS + " mb-0"}>
          Repositories <span className="text-red-400/70">(required)</span>
        </span>
        <InlineWarning>
          Couldn&apos;t list this installation&apos;s repos. Reload the form to retry — the server
          resolves repos against the installation on save.
        </InlineWarning>
      </div>
    );
  }

  const lower = filter.trim().toLowerCase();
  const shown = lower ? available.filter((r) => r.toLowerCase().includes(lower)) : available;

  function toggle(repo: string) {
    if (selectedSet.has(repo)) onChange(selected.filter((r) => r !== repo));
    else onChange([...selected, repo]);
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={LABEL_CLASS + " mb-0"}>
          Repositories <span className="text-red-400/70">(required)</span>
        </span>
        <span className="text-xs text-zinc-600">
          {selected.length} of {available.length} selected
        </span>
      </div>
      <div className="mb-2 flex gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter repos…"
          className={INPUT_CLASS}
        />
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...available])}>
          All
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([])}>
          None
        </Button>
      </div>
      <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
        {shown.length === 0 ? (
          <p className="px-1 py-2 text-xs text-zinc-600">No repos match “{filter}”.</p>
        ) : (
          shown.map((repo) => (
            <label key={repo} className="flex cursor-pointer items-center gap-2.5 px-1 py-0.5">
              <input
                type="checkbox"
                checked={selectedSet.has(repo)}
                onChange={() => toggle(repo)}
                className="h-4 w-4 accent-honey-500"
              />
              <span className="font-mono text-xs text-zinc-300">{repo}</span>
            </label>
          ))
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-600">
        Repos the agent watches/acts on. All accessible repos are selected by default.
      </p>
    </div>
  );
}

function GithubConfig({
  github,
  available,
  onChange,
}: {
  github: PluginsFormState["github"];
  available: string[];
  onChange: (next: Partial<PluginsFormState["github"]>) => void;
}) {
  const watchValid = githubHasWatch(github);
  return (
    <div className="space-y-4">
      <ReposPicker
        available={available}
        selected={github.repos}
        onChange={(repos) => onChange({ repos })}
      />

      <div className="space-y-2.5">
        <p className={LABEL_CLASS + " mb-0"}>Watches</p>
        <CheckRow
          checked={github.watch_new_prs}
          onChange={(watch_new_prs) => onChange({ watch_new_prs })}
          label="New PRs"
        />
        <CheckRow
          checked={github.watch_review_requests}
          onChange={(watch_review_requests) => onChange({ watch_review_requests })}
          label="Review requests"
        />
        <CheckRow
          checked={github.watch_mentions}
          onChange={(watch_mentions) => onChange({ watch_mentions })}
          label="Mentions"
        />
        {!watchValid && (
          <InlineWarning>
            Enable at least one watch — a GitHub plugin that watches nothing has no trigger.
          </InlineWarning>
        )}
      </div>

      {github.watch_new_prs && (
        <div>
          <label htmlFor="gh-pr-authors" className={LABEL_CLASS}>
            New-PR author allowlist{" "}
            <span className="text-zinc-600">(comma/space-separated, optional)</span>
          </label>
          <input
            id="gh-pr-authors"
            type="text"
            value={(github.watch_new_prs_authors ?? []).join(", ")}
            onChange={(e) => onChange({ watch_new_prs_authors: parseAuthorList(e.target.value) })}
            placeholder="Leave empty to react to all authors"
            className={INPUT_CLASS}
          />
          <p className="mt-1 text-xs text-zinc-600">
            Empty = every author. Otherwise only these GitHub logins (max 50). Only meaningful with
            “New PRs”.
          </p>
        </div>
      )}

      <NumberField
        id="gh-poll"
        label="Poll interval (seconds)"
        value={github.poll_interval_secs}
        min={30}
        max={3600}
        onChange={(poll_interval_secs) => onChange({ poll_interval_secs })}
        hint="How often to scan GitHub. 30–3600s (default 300)."
      />
    </div>
  );
}

function ScheduleConfig({
  schedule,
  onChange,
}: {
  schedule: PluginsFormState["schedule"];
  onChange: (next: Partial<PluginsFormState["schedule"]>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField
          id="schedule-interval"
          label="Interval (seconds)"
          value={schedule.interval_secs}
          min={300}
          max={604800}
          onChange={(interval_secs) => onChange({ interval_secs })}
          hint="Between runs. 300s (5m) – 604800s (7d). Default 21600 (6h)."
        />
        <NumberField
          id="schedule-jitter"
          label="Jitter (seconds)"
          value={schedule.jitter_secs}
          min={0}
          max={3600}
          onChange={(jitter_secs) => onChange({ jitter_secs })}
          hint="Random delay per run. ≤ interval, ≤ 3600s. Default 600 (10m)."
        />
      </div>
      <div>
        <label htmlFor="schedule-prompt" className={LABEL_CLASS}>
          Schedule prompt <span className="text-red-400/70">(required)</span>
        </label>
        <textarea
          id="schedule-prompt"
          rows={3}
          value={schedule.prompt}
          maxLength={MAX_SCHEDULE_PROMPT_CHARS}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="What should the agent do on each scheduled run?"
          className={`${INPUT_CLASS} resize-y`}
        />
        <p className="mt-1 text-right text-xs text-zinc-600">
          {schedule.prompt.length.toLocaleString()} / {MAX_SCHEDULE_PROMPT_CHARS.toLocaleString()}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins section
// ---------------------------------------------------------------------------

function PluginsSection({
  plugins,
  setPlugins,
  installationRepos,
}: {
  plugins: PluginsFormState;
  setPlugins: (next: PluginsFormState) => void;
  installationRepos: string[];
}) {
  function patchGithub(next: Partial<PluginsFormState["github"]>) {
    setPlugins({ ...plugins, github: { ...plugins.github, ...next } });
  }
  function patchSchedule(next: Partial<PluginsFormState["schedule"]>) {
    setPlugins({ ...plugins, schedule: { ...plugins.schedule, ...next } });
  }

  return (
    <div className="space-y-3">
      <PluginShell
        enabled={plugins.github.enabled}
        onToggle={(enabled) =>
          setPlugins({
            ...plugins,
            github: {
              ...plugins.github,
              enabled,
              // First enable with nothing selected ⇒ default to all accessible repos.
              repos:
                enabled && plugins.github.repos.length === 0
                  ? [...installationRepos]
                  : plugins.github.repos,
            },
          })
        }
        title="GitHub"
        description="Watch repositories for PRs, review requests, and mentions."
      >
        <GithubConfig github={plugins.github} available={installationRepos} onChange={patchGithub} />
      </PluginShell>

      <PluginShell
        enabled={plugins.schedule.enabled}
        onToggle={(enabled) => setPlugins({ ...plugins, schedule: { ...plugins.schedule, enabled } })}
        title="Schedule"
        description="Run the agent on a fixed interval with a standing prompt."
      >
        <ScheduleConfig schedule={plugins.schedule} onChange={patchSchedule} />
      </PluginShell>

      <PluginShell
        enabled={plugins.tasks.enabled}
        onToggle={(enabled) => setPlugins({ ...plugins, tasks: { enabled } })}
        title="Tasks"
        description="Claims tasks from the dashboard queue."
      >
        <p className="text-xs text-zinc-500">
          No extra settings — the agent claims dispatched tasks from the dashboard task queue.
        </p>
      </PluginShell>

      <PluginShell
        enabled={plugins.war_rooms.enabled}
        onToggle={(enabled) =>
          setPlugins({ ...plugins, war_rooms: { ...plugins.war_rooms, enabled } })
        }
        title="War Rooms"
        description="Participate in war-room governance discussions."
      >
        <CheckRow
          checked={plugins.war_rooms.contribute}
          onChange={(contribute) =>
            setPlugins({ ...plugins, war_rooms: { ...plugins.war_rooms, contribute } })
          }
          label="Contribute (vs observe only)"
          description="On = the agent posts contributions. Off = it only watches/reads."
        />
      </PluginShell>

      {/* Queen row — disabled, dashboard cannot grant it. */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 opacity-60">
        <CheckRow
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

// ---------------------------------------------------------------------------
// Token picker — link an EXISTING capability token (nothing is minted)
// ---------------------------------------------------------------------------

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
  capabilityWarning,
  onRetry,
}: {
  tokensState: TokensState;
  selectedName: string;
  onSelect: (name: string) => void;
  selectedToken: TokenSummary | undefined;
  /** Non-blocking ⚠ warning when the token can't cover an enabled plugin. */
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
        No agent tokens yet. Create a capability token on{" "}
        <a href="/dashboard/settings/byok" className="underline hover:text-amber-300">
          Credentials
        </a>{" "}
        first, then link it here.
      </ErrorBanner>
    );
  }

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
          The agent acts through this existing token — it provides the agent&apos;s capabilities (not
          its repos). Manage tokens on{" "}
          <a href="/dashboard/settings/byok" className="underline hover:text-zinc-400">
            Credentials
          </a>
          .
        </p>
      </div>

      {selectedToken && (
        <div className="space-y-3 rounded-lg border border-white/[0.04] bg-white/[0.02] p-4">
          <div>
            <p className="mb-1.5 text-xs font-medium text-zinc-400">Token capabilities</p>
            <CapabilityChips caps={selectedToken.capabilities} />
          </div>
          {capabilityWarning && <InlineWarning>{capabilityWarning}</InlineWarning>}
        </div>
      )}
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

  // Prefill (create-only) from ?name= for the "Adopt" flow.
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
  const [plugins, setPlugins] = useState<PluginsFormState>(() =>
    hydratePluginsState(defaultPlugins(), initial?.plugins),
  );

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Seed create-mode defaults exactly once when the catalog first arrives:
  // pre-check standard skills + default the engine to the first catalog entry.
  // Never on edit (the saved config is authoritative).
  const seededRef = useRef(isEdit);

  // ---- load meta ----
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
    const run = () => void loadMeta();
    run();
  }, [loadMeta]);

  // ---- load linkable tokens ----
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

  // The token the operator linked (resolved against the loaded catalog).
  const selectedToken = useMemo<TokenSummary | undefined>(() => {
    if (tokensState.kind !== "loaded" || !agentTokenName) return undefined;
    return tokensState.tokens.find((t) => t.name === agentTokenName);
  }, [tokensState, agentTokenName]);

  // Non-blocking ⚠ warning when the linked token can't grant what an enabled
  // plugin needs (tasks/war_rooms). The token is INDEPENDENT of the agent — the
  // backend never rejects on this, so we never hard-block; we just inform.
  const capabilityWarning = useMemo<string | null>(() => {
    if (!selectedToken) return null;
    const gaps = detectCapabilityGaps(plugins, selectedToken.capabilities);
    return describeCapabilityGaps(gaps);
  }, [selectedToken, plugins]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const validationError = validateForm({
      isEdit,
      name,
      displayName,
      engine,
      agentTokenName,
      systemPrompt,
      plugins,
    });
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError(null);

    const trimmedDisplay = displayName.trim();
    const pluginsPayload = buildPluginsPayload(plugins);

    try {
      let res: Response;
      if (isEdit) {
        const body: UpdateAgentPayload = {
          display_name: trimmedDisplay.length > 0 ? trimmedDisplay : null,
          engine,
          skills: Array.from(skills),
          system_prompt: systemPrompt,
          plugins: pluginsPayload,
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
          plugins: pluginsPayload,
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
        router.refresh();
        router.push(`/dashboard/agents/${encodeURIComponent(data.agent.name)}`);
        return;
      }

      const data = (await res.json()) as CreateAgentResponse;
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

  const { skills_catalog, engine_catalog, installation_repos } = meta.meta;

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

      {/* Acts as (Token) */}
      <Card padding="md" className="space-y-4">
        <SectionHeader
          title="Acts as"
          description="The existing capability token this agent acts through. It provides the agent's capabilities (not its repos)."
        />
        <TokenPicker
          tokensState={tokensState}
          selectedName={agentTokenName}
          onSelect={setAgentTokenName}
          selectedToken={selectedToken}
          capabilityWarning={capabilityWarning}
          onRetry={loadTokens}
        />
      </Card>

      {/* Engine */}
      <Card padding="md" className="space-y-5">
        <SectionHeader title="Engine" description="The model/tool this agent runs on." />
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

      {/* Plugins */}
      <Card padding="md" className="space-y-4">
        <SectionHeader
          title="Plugins"
          description="Enable the capabilities this agent should have, and configure each. At least one plugin is required."
        />
        <PluginsSection
          plugins={plugins}
          setPlugins={setPlugins}
          installationRepos={installation_repos}
        />
      </Card>

      {/* Skills */}
      <Card padding="md" className="space-y-4">
        <SectionHeader
          title="Skills"
          description={`Knowledge bundled into the agent's runtime. ${skills.size} selected.`}
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
    </form>
  );
}
