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
  HealthReport,
} from "../types";
import {
  ArrowLeftIcon,
  EngineIcon,
  enabledTriggerKeys,
  outcomeTone,
  relativeTime,
  RepoIcon,
  TRIGGER_LABELS,
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
        `Delete agent "${name}"? This revokes its token immediately and removes it from the registry. This cannot be undone.`,
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
              <RepoIcon className="h-3.5 w-3.5 text-zinc-600" />
              {agent.repo}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <EngineIcon className="h-3.5 w-3.5 text-zinc-600" />
              <span className="font-mono">{agent.engine}</span>
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
  const triggerKeys = enabledTriggerKeys(agent.triggers);
  return (
    <div className="space-y-6">
      {/* Summary */}
      <Card padding="md">
        <SectionHeader title="Details" className="mb-4" />
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <Detail label="Repo" value={<span className="font-mono">{agent.repo}</span>} />
          <Detail label="Engine" value={<span className="font-mono">{agent.engine}</span>} />
          <Detail label="Duty" value={<span className="capitalize">{agent.duty}</span>} />
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
      </Card>

      {/* Triggers */}
      <Card padding="md">
        <SectionHeader title="Active triggers" className="mb-3" />
        {triggerKeys.length === 0 ? (
          <p className="text-sm text-zinc-500">No triggers enabled.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {triggerKeys.map((k) => (
              <StatusBadge key={k} tone="honey" label={TRIGGER_LABELS[k]} />
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
