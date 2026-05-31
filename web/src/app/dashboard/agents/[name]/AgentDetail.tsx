"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Button,
  Card,
  ErrorBanner,
  LoadingState,
  PageHeader,
  SectionHeader,
  StatusBadge,
} from "@/app/dashboard/ui";
import { AgentConfigForm } from "../AgentConfigForm";
import { RunHistory } from "../RunHistory";
import type {
  AgentDetailResponse,
  FleetAgent,
  FleetErrorBody,
  GithubPlugin,
  HealthReport,
  SchedulePlugin,
  WarRoomsPlugin,
} from "../types";
import { PLUGIN_LABELS } from "../types";
import {
  ArrowLeftIcon,
  EngineIcon,
  enabledPluginKeys,
  outcomeTone,
  relativeTime,
  TokenIcon,
} from "../shared";

const REFRESH_INTERVAL_MS = 30_000; // 30s — matches the rest of the dashboard

/**
 * Status badge for the detail header/overview. The detail endpoint returns a
 * plain FleetAgent (no joined `health` field — that's only on the list), so we
 * derive a tone/label from the most recent run's outcome. A paused agent always
 * reads "Paused" regardless of its last run.
 */
function RunStatusBadge({ enabled, latestRun }: { enabled: boolean; latestRun?: HealthReport }) {
  if (!enabled) return <StatusBadge tone="zinc" label="Paused" />;
  if (!latestRun) return <StatusBadge tone="zinc" label="No runs yet" />;
  const label =
    latestRun.outcome === "success"
      ? "OK"
      : latestRun.outcome === "timeout"
        ? "Timed out"
        : "Failed";
  return <StatusBadge tone={outcomeTone(latestRun.outcome)} label={label} />;
}

type Tab = "overview" | "runs" | "configuration";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "runs", label: "Runs" },
  { id: "configuration", label: "Configuration" },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; agent: FleetAgent; runs: HealthReport[] }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export function AgentDetail({ name }: { name: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("overview");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sessionExpired, setSessionExpired] = useState(false);

  // Pause/resume + delete action state.
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Avoid clobbering a fresh load with a slow in-flight poll response.
  const requestIdRef = useRef(0);

  const fetchDetail = useCallback(
    async ({ spinner = false }: { spinner?: boolean } = {}) => {
      const requestId = ++requestIdRef.current;
      if (spinner) setState({ kind: "loading" });
      try {
        const res = await fetch(`/api/dashboard/fleet/agents/${encodeURIComponent(name)}`, {
          cache: "no-store",
        });
        if (requestId !== requestIdRef.current) return;

        if (res.status === 401) {
          setSessionExpired(true);
          return;
        }
        if (res.status === 404) {
          setState({ kind: "not_found" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: `Failed to load agent (HTTP ${res.status}).` });
          return;
        }
        const data = (await res.json()) as AgentDetailResponse;
        if (requestId !== requestIdRef.current) return;
        setState({ kind: "loaded", agent: data.agent, runs: data.runs ?? [] });
      } catch {
        if (requestId !== requestIdRef.current) return;
        setState({ kind: "error", message: "Network error — could not reach server." });
      }
    },
    [name],
  );

  useEffect(() => {
    void fetchDetail({ spinner: true });
    const interval = setInterval(() => void fetchDetail(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchDetail]);

  async function handleToggleEnabled(nextEnabled: boolean) {
    if (togglingEnabled) return;
    setTogglingEnabled(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/dashboard/fleet/agents/${encodeURIComponent(name)}/enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (res.status === 401) {
        setSessionExpired(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ message: "" }))) as FleetErrorBody;
        setActionError(body.message || `Failed to ${nextEnabled ? "resume" : "pause"} the agent.`);
        return;
      }
      const data = (await res.json()) as { agent: FleetAgent };
      setState((prev) =>
        prev.kind === "loaded" ? { ...prev, agent: data.agent } : prev,
      );
    } catch {
      setActionError("Network error — could not reach server.");
    } finally {
      setTogglingEnabled(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;
    if (
      !confirm(
        `Delete agent "${name}"? This removes it from the registry. The linked token is NOT revoked — manage or revoke it on Credentials. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/dashboard/fleet/agents/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (res.status === 401) {
        setSessionExpired(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({ message: "" }))) as FleetErrorBody;
        setActionError(body.message || "Failed to delete the agent.");
        setDeleting(false);
        return;
      }
      router.push("/dashboard/agents");
    } catch {
      setActionError("Network error — could not reach server.");
      setDeleting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render guards
  // -------------------------------------------------------------------------

  const backLink = (
    <Link
      href="/dashboard/agents"
      className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-300"
    >
      <ArrowLeftIcon className="h-3.5 w-3.5" />
      Back to agents
    </Link>
  );

  if (sessionExpired) {
    return (
      <>
        {backLink}
        <ErrorBanner tone="red">
          Session expired.{" "}
          <a href="/setup" className="underline hover:text-red-300">
            Re-authenticate via Setup
          </a>{" "}
          to manage agents.
        </ErrorBanner>
      </>
    );
  }

  if (state.kind === "loading") {
    return (
      <>
        {backLink}
        <LoadingState label="Loading agent…" />
      </>
    );
  }

  if (state.kind === "not_found") {
    return (
      <>
        {backLink}
        <ErrorBanner tone="amber">
          Agent <span className="font-mono">{name}</span> not found. It may have been deleted.
        </ErrorBanner>
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <>
        {backLink}
        <ErrorBanner tone="red">{state.message}</ErrorBanner>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          className="mt-4"
          onClick={() => void fetchDetail({ spinner: true })}
        >
          Retry
        </Button>
      </>
    );
  }

  const { agent, runs } = state;

  return (
    <>
      {backLink}

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {agent.display_name || agent.name}
            <RunStatusBadge enabled={agent.enabled} latestRun={runs[0]} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {agent.display_name && <span className="font-mono text-zinc-500">{agent.name}</span>}
            <span className="inline-flex items-center gap-1.5">
              <EngineIcon className="h-3.5 w-3.5 text-zinc-600" />
              <span className="font-mono">{agent.engine}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <TokenIcon className="h-3.5 w-3.5 text-zinc-600" />
              <span className="font-mono">{agent.agent_token_name}</span>
            </span>
          </span>
        }
      />

      {/* Tabs */}
      <div className="mb-6 -mt-2 flex gap-6 border-b border-white/[0.06]">
        {TABS.map((t) => {
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={isActive}
              className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
                isActive
                  ? "border-honey-500 text-[#fafafa]"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
              {t.id === "runs" && runs.length > 0 && (
                <span className="ml-1.5 text-xs text-zinc-600">{runs.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {actionError && (
        <div className="mb-6">
          <ErrorBanner tone="red">{actionError}</ErrorBanner>
        </div>
      )}

      {tab === "overview" && (
        <OverviewTab
          agent={agent}
          latestRun={runs[0]}
          togglingEnabled={togglingEnabled}
          deleting={deleting}
          onToggleEnabled={handleToggleEnabled}
          onDelete={handleDelete}
        />
      )}

      {tab === "runs" && <RunHistory runs={runs} />}

      {tab === "configuration" && (
        <AgentConfigForm key={agent.config_version} mode="edit" initial={agent} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

function OverviewTab({
  agent,
  latestRun,
  togglingEnabled,
  deleting,
  onToggleEnabled,
  onDelete,
}: {
  agent: FleetAgent;
  latestRun?: HealthReport;
  togglingEnabled: boolean;
  deleting: boolean;
  onToggleEnabled: (next: boolean) => void;
  onDelete: () => void;
}) {
  const pluginKeys = enabledPluginKeys(agent.plugins);
  return (
    <div className="space-y-6">
      {/* Summary */}
      <Card padding="md">
        <SectionHeader title="Details" className="mb-4" />
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <Detail label="Engine" value={<span className="font-mono">{agent.engine}</span>} />
          <Detail
            label="Acts as (token)"
            value={
              <span className="inline-flex items-center gap-1.5 font-mono">
                <TokenIcon className="h-3.5 w-3.5 text-zinc-600" />
                {agent.agent_token_name}
              </span>
            }
          />
          <Detail
            label="Last run"
            value={
              latestRun ? (
                <span suppressHydrationWarning>{relativeTime(latestRun.received_at)}</span>
              ) : (
                <span className="text-zinc-500">No runs yet</span>
              )
            }
          />
          <Detail label="Created by" value={agent.created_by} />
          <Detail
            label="Updated"
            value={<span suppressHydrationWarning>{relativeTime(agent.updated_at)}</span>}
          />
        </dl>
        <p className="mt-4 text-xs text-zinc-600">
          The linked token provides this agent&apos;s capabilities (not its repos). Repos live under
          the GitHub plugin below. Manage the token on Credentials.
        </p>
      </Card>

      {/* Plugins (with settings) */}
      <Card padding="md">
        <SectionHeader title="Plugins" className="mb-3" />
        {pluginKeys.length === 0 ? (
          <p className="text-sm text-zinc-500">No plugins enabled.</p>
        ) : (
          <div className="space-y-3">
            {pluginKeys.map((k) => (
              <div
                key={k}
                className="space-y-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4"
              >
                <StatusBadge tone="honey" label={PLUGIN_LABELS[k]} />
                {k === "github" && agent.plugins.github && (
                  <GithubPluginDetail g={agent.plugins.github} />
                )}
                {k === "schedule" && agent.plugins.schedule && (
                  <SchedulePluginDetail s={agent.plugins.schedule} />
                )}
                {k === "tasks" && (
                  <p className="text-xs text-zinc-500">Claims tasks from the dashboard queue.</p>
                )}
                {k === "war_rooms" && agent.plugins.war_rooms && (
                  <WarRoomsPluginDetail w={agent.plugins.war_rooms} />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Skills */}
      <Card padding="md">
        <SectionHeader title="Skills" className="mb-3" />
        {agent.skills.length === 0 ? (
          <p className="text-sm text-zinc-500">No skills attached.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agent.skills.map((skill) => (
              <span
                key={skill}
                className="rounded-md bg-white/[0.05] px-2 py-1 font-mono text-xs text-zinc-300"
              >
                {skill}
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* State / danger zone */}
      <Card padding="md">
        <SectionHeader
          title="Agent state"
          description={
            agent.enabled
              ? "The agent is active and runs on its triggers."
              : "The agent is paused — it won't run until resumed."
          }
          className="mb-4"
        />
        <div className="flex flex-wrap items-center gap-3">
          {agent.enabled ? (
            <Button
              type="button"
              variant="secondary"
              size="md"
              disabled={togglingEnabled || deleting}
              onClick={() => onToggleEnabled(false)}
            >
              {togglingEnabled ? "Pausing…" : "Pause agent"}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={togglingEnabled || deleting}
              onClick={() => onToggleEnabled(true)}
            >
              {togglingEnabled ? "Resuming…" : "Resume agent"}
            </Button>
          )}
          <Button
            type="button"
            variant="danger"
            size="md"
            disabled={deleting || togglingEnabled}
            onClick={onDelete}
          >
            {deleting ? "Deleting…" : "Delete agent"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 text-zinc-300">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin detail blocks (read-only config view in the Overview tab)
// ---------------------------------------------------------------------------

function fmtSecs(secs: number): string {
  if (secs >= 86400 && secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

function PluginDetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <dt className="text-xs font-medium text-zinc-500">{label}</dt>
      <dd className="font-mono text-xs text-zinc-300">{value}</dd>
    </div>
  );
}

function GithubPluginDetail({ g }: { g: GithubPlugin }) {
  const watches = [
    g.watch_new_prs && "new PRs",
    g.watch_review_requests && "review requests",
    g.watch_mentions && "mentions",
  ].filter(Boolean) as string[];
  return (
    <dl className="space-y-1.5">
      <PluginDetailRow label="Repos" value={g.repos.length > 0 ? g.repos.join(", ") : "—"} />
      <PluginDetailRow label="Watches" value={watches.length > 0 ? watches.join(", ") : "—"} />
      {g.watch_new_prs && (g.watch_new_prs_authors?.length ?? 0) > 0 && (
        <PluginDetailRow label="PR authors" value={(g.watch_new_prs_authors ?? []).join(", ")} />
      )}
      <PluginDetailRow label="Poll" value={fmtSecs(g.poll_interval_secs)} />
    </dl>
  );
}

function SchedulePluginDetail({ s }: { s: SchedulePlugin }) {
  return (
    <dl className="space-y-1.5">
      <PluginDetailRow label="Every" value={fmtSecs(s.interval_secs)} />
      <PluginDetailRow label="Jitter" value={fmtSecs(s.jitter_secs)} />
      {s.prompt && (
        <div className="mt-2">
          <p className="text-xs font-medium text-zinc-500">Prompt</p>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg border border-white/[0.04] bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
            {s.prompt}
          </pre>
        </div>
      )}
    </dl>
  );
}

function WarRoomsPluginDetail({ w }: { w: WarRoomsPlugin }) {
  return (
    <dl className="space-y-1.5">
      <PluginDetailRow label="Mode" value={w.contribute ? "contribute" : "observe only"} />
    </dl>
  );
}
