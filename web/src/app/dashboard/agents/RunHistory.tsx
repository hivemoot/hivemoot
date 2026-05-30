"use client";

import { MarkdownContent } from "../MarkdownContent";
import { EmptyState } from "@/app/dashboard/ui";
import type { HealthReport, RunTriggerType, TokenUsage } from "./types";
import {
  cacheHitRate,
  ChevronIcon,
  formatDuration,
  formatTokens,
  primaryModel,
  relativeTime,
  TokenIcon,
} from "./shared";

// ---------------------------------------------------------------------------
// Trigger badge (mirrors AgentHealthDashboard.TriggerBadge)
// ---------------------------------------------------------------------------

const TRIGGER_BADGE_CONFIG: Record<RunTriggerType, { label: string; className: string }> = {
  scheduled: { label: "scheduled", className: "text-zinc-500 bg-zinc-500/10" },
  mention: { label: "@mention", className: "text-blue-400/80 bg-blue-500/10" },
  manual: { label: "manual", className: "text-amber-400/80 bg-amber-500/10" },
  task: { label: "task", className: "text-honey-400/80 bg-honey-500/10" },
};

function TriggerBadge({ trigger }: { trigger: RunTriggerType }) {
  const cfg = TRIGGER_BADGE_CONFIG[trigger] ?? {
    label: trigger,
    className: "text-zinc-500 bg-zinc-500/10",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Token usage summary (mirrors AgentHealthDashboard.TokenSummary)
// ---------------------------------------------------------------------------

function TokenSummary({ tu }: { tu: TokenUsage }) {
  const hitRate = cacheHitRate(tu);
  const breakdown = tu.model_breakdown ? Object.entries(tu.model_breakdown) : [];
  const model = primaryModel(tu);

  return (
    <div className="mt-2 space-y-1.5 text-xs text-zinc-500">
      {model && <p className="font-mono text-[11px] text-zinc-500">{model}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {tu.cost_usd != null && <span className="text-zinc-300">${tu.cost_usd.toFixed(2)}</span>}
        <span className="inline-flex items-center gap-1.5" title="Token usage: input / output">
          <TokenIcon className="h-3 w-3 text-zinc-600" />
          <span className="text-zinc-400">{formatTokens(tu.input_tokens)}</span>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-400">{formatTokens(tu.output_tokens)}</span>
        </span>
        {hitRate && (
          <span title="Percentage of input tokens served from prompt cache">
            <span className="text-green-400/80">{hitRate}</span>
            {" cached"}
          </span>
        )}
        {tu.num_turns > 1 && (
          <span title="Number of tool-use turns (agentic loops)">
            <span className="text-zinc-400">{tu.num_turns}</span>
            {" turns"}
          </span>
        )}
      </div>
      {breakdown.length > 1 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-zinc-600 hover:text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <ChevronIcon className="h-2.5 w-2.5 transition-transform group-open:rotate-90" />
              {breakdown.length} models
            </span>
          </summary>
          <div className="mt-1.5 space-y-0.5 pl-4">
            {breakdown.map(([modelId, mu]) => (
              <div key={modelId} className="flex items-center gap-2 font-mono text-[10px]">
                <span className="min-w-0 flex-1 truncate text-zinc-600">{modelId}</span>
                <span>{formatTokens(mu.input_tokens ?? 0)} in</span>
                <span>{formatTokens(mu.output_tokens ?? 0)} out</span>
                {mu.cost_usd != null && (
                  <span className="text-zinc-400">${mu.cost_usd.toFixed(2)}</span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run history list
// ---------------------------------------------------------------------------

export function RunHistory({ runs }: { runs: HealthReport[] }) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="Once this agent reports a run, its history appears here. Reports are retained for 24 hours."
      />
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((entry, i) => {
        const failed = entry.outcome === "failure" || entry.outcome === "timeout";
        return (
          <div
            key={`${entry.run_id}-${entry.received_at}-${i}`}
            className="rounded-lg border border-white/[0.06] bg-[#141414] px-4 py-3"
          >
            <div className="flex items-start gap-4">
              <div className="mt-0.5 flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    failed ? "bg-red-400" : entry.outcome === "success" ? "bg-green-400" : "bg-zinc-500"
                  }`}
                />
                <span
                  className={`text-xs font-medium ${
                    failed ? "text-red-400" : entry.outcome === "success" ? "text-green-400" : "text-zinc-400"
                  }`}
                >
                  {entry.outcome}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm text-zinc-300">
                    {entry.run_id}
                    {entry.duration_secs !== undefined && (
                      <span className="ml-2 text-zinc-500">{formatDuration(entry.duration_secs)}</span>
                    )}
                  </p>
                  {entry.trigger && <TriggerBadge trigger={entry.trigger} />}
                </div>
                {entry.error && <p className="mt-0.5 text-sm text-red-400">{entry.error}</p>}
                {entry.exit_code !== undefined && entry.exit_code !== 0 && (
                  <p className="text-xs text-zinc-500">exit code {entry.exit_code}</p>
                )}
                {entry.run_summary && (
                  <details className="group mt-1.5">
                    <summary className="cursor-pointer list-none text-xs text-zinc-600 hover:text-zinc-500">
                      <span className="inline-flex items-center gap-1">
                        <ChevronIcon className="h-2.5 w-2.5 transition-transform group-open:rotate-90" />
                        run summary
                      </span>
                    </summary>
                    <div className="mt-1.5">
                      <MarkdownContent className="text-xs">{entry.run_summary}</MarkdownContent>
                    </div>
                  </details>
                )}
                {entry.token_usage && <TokenSummary tu={entry.token_usage} />}
              </div>
              <span className="shrink-0 text-xs text-zinc-600" suppressHydrationWarning>
                {relativeTime(entry.received_at)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
