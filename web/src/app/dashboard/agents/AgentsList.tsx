"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  ButtonLink,
  EmptyState,
  ErrorBanner,
  LoadingState,
  SectionHeader,
  StatusBadge,
} from "@/app/dashboard/ui";
import type { AgentListEntry, ObservedAgent } from "./types";
import {
  BotIcon,
  EngineIcon,
  enabledPluginKeys,
  healthLabel,
  healthTone,
  PLUGIN_LABELS,
  PlusIcon,
  relativeTime,
  TokenIcon,
} from "./shared";

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds — mirrors AgentHealthDashboard

// ---------------------------------------------------------------------------
// Plugin chips
// ---------------------------------------------------------------------------

function PluginChips({ agent }: { agent: AgentListEntry }) {
  const keys = enabledPluginKeys(agent.plugins);
  if (keys.length === 0) {
    return <span className="text-[11px] text-zinc-600">No plugins enabled</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((k) => (
        <span
          key={k}
          className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-zinc-400"
        >
          {PLUGIN_LABELS[k]}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registered agent card
// ---------------------------------------------------------------------------

function AgentCard({ agent }: { agent: AgentListEntry }) {
  const lastRun = agent.health?.received_at ?? agent.updated_at;
  return (
    <Link
      href={`/dashboard/agents/${encodeURIComponent(agent.name)}`}
      className="group flex flex-col rounded-2xl border border-white/[0.06] bg-[#141414] p-5 transition-colors hover:border-white/10"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#fafafa]">
            {agent.display_name || agent.name}
          </p>
          {agent.display_name && (
            <p className="truncate font-mono text-[11px] text-zinc-600">{agent.name}</p>
          )}
        </div>
        {agent.enabled ? (
          <StatusBadge
            tone={healthTone(agent.health?.status ?? "unknown")}
            label={healthLabel(agent.health?.status ?? "unknown")}
          />
        ) : (
          <StatusBadge tone="zinc" label="Paused" />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <EngineIcon className="h-3.5 w-3.5 text-zinc-600" />
          <span className="font-mono">{agent.engine}</span>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <TokenIcon className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
          <span className="truncate font-mono">{agent.agent_token_name}</span>
        </span>
      </div>

      <div className="mt-3">
        <PluginChips agent={agent} />
      </div>

      <div className="mt-auto pt-3 text-xs text-zinc-600" suppressHydrationWarning>
        {agent.health ? `Last run ${relativeTime(lastRun)}` : "No runs yet"}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Observed (unregistered) row
// ---------------------------------------------------------------------------

function ObservedRow({ entry }: { entry: ObservedAgent }) {
  // Health is per-agent now (no repo) — the adopt deep-link only prefills the
  // name; repos come from the github plugin the operator configures.
  const adoptHref = `/dashboard/agents/new?name=${encodeURIComponent(entry.agent_id)}`;
  return (
    <li className="flex items-center justify-between gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-[#fafafa]">
            {entry.agent_id}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          <span suppressHydrationWarning>Last seen {relativeTime(entry.received_at)}</span>
        </div>
      </div>
      <ButtonLink href={adoptHref} variant="secondary" size="sm">
        <PlusIcon className="h-3.5 w-3.5" />
        Adopt
      </ButtonLink>
    </li>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function AgentsList() {
  const [agents, setAgents] = useState<AgentListEntry[]>([]);
  const [observed, setObserved] = useState<ObservedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/fleet/agents", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) {
          setError("Session expired — please log in again.");
          return;
        }
        setError("Failed to load agents.");
        return;
      }
      const data = (await res.json()) as {
        agents?: AgentListEntry[];
        observed?: ObservedAgent[];
      };
      setAgents(data.agents ?? []);
      setObserved(data.observed ?? []);
      setError(null);
    } catch {
      setError("Network error — could not reach server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  if (loading) {
    return <LoadingState label="Loading agents…" />;
  }

  if (error) {
    return <ErrorBanner tone="red">{error}</ErrorBanner>;
  }

  if (agents.length === 0 && observed.length === 0) {
    return (
      <EmptyState
        icon={<BotIcon className="h-5 w-5" />}
        title="No agents yet"
        description="Register an agent to start automating work on your repos — schedules, PR reviews, mentions, tasks, and war rooms."
        action={
          <ButtonLink href="/dashboard/agents/new" variant="primary" size="md">
            <PlusIcon className="h-4 w-4" />
            New Agent
          </ButtonLink>
        }
      />
    );
  }

  return (
    <div className="space-y-8">
      {agents.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))}
        </div>
      )}

      {observed.length > 0 && (
        <section>
          <SectionHeader
            title="Observed (unregistered)"
            description="Agents reporting health that aren't in the registry yet — likely statically deployed. Adopt one to manage it from here."
            className="mb-3"
          />
          <ul className="divide-y divide-white/[0.04] overflow-hidden rounded-2xl border border-white/[0.06] bg-[#141414]">
            {observed.map((entry) => (
              <ObservedRow key={entry.agent_id} entry={entry} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
