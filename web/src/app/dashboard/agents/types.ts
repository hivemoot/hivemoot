/**
 * Client-side fleet-agent models for the Agents dashboard.
 *
 * These MIRROR the server contracts under `/api/dashboard/fleet/**`. Keep them
 * in sync with `@/server/fleet-store` (FleetAgent / AgentTriggers) and
 * `@/server/agent-health-store` (HealthReport). They are intentionally a
 * narrow client copy so the dashboard never imports server-only modules.
 */

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export interface ScheduleTriggerSettings {
  interval_secs: number;
  jitter_secs: number;
  prompt: string;
}

export interface PullRequestsTriggerSettings {
  watch_new_prs: boolean;
  watch_review_requests: boolean;
  author_allowlist: string[];
  poll_interval_secs: number;
}

export interface MentionsTriggerSettings {
  poll_interval_secs: number;
}

export interface WarRoomsTriggerSettings {
  contribute: boolean;
}

export interface AgentTriggers {
  schedule: { enabled: boolean; settings: ScheduleTriggerSettings };
  pull_requests: { enabled: boolean; settings: PullRequestsTriggerSettings };
  mentions: { enabled: boolean; settings: MentionsTriggerSettings };
  tasks: { enabled: boolean; settings: Record<string, never> };
  war_rooms: { enabled: boolean; settings: WarRoomsTriggerSettings };
}

/** Keys of `AgentTriggers` — used to iterate over trigger panels generically. */
export type TriggerKey = keyof AgentTriggers;

// ---------------------------------------------------------------------------
// Agent record
// ---------------------------------------------------------------------------

export type AgentDuty = "standing" | "dispatch";

export interface FleetAgent {
  name: string;
  display_name?: string;
  repo: string;
  engine: string;
  duty: AgentDuty;
  skills: string[];
  system_prompt: string;
  triggers: AgentTriggers;
  enabled: boolean;
  managed: boolean;
  agent_token_name: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  config_version: number;
}

// ---------------------------------------------------------------------------
// Health + runs
// ---------------------------------------------------------------------------

export type AgentHealthStatus = "ok" | "failed" | "late" | "unknown";

export interface AgentHealthView {
  status: AgentHealthStatus;
  received_at: string;
  outcome?: "success" | "failure" | "timeout";
  next_run_at?: string;
  run_summary?: string;
}

export interface ModelTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
  num_turns: number;
  model_breakdown: Record<string, ModelTokenUsage> | null;
}

export type RunTriggerType = "scheduled" | "mention" | "manual" | "task";

export interface HealthReport {
  run_id: string;
  outcome: "success" | "failure" | "timeout";
  duration_secs: number;
  consecutive_failures: number;
  model?: string;
  error?: string;
  exit_code?: number;
  next_run_at?: string;
  run_summary?: string;
  trigger?: RunTriggerType;
  token_usage?: TokenUsage | null;
  received_at: string;
}

// ---------------------------------------------------------------------------
// API envelopes
// ---------------------------------------------------------------------------

export interface ObservedAgent {
  agent_id: string;
  repo: string;
  status: string;
  received_at: string;
}

export interface AgentListEntry extends FleetAgent {
  health: AgentHealthView | null;
}

export interface AgentsListResponse {
  agents: AgentListEntry[];
  observed: ObservedAgent[];
}

export interface AgentDetailResponse {
  agent: FleetAgent;
  runs: HealthReport[];
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "apiary";
  standard: boolean;
}

export interface EngineCatalogEntry {
  id: string;
  label: string;
}

export interface FleetMetaResponse {
  skills_catalog: SkillCatalogEntry[];
  engine_catalog: EngineCatalogEntry[];
}

export interface CreateAgentResponse {
  agent: FleetAgent;
  token: string;
  token_fingerprint: string;
  message: string;
}

export interface UpdateAgentResponse {
  agent: FleetAgent;
}

/** Error envelope shared by every `/api/dashboard/fleet/**` route. */
export interface FleetErrorBody {
  code: string;
  message: string;
  field?: string;
  /** Present on NAME_TAKEN (the conflicting agent/token name). */
  name?: string;
  /** The shared require-installation 409 uses `error` (not `message`) with
   * `code: "installation_required"`. */
  error?: string;
}

/** The exact `code` strings the fleet routes emit (see `@/server/fleet-routes`). */
export const FLEET_ERROR_CODE = {
  INVALID_BODY: "fleet_invalid_body",
  VALIDATION: "fleet_validation",
  REPO_NOT_COVERED: "fleet_repo_not_covered",
  COVERAGE_CHECK_FAILED: "fleet_coverage_check_failed",
  NAME_TAKEN: "fleet_name_taken",
  NOT_FOUND: "fleet_not_found",
  AGENT_LIMIT_REACHED: "fleet_agent_limit_reached",
  RATE_LIMITED: "fleet_rate_limited",
  QUEEN_NOT_SUPPORTED: "fleet_queen_not_supported",
  LOCK_TIMEOUT: "fleet_lock_timeout",
  SERVER_ERROR: "fleet_server_error",
} as const;

// ---------------------------------------------------------------------------
// Defaults (used to seed the create form)
// ---------------------------------------------------------------------------

/**
 * Default trigger config for a brand-new agent. Intervals mirror the backend's
 * conventional defaults (5-min schedule poll, 60s PR/mention polls). Nothing is
 * enabled by default — the operator opts each trigger in.
 */
export function defaultTriggers(): AgentTriggers {
  return {
    schedule: {
      enabled: false,
      settings: { interval_secs: 300, jitter_secs: 30, prompt: "" },
    },
    pull_requests: {
      enabled: false,
      settings: {
        watch_new_prs: true,
        watch_review_requests: true,
        author_allowlist: [],
        poll_interval_secs: 60,
      },
    },
    mentions: {
      enabled: false,
      settings: { poll_interval_secs: 60 },
    },
    tasks: {
      enabled: false,
      settings: {},
    },
    war_rooms: {
      enabled: false,
      settings: { contribute: false },
    },
  };
}
