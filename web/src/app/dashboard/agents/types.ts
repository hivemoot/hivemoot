/**
 * Client-side fleet-agent models for the Agents dashboard.
 *
 * These MIRROR the server contracts under `/api/dashboard/fleet/**`. Keep them
 * in sync with `@/server/fleet-store` (FleetAgent / FleetPlugins) and
 * `@/server/agent-health-store` (HealthReport). They are intentionally a narrow
 * client copy so the dashboard never imports server-only modules.
 *
 * PLUGIN-FIRST MODEL (Stage 5): an agent's behaviour is the set of plugins it
 * enables. `repos` lives in exactly one place — `plugins.github.repos` — never
 * at the top level, never on the token. There is no `duty` and no flat
 * `triggers` object anymore.
 */

// ---------------------------------------------------------------------------
// Plugins — the enableable capabilities of an agent (mirror FleetPlugins)
// ---------------------------------------------------------------------------

/**
 * The `github` plugin — the ONLY place `repos` lives. The three watch flags are
 * the plugin's triggers; at least one must be on when the plugin is enabled.
 * `watch_new_prs_authors` is only meaningful alongside `watch_new_prs`
 * (empty/absent = react to every author).
 */
export interface GithubPlugin {
  enabled: boolean;
  repos: string[];
  watch_new_prs: boolean;
  watch_review_requests: boolean;
  watch_mentions: boolean;
  watch_new_prs_authors?: string[];
  poll_interval_secs: number;
}

export interface SchedulePlugin {
  enabled: boolean;
  interval_secs: number;
  jitter_secs: number;
  prompt: string;
}

/** Tasks plugin has no v1 config — it claims from the dashboard queue. */
export interface TasksPlugin {
  enabled: boolean;
}

export interface WarRoomsPlugin {
  enabled: boolean;
  /** false = observe only (watch+read); true = also present + contribute. */
  contribute: boolean;
}

/**
 * The set of plugins an agent can enable. Each is OPTIONAL. The dashboard form
 * always carries every plugin block (enabled or not) so the PATCH replace-set
 * semantics are unambiguous — but a stored record may omit unconfigured ones.
 */
export interface FleetPlugins {
  github?: GithubPlugin;
  schedule?: SchedulePlugin;
  tasks?: TasksPlugin;
  war_rooms?: WarRoomsPlugin;
}

/** Plugin keys in canonical render order. */
export type PluginKey = "github" | "schedule" | "tasks" | "war_rooms";

export const PLUGIN_ORDER: PluginKey[] = ["github", "schedule", "tasks", "war_rooms"];

export const PLUGIN_LABELS: Record<PluginKey, string> = {
  github: "GitHub",
  schedule: "Schedule",
  tasks: "Tasks",
  war_rooms: "War Rooms",
};

// ---------------------------------------------------------------------------
// Agent record
// ---------------------------------------------------------------------------

export interface FleetAgent {
  name: string;
  display_name?: string;
  engine: string;
  skills: string[];
  system_prompt: string;
  /** The enableable capabilities of this agent. `repos` lives ONLY under
   * `plugins.github.repos`. */
  plugins: FleetPlugins;
  enabled: boolean;
  managed: boolean;
  /** The existing capability token this agent is bound to (CAPABILITIES only —
   * no repo scope). */
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

/** Observed-only agent (reporting health, not registered). Per-agent, no repo. */
export interface ObservedAgent {
  agent_id: string;
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
  source: "builtin";
  standard: boolean;
}

export interface EngineCatalogEntry {
  id: string;
  label: string;
}

export interface FleetMetaResponse {
  skills_catalog: SkillCatalogEntry[];
  engine_catalog: EngineCatalogEntry[];
  /** The installation's accessible repos — pre-fills the github plugin's repo
   * picker. Best-effort: `[]` when the lister failed (the create/patch path
   * re-checks coverage fail-closed, so an empty pre-fill is safe). */
  installation_repos: string[];
}

/**
 * Create succeeds with just the agent — nothing is minted. The agent links an
 * EXISTING token, so there is no once-shown secret to surface.
 */
export interface CreateAgentResponse {
  agent: FleetAgent;
}

export interface UpdateAgentResponse {
  agent: FleetAgent;
}

// ---------------------------------------------------------------------------
// Create / update payloads (what the form POSTs / PATCHes)
// ---------------------------------------------------------------------------

/**
 * POST body — links an existing token; sends the canonical `plugins` object.
 * No top-level `repos` / `duty` / `triggers` — repos live only under
 * `plugins.github.repos`.
 */
export interface CreateAgentPayload {
  name: string;
  display_name?: string;
  engine: string;
  skills: string[];
  system_prompt: string;
  plugins: FleetPlugins;
  agent_token_name: string;
}

/**
 * PATCH body — every field optional; `display_name: null` clears the label.
 * `plugins` REPLACES the whole plugin set (the form always sends the complete
 * set the operator configured).
 */
export interface UpdateAgentPayload {
  display_name?: string | null;
  engine?: string;
  skills?: string[];
  system_prompt?: string;
  plugins?: FleetPlugins;
  agent_token_name?: string;
}

// ---------------------------------------------------------------------------
// Agent tokens (the linkable existing tokens)
// ---------------------------------------------------------------------------

/**
 * One row from `GET /api/dashboard/agent-tokens` → `{ tokens }`. Mirrors the
 * server's `AgentTokenSummaryV1` (metadata only — never the raw bearer). The
 * token carries CAPABILITIES only (no repo scope); `capabilities` drives the
 * soft capability warnings. This is the source for the Token dropdown.
 */
export interface TokenSummary {
  name: string;
  agent_role: string;
  capabilities: string[];
  fingerprint: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
}

/** Envelope for `GET /api/dashboard/agent-tokens`. */
export interface AgentTokensResponse {
  tokens: TokenSummary[];
  presets: string[];
  capabilities: string[];
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
  /** Couldn't list installation repos (transient GitHub/App error). */
  REPOS_UNAVAILABLE: "fleet_repos_unavailable",
  NAME_TAKEN: "fleet_name_taken",
  NOT_FOUND: "fleet_not_found",
  AGENT_LIMIT_REACHED: "fleet_agent_limit_reached",
  RATE_LIMITED: "fleet_rate_limited",
  QUEEN_NOT_SUPPORTED: "fleet_queen_not_supported",
  /** Selected `agent_token_name` doesn't exist in the installation. */
  INVALID_TOKEN: "fleet_invalid_token",
  LOCK_TIMEOUT: "fleet_lock_timeout",
  SERVER_ERROR: "fleet_server_error",
} as const;

// ---------------------------------------------------------------------------
// Defaults (used to seed the create form)
// ---------------------------------------------------------------------------

/**
 * Default plugin config for a brand-new agent. Bounds mirror the backend's
 * `@/server/fleet-store` defaults: github poll 300s, schedule 6h interval /
 * 10m jitter. Nothing is enabled by default — the operator opts each plugin in.
 * `repos` starts empty; the form fills it from `meta.installation_repos`
 * (all-checked) once the catalog loads.
 */
export function defaultPlugins(): Required<FleetPlugins> {
  return {
    github: {
      enabled: false,
      repos: [],
      watch_new_prs: true,
      watch_review_requests: true,
      watch_mentions: false,
      watch_new_prs_authors: [],
      poll_interval_secs: 300,
    },
    schedule: {
      enabled: false,
      interval_secs: 21600,
      jitter_secs: 600,
      prompt: "",
    },
    tasks: { enabled: false },
    war_rooms: { enabled: false, contribute: false },
  };
}
