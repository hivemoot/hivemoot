/**
 * Fleet agent registry — storage + validation for dynamically managed agents.
 *
 * This is the authoritative, per-tenant source of truth for an installation's
 * agent roster. The dashboard does CRUD here; the on-prem reconciler reads a
 * projection of it via `GET /api/fleet/desired-state`. Modeled on
 * `task-store.ts` (per-installation Redis records + sorted-set index + audit
 * stream + `withRedisLock`) and `agent-token-v1.ts` (typed errors, defensive
 * parsing).
 *
 * MULTITENANCY: every key embeds `installationId` as a path segment (see
 * `REDIS_KEY_CONVENTION.md`). `installationId` is ALWAYS supplied by the route
 * from the authenticated principal — never from request input. A guessed `name`
 * from another tenant resolves to a miss in the caller's namespace.
 *
 * DURABILITY: registry records carry NO TTL. They are durable desired-state
 * config, unlike tasks/health which are transient/observability. A TTL would
 * silently expire an agent and make the reconciler deprovision a live container.
 */

import { type Redis } from "@upstash/redis";
import { withRedisLock } from "@hivemoot/war-room/redis-lock";
import { NAME_REGEX } from "@/server/agent-token-capabilities";
import { isKnownSkill } from "@/server/skills-catalog";
import { isKnownEngine } from "@/server/engine-catalog";

// ---------------------------------------------------------------------------
// Limits / bounds (all tenant-controlled fields are bounded; see security model)
// ---------------------------------------------------------------------------

/** Hard cap on agents per installation — an independent per-installation guard
 * (agents LINK an existing token rather than minting one, and several agents may
 * share one token, so this is decoupled from the token cap). */
export const MAX_AGENTS_PER_INSTALLATION = 20;

const MAX_DISPLAY_NAME_CHARS = 80;
const MAX_SYSTEM_PROMPT_CHARS = 16_000;
const MAX_SKILLS = 24;
const MAX_AUTHOR_ALLOWLIST = 50;
const MAX_SCHEDULE_PROMPT_CHARS = 2_000;

const MIN_INTERVAL_SECS = 300; // 5 min — floor on periodic scans
const MAX_INTERVAL_SECS = 604_800; // 7 days
const MAX_JITTER_SECS = 3_600; // 1 h
const MIN_POLL_SECS = 30;
const MAX_POLL_SECS = 3_600;

/** `owner/name`: each half starts alphanumeric, then `[A-Za-z0-9._-]`; exactly
 * one slash. The explicit `..` reject below blocks path traversal. */
const REPO_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_HALF_MAX = 100;
/** GitHub login (PR-author allowlist entries). */
const GITHUB_LOGIN_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** Skill catalog keys are `^[a-z0-9-]+$` — never a path. */
const SKILL_KEY_REGEX = /^[a-z0-9-]+$/;
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

// ---------------------------------------------------------------------------
// Types — plugins (an agent's enableable capabilities + their config/triggers)
// ---------------------------------------------------------------------------

/**
 * The `github` plugin — the ONLY place `repos` lives in the model. `repos` is
 * resolved against the installation's accessible repos at the route boundary
 * (see `resolveGithubRepos` in fleet-routes), so the stored list is always a
 * subset of repos the installation can actually see. The three watch flags are
 * the plugin's triggers; at least one must be on for the plugin to do anything.
 */
export interface GithubPlugin {
  enabled: boolean;
  repos: string[];
  watch_new_prs: boolean;
  watch_review_requests: boolean;
  watch_mentions: boolean;
  /** Empty/absent = react to all authors; non-empty = only these GitHub logins. */
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
 * The set of plugins an agent can enable. Each is OPTIONAL — an agent only
 * carries the plugins it has configured. At least one must be enabled (an agent
 * with no enabled plugin does nothing); enforced in `validatePlugins`.
 */
export interface FleetPlugins {
  github?: GithubPlugin;
  schedule?: SchedulePlugin;
  tasks?: TasksPlugin;
  war_rooms?: WarRoomsPlugin;
}

export interface FleetAgent {
  /** Identifier: matches NAME_REGEX, unique per installation. Doubles as the
   * container AGENT_ID and the health-join key. */
  name: string;
  display_name?: string;
  engine: string;
  skills: string[];
  system_prompt: string;
  /** The enableable capabilities of this agent. `repos` lives ONLY under
   * `plugins.github.repos` — never at the top level, never on the token. */
  plugins: FleetPlugins;
  /** false = paused (reconciler stops the container; still listed in desired-state). */
  enabled: boolean;
  /** true = the on-prem reconciler owns this agent's lifecycle. */
  managed: boolean;
  /** The existing V1 capability token this agent authenticates as (operator-selected,
   * NOT minted by the agent flow). Validated to EXIST; carries CAPABILITIES only. */
  agent_token_name: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  /** Monotonic per-agent config counter — the reconciler's change-detect key. */
  config_version: number;
}

export interface CreateAgentInput {
  name: string;
  display_name?: string;
  engine: string;
  skills: string[];
  system_prompt: string;
  plugins: FleetPlugins;
  /** The existing capability token to link (capabilities only — no repo scope). */
  agent_token_name: string;
}

/** PATCH input. `name` is immutable. */
export interface UpdateAgentInput {
  display_name?: string | null;
  engine?: string;
  skills?: string[];
  system_prompt?: string;
  plugins?: FleetPlugins;
  agent_token_name?: string;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class AgentNameTakenError extends Error {
  constructor(installationId: string, name: string) {
    super(`Agent '${name}' already exists for installation ${installationId}`);
    this.name = "AgentNameTakenError";
  }
}
export class AgentNotFoundError extends Error {
  constructor(installationId: string, name: string) {
    super(`No agent named '${name}' for installation ${installationId}`);
    this.name = "AgentNotFoundError";
  }
}
export class AgentLimitReachedError extends Error {
  constructor(installationId: string, limit: number) {
    super(
      `Installation ${installationId} is at the ${limit}-agent limit; delete an agent before creating a new one`,
    );
    this.name = "AgentLimitReachedError";
  }
}

// ---------------------------------------------------------------------------
// Validation (pure; returns a result union so routes map cleanly to 400)
// ---------------------------------------------------------------------------

export type FleetValidation<T> =
  | { ok: true; value: T }
  | { ok: false; field: string; message: string };

function fail(field: string, message: string): { ok: false; field: string; message: string } {
  return { ok: false, field, message };
}

function sanitizePrompt(input: string, maxChars: number): string {
  const stripped = input
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARS_PATTERN, "")
    .trim();
  return stripped.length <= maxChars ? stripped : stripped.slice(0, maxChars);
}

export function validateAgentName(value: unknown): FleetValidation<string> {
  if (typeof value !== "string") return fail("name", "name is required (string).");
  if (!NAME_REGEX.test(value)) {
    return fail(
      "name",
      "name must be a lowercase identifier starting with a letter, ≤32 chars (matching /^[a-z][a-z0-9_-]{0,31}$/).",
    );
  }
  return { ok: true, value };
}

export function validateRepo(value: unknown): FleetValidation<string> {
  if (typeof value !== "string") return fail("repo", "repo is required (owner/name).");
  const repo = value.trim();
  if (repo.includes("..") || repo.includes(" ")) {
    return fail("repo", "repo must not contain '..' or whitespace.");
  }
  if (!REPO_REGEX.test(repo)) {
    return fail("repo", "repo must be 'owner/name' (alphanumeric, '.', '_', '-').");
  }
  const [owner, name] = repo.split("/");
  if (owner.length > REPO_HALF_MAX || name.length > REPO_HALF_MAX) {
    return fail("repo", `repo owner and name must each be ≤${REPO_HALF_MAX} chars.`);
  }
  return { ok: true, value: repo };
}

function validateSkills(value: unknown): FleetValidation<string[]> {
  if (!Array.isArray(value)) return fail("skills", "skills must be an array of catalog keys.");
  if (value.length > MAX_SKILLS) return fail("skills", `at most ${MAX_SKILLS} skills allowed.`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of value) {
    if (typeof s !== "string" || !SKILL_KEY_REGEX.test(s)) {
      return fail("skills", `invalid skill key ${JSON.stringify(s)}.`);
    }
    if (!isKnownSkill(s)) return fail("skills", `unknown skill ${JSON.stringify(s)}.`);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return { ok: true, value: out };
}

function clampInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  if (n < min || n > max) return null;
  return n;
}

/** A field that defaults to false but, when PRESENT, must be a real boolean —
 * never silently coerced. Type-validity holds regardless of `enabled` so a
 * malformed-but-disabled block can't be stored and shipped to the reconciler. */
function validateOptionalBoolean(
  value: unknown,
  field: string,
): FleetValidation<boolean> {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== "boolean") return fail(field, `${field} must be a boolean.`);
  return { ok: true, value };
}

/**
 * Validate the `github` plugin. TYPE-validity of every field holds whenever the
 * block is PRESENT (regardless of `enabled`) — repos is string[], the watch
 * flags are booleans, poll_interval_secs is an int — so a malformed-but-disabled
 * block can never be persisted and shipped to the reconciler (which fail-closes
 * on it in Stage 2). The ENABLED-only requirements (≥1 watch flag, non-empty
 * repos) stay gated on `enabled`. Installation-coverage is checked separately by
 * `resolveGithubRepos` at the route boundary (it needs the live roster).
 */
function validateGithubPlugin(raw: unknown): FleetValidation<GithubPlugin> {
  if (typeof raw !== "object" || raw === null) return fail("plugins.github", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;

  const newPrs = validateOptionalBoolean(t.watch_new_prs, "plugins.github.watch_new_prs");
  if (!newPrs.ok) return newPrs;
  const reviewReq = validateOptionalBoolean(t.watch_review_requests, "plugins.github.watch_review_requests");
  if (!reviewReq.ok) return reviewReq;
  const mentions = validateOptionalBoolean(t.watch_mentions, "plugins.github.watch_mentions");
  if (!mentions.ok) return mentions;
  const watch_new_prs = newPrs.value;
  const watch_review_requests = reviewReq.value;
  const watch_mentions = mentions.value;
  if (enabled && !watch_new_prs && !watch_review_requests && !watch_mentions) {
    return fail(
      "plugins.github",
      "enable at least one of watch_new_prs / watch_review_requests / watch_mentions.",
    );
  }

  // poll_interval_secs default 300: matches the conventional PR-poll cadence;
  // a lower value polls GitHub harder (rate-limit pressure), a higher one adds
  // latency before the agent reacts. Omitted ⇒ 300; present ⇒ clamp to [30,3600].
  const poll = clampInt(t.poll_interval_secs ?? 300, MIN_POLL_SECS, MAX_POLL_SECS);
  if (poll === null) {
    return fail("plugins.github.poll_interval_secs", `must be an integer in [${MIN_POLL_SECS}, ${MAX_POLL_SECS}].`);
  }

  // repos: TYPE-valid (string[] of well-formed owner/name) whenever present.
  // NON-empty is NOT required here even when enabled — the route resolver fills
  // an empty enabled list with ALL installed repos (and coverage-checks a
  // non-empty one). Keeping the per-entry format/type checks closes traversal.
  if (t.repos !== undefined && !Array.isArray(t.repos)) {
    return fail("plugins.github.repos", "repos must be an array of owner/name strings.");
  }
  const rawRepos = Array.isArray(t.repos) ? t.repos : [];
  const repos: string[] = [];
  const seenRepos = new Set<string>();
  for (const r of rawRepos) {
    const v = validateRepo(r);
    if (!v.ok) return fail("plugins.github.repos", v.message);
    if (!seenRepos.has(v.value)) {
      seenRepos.add(v.value);
      repos.push(v.value);
    }
  }

  if (t.watch_new_prs_authors !== undefined && !Array.isArray(t.watch_new_prs_authors)) {
    return fail("plugins.github.watch_new_prs_authors", "must be an array of GitHub logins.");
  }
  const rawAllow = Array.isArray(t.watch_new_prs_authors) ? t.watch_new_prs_authors : [];
  if (rawAllow.length > MAX_AUTHOR_ALLOWLIST) {
    return fail("plugins.github.watch_new_prs_authors", `at most ${MAX_AUTHOR_ALLOWLIST} authors.`);
  }
  const authors: string[] = [];
  const seenAuthors = new Set<string>();
  for (const a of rawAllow) {
    if (typeof a !== "string" || !GITHUB_LOGIN_REGEX.test(a)) {
      return fail("plugins.github.watch_new_prs_authors", `invalid GitHub login ${JSON.stringify(a)}.`);
    }
    if (!seenAuthors.has(a)) {
      seenAuthors.add(a);
      authors.push(a);
    }
  }

  const value: GithubPlugin = {
    enabled,
    repos,
    watch_new_prs,
    watch_review_requests,
    watch_mentions,
    poll_interval_secs: poll,
    // Only persist the authors key when non-empty (empty = all authors).
    ...(authors.length > 0 ? { watch_new_prs_authors: authors } : {}),
  };
  return { ok: true, value };
}

/**
 * Validate the `schedule` plugin. interval/jitter type-validity (integers in
 * range, jitter ≤ interval) holds whenever the block is PRESENT; the non-empty
 * `prompt` requirement is gated on `enabled`. `prompt` must be a string when
 * present (a non-string is rejected, not coerced) and is trimmed/sanitized.
 */
function validateSchedulePlugin(raw: unknown): FleetValidation<SchedulePlugin> {
  if (typeof raw !== "object" || raw === null) return fail("plugins.schedule", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;
  const interval = clampInt(t.interval_secs ?? 21600, MIN_INTERVAL_SECS, MAX_INTERVAL_SECS);
  if (interval === null) {
    return fail("plugins.schedule.interval_secs", `must be an integer in [${MIN_INTERVAL_SECS}, ${MAX_INTERVAL_SECS}].`);
  }
  const jitter = clampInt(t.jitter_secs ?? 600, 0, MAX_JITTER_SECS);
  if (jitter === null) return fail("plugins.schedule.jitter_secs", `must be an integer in [0, ${MAX_JITTER_SECS}].`);
  if (jitter > interval) return fail("plugins.schedule.jitter_secs", "jitter must be ≤ interval.");
  // prompt: reject a non-string when present (no silent coercion to "").
  if (t.prompt !== undefined && typeof t.prompt !== "string") {
    return fail("plugins.schedule.prompt", "prompt must be a string.");
  }
  const prompt = typeof t.prompt === "string" ? sanitizePrompt(t.prompt, MAX_SCHEDULE_PROMPT_CHARS) : "";
  // sanitizePrompt already trims; an enabled schedule needs a non-empty prompt
  // (an empty/whitespace-only prompt gives the agent nothing to do on each tick).
  if (enabled && prompt.trim().length === 0) {
    return fail("plugins.schedule.prompt", "a schedule prompt is required when the schedule plugin is enabled.");
  }
  return { ok: true, value: { enabled, interval_secs: interval, jitter_secs: jitter, prompt } };
}

function validateTasksPlugin(raw: unknown): FleetValidation<TasksPlugin> {
  if (typeof raw !== "object" || raw === null) return fail("plugins.tasks", "must be an object.");
  const enabled = (raw as Record<string, unknown>).enabled === true;
  return { ok: true, value: { enabled } };
}

/**
 * Validate the `war_rooms` plugin. `contribute` must be a real boolean whenever
 * the block is PRESENT (regardless of `enabled`) — never silently undefined. The
 * capability gate distinguishes observe-only (watch+read) from contributing
 * (also posting), so a non-boolean here is a hard VALIDATION error.
 */
function validateWarRoomsPlugin(raw: unknown): FleetValidation<WarRoomsPlugin> {
  if (typeof raw !== "object" || raw === null) return fail("plugins.war_rooms", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;
  if (typeof t.contribute !== "boolean") {
    return fail("plugins.war_rooms.contribute", "contribute must be a boolean.");
  }
  return { ok: true, value: { enabled, contribute: t.contribute } };
}

/**
 * Validate the full `plugins` object. Each present plugin is validated; at least
 * ONE must be enabled (an agent that enables nothing does nothing). Returns a
 * normalized FleetPlugins carrying only the keys that were supplied — a plugin
 * the caller omits stays omitted (it is simply not configured for this agent).
 */
export function validatePlugins(raw: unknown): FleetValidation<FleetPlugins> {
  if (typeof raw !== "object" || raw === null) return fail("plugins", "plugins must be an object.");
  const t = raw as Record<string, unknown>;

  // Reject the privileged war-room "queen" surface from the dashboard: any
  // truthy queen/creation flag means the caller wants room creation/synthesis,
  // which needs mint/merge caps the dashboard can't issue. Admin token path only.
  if ((t as { queen?: { enabled?: unknown } }).queen != null && (t as { queen?: { enabled?: unknown } }).queen?.enabled === true) {
    return fail("plugins.queen", "War-room creation/synthesis (queen) is not available from the dashboard — issue a queen token via the admin path.");
  }

  const out: FleetPlugins = {};
  if (t.github !== undefined) {
    const r = validateGithubPlugin(t.github);
    if (!r.ok) return r;
    out.github = r.value;
  }
  if (t.schedule !== undefined) {
    const r = validateSchedulePlugin(t.schedule);
    if (!r.ok) return r;
    out.schedule = r.value;
  }
  if (t.tasks !== undefined) {
    const r = validateTasksPlugin(t.tasks);
    if (!r.ok) return r;
    out.tasks = r.value;
  }
  if (t.war_rooms !== undefined) {
    const r = validateWarRoomsPlugin(t.war_rooms);
    if (!r.ok) return r;
    out.war_rooms = r.value;
  }

  const anyEnabled =
    out.github?.enabled === true ||
    out.schedule?.enabled === true ||
    out.tasks?.enabled === true ||
    out.war_rooms?.enabled === true;
  if (!anyEnabled) {
    return fail("plugins", "enable at least one plugin (an agent with no enabled plugin does nothing).");
  }

  return { ok: true, value: out };
}

function validateLinkedTokenName(value: unknown): FleetValidation<string> {
  if (typeof value !== "string" || !NAME_REGEX.test(value)) {
    return fail(
      "agent_token_name",
      "agent_token_name must reference an existing capability token (lowercase identifier).",
    );
  }
  return { ok: true, value };
}

function validateEngine(value: unknown): FleetValidation<string> {
  if (typeof value !== "string" || !isKnownEngine(value)) {
    return fail("engine", "engine must be a known engine id.");
  }
  return { ok: true, value };
}

function validateDisplayName(value: unknown): FleetValidation<string | undefined> {
  if (value == null) return { ok: true, value: undefined };
  if (typeof value !== "string") return fail("display_name", "display_name must be a string.");
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (trimmed.length > MAX_DISPLAY_NAME_CHARS) {
    return fail("display_name", `display_name must be ≤${MAX_DISPLAY_NAME_CHARS} chars.`);
  }
  return { ok: true, value: trimmed };
}

function validateSystemPrompt(value: unknown): FleetValidation<string> {
  if (value == null) return { ok: true, value: "" };
  if (typeof value !== "string") return fail("system_prompt", "system_prompt must be a string.");
  if (value.length > MAX_SYSTEM_PROMPT_CHARS * 2) {
    // Pre-sanitize length guard so we don't sanitize a megabyte of input.
    return fail("system_prompt", `system_prompt must be ≤${MAX_SYSTEM_PROMPT_CHARS} chars.`);
  }
  return { ok: true, value: sanitizePrompt(value, MAX_SYSTEM_PROMPT_CHARS) };
}

/** Validate a full create body. `installationId` is supplied separately by the
 * route from the authenticated session — NEVER from the body. */
export function validateCreateAgentInput(raw: Record<string, unknown>): FleetValidation<CreateAgentInput> {
  const name = validateAgentName(raw.name);
  if (!name.ok) return name;
  const engine = validateEngine(raw.engine);
  if (!engine.ok) return engine;
  const skills = validateSkills(raw.skills ?? []);
  if (!skills.ok) return skills;
  const system_prompt = validateSystemPrompt(raw.system_prompt);
  if (!system_prompt.ok) return system_prompt;
  const plugins = validatePlugins(raw.plugins ?? {});
  if (!plugins.ok) return plugins;
  const display_name = validateDisplayName(raw.display_name);
  if (!display_name.ok) return display_name;
  const token = validateLinkedTokenName(raw.agent_token_name);
  if (!token.ok) return token;

  return {
    ok: true,
    value: {
      name: name.value,
      engine: engine.value,
      skills: skills.value,
      system_prompt: system_prompt.value,
      plugins: plugins.value,
      agent_token_name: token.value,
      ...(display_name.value !== undefined ? { display_name: display_name.value } : {}),
    },
  };
}

/**
 * Validate a PATCH body — only present fields are validated/returned.
 *
 * REPLACE-not-merge: a provided `plugins` object REPLACES the agent's entire
 * plugins set (it is NOT deep-merged into the existing one). The dashboard form
 * always submits the complete plugin set, so a PATCH that omits a plugin means
 * "this agent no longer has that plugin", not "leave it as-is". A PATCH that
 * omits `plugins` entirely leaves the stored plugins untouched.
 */
export function validateUpdateAgentInput(raw: Record<string, unknown>): FleetValidation<UpdateAgentInput> {
  const patch: UpdateAgentInput = {};
  if ("name" in raw || "repo" in raw || "repos" in raw || "triggers" in raw || "duty" in raw) {
    return fail(
      "name",
      "name is immutable; top-level repos/triggers/duty no longer exist (configure repos under plugins.github).",
    );
  }
  if ("display_name" in raw) {
    const r = validateDisplayName(raw.display_name);
    if (!r.ok) return r;
    patch.display_name = r.value ?? null;
  }
  if ("engine" in raw) {
    const r = validateEngine(raw.engine);
    if (!r.ok) return r;
    patch.engine = r.value;
  }
  if ("agent_token_name" in raw) {
    const r = validateLinkedTokenName(raw.agent_token_name);
    if (!r.ok) return r;
    patch.agent_token_name = r.value;
  }
  if ("skills" in raw) {
    const r = validateSkills(raw.skills);
    if (!r.ok) return r;
    patch.skills = r.value;
  }
  if ("system_prompt" in raw) {
    const r = validateSystemPrompt(raw.system_prompt);
    if (!r.ok) return r;
    patch.system_prompt = r.value;
  }
  if ("plugins" in raw) {
    const r = validatePlugins(raw.plugins);
    if (!r.ok) return r;
    patch.plugins = r.value;
  }
  return { ok: true, value: patch };
}

// ---------------------------------------------------------------------------
// Redis keys
// ---------------------------------------------------------------------------

const AGENT_PREFIX = "hive:v1:fleet:agent:";
const INDEX_PREFIX = "hive:v1:fleet:idx:installation:";
const ROSTER_VERSION_PREFIX = "hive:v1:fleet:roster-version:";
const AUDIT_PREFIX = "hive:v1:fleet:audit:";
const LOCK_PREFIX = "hive:v1:fleet:lock:";
const CREATE_LOCK_PREFIX = "hive:v1:fleet:lock:create:";
const SEED_MARKER_PREFIX = "hive:v1:fleet:seed-marker:";
const AUDIT_MAXLEN = 10_000;

function agentKey(installationId: string, name: string): string {
  return `${AGENT_PREFIX}${installationId}:${name}`;
}
function indexKey(installationId: string): string {
  return `${INDEX_PREFIX}${installationId}`;
}
function rosterVersionKey(installationId: string): string {
  return `${ROSTER_VERSION_PREFIX}${installationId}`;
}
function auditKey(installationId: string): string {
  return `${AUDIT_PREFIX}${installationId}`;
}
function agentLockKey(installationId: string, name: string): string {
  return `${LOCK_PREFIX}${installationId}:${name}`;
}
function createLockKey(installationId: string): string {
  return `${CREATE_LOCK_PREFIX}${installationId}`;
}
export function seedMarkerKey(installationId: string): string {
  return `${SEED_MARKER_PREFIX}${installationId}`;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type FleetAuditAction = "create" | "update" | "delete" | "enable" | "disable" | "seed";

async function appendAudit(args: {
  installationId: string;
  redis: Redis;
  action: FleetAuditAction;
  name: string;
  actor: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    action: args.action,
    name: args.name,
    actor: args.actor,
    ...(args.detail ? { detail: args.detail } : {}),
  });
  // Best-effort: an audit-write failure must not fail the mutation it records.
  // Use the same Lua XADD primitive the token-audit stream uses (the @upstash
  // TS xadd signature varies by version; the Lua call is stable).
  try {
    await args.redis.eval(
      'redis.call("xadd", KEYS[1], "MAXLEN", "~", ARGV[1], "*", "entry", ARGV[2]) return 1',
      [auditKey(args.installationId)],
      [String(AUDIT_MAXLEN), entry],
    );
  } catch (err) {
    console.warn(`[fleet-store] audit xadd failed for ${args.installationId}:${args.name}`, err);
  }
}

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

/** A plugin entry must at minimum be an object with a boolean `enabled`. We
 * keep this lenient (the route-side validators are authoritative on write); the
 * parser only rejects records that are structurally unusable. */
function isPluginShape(v: unknown): v is { enabled: boolean } {
  return typeof v === "object" && v !== null && typeof (v as { enabled?: unknown }).enabled === "boolean";
}

/** Parse a stored record into a FleetAgent, returning null on any shape
 * violation (no-throw, like the task store) so a single corrupt record can't
 * break a list read. The registry stores ONLY the plugin shape (no migration /
 * back-compat — there are no legacy records): a record carrying the old
 * top-level `triggers`/`repos` and no `plugins` is rejected as malformed. */
function parseStoredAgent(raw: unknown): FleetAgent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.engine !== "string") return null;
  if (typeof r.system_prompt !== "string" || !Array.isArray(r.skills)) return null;
  if (typeof r.agent_token_name !== "string") return null;

  const plugins = r.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return null;
  const p = plugins as Record<string, unknown>;
  // Each PRESENT plugin must be a well-shaped object; absent plugins are fine.
  for (const key of ["github", "schedule", "tasks", "war_rooms"] as const) {
    if (p[key] !== undefined && !isPluginShape(p[key])) return null;
  }
  // The github plugin must carry a repos array if present (the only repo source).
  if (p.github !== undefined) {
    const githubRepos = (p.github as Record<string, unknown>).repos;
    if (!Array.isArray(githubRepos)) return null;
    // Fail-closed on the security-sensitive field: every stored repo MUST still
    // be a string in `owner/name` format. A row whose repos were tampered with
    // (or written by an older/buggy path) is rejected rather than handed to the
    // reconciler — repos flow straight into the rendered container's scope.
    for (const repo of githubRepos) {
      if (!validateRepo(repo).ok) return null;
    }
  }
  // At least one plugin enabled — a stored agent with nothing enabled is corrupt.
  const anyEnabled = (["github", "schedule", "tasks", "war_rooms"] as const).some(
    (k) => isPluginShape(p[k]) && (p[k] as { enabled: boolean }).enabled === true,
  );
  if (!anyEnabled) return null;

  return raw as FleetAgent;
}

// ---------------------------------------------------------------------------
// Roster version (desired-state ETag source)
// ---------------------------------------------------------------------------

async function bumpRosterVersion(installationId: string, redis: Redis): Promise<number> {
  return await redis.incr(rosterVersionKey(installationId));
}

export async function getRosterVersion(installationId: string, redis: Redis): Promise<number> {
  const v = await redis.get<number>(rosterVersionKey(installationId));
  return typeof v === "number" ? v : 0;
}

export async function countAgents(installationId: string, redis: Redis): Promise<number> {
  return await redis.zcard(indexKey(installationId));
}

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

/**
 * Persist a new agent record. Serialized per-installation via a create lock so
 * the `MAX_AGENTS_PER_INSTALLATION` cap check is race-free (TOCTOU-safe). The
 * agent LINKS an existing token (`agentTokenName`) — this flow never mints,
 * mutates, or revokes it. The token carries CAPABILITIES only; repos live under
 * `input.plugins.github.repos`, already resolved against the installation by the
 * route before this is called.
 */
export async function createAgent(args: {
  installationId: string;
  input: CreateAgentInput;
  createdBy: string;
  agentTokenName: string;
  managed?: boolean;
  redis: Redis;
}): Promise<FleetAgent> {
  const { installationId, input, redis } = args;
  return await withRedisLock(createLockKey(installationId), redis, async () => {
    const count = await redis.zcard(indexKey(installationId));
    if (count >= MAX_AGENTS_PER_INSTALLATION) {
      throw new AgentLimitReachedError(installationId, MAX_AGENTS_PER_INSTALLATION);
    }
    const exists = await redis.get(agentKey(installationId, input.name));
    if (exists) throw new AgentNameTakenError(installationId, input.name);

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const record: FleetAgent = {
      name: input.name,
      ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
      engine: input.engine,
      skills: input.skills,
      system_prompt: input.system_prompt,
      plugins: input.plugins,
      enabled: true,
      managed: args.managed ?? true,
      agent_token_name: args.agentTokenName,
      created_at: nowIso,
      created_by: args.createdBy,
      updated_at: nowIso,
      // Start at 2: the plugin-shape config model is the second generation of
      // the desired-state contract (the first was top-level repos/triggers).
      // The registry is empty so this is purely a forward signal to reconcilers.
      config_version: 2,
    };
    await redis.set(agentKey(installationId, input.name), JSON.stringify(record));
    await redis.zadd(indexKey(installationId), { score: nowMs, member: input.name });
    await bumpRosterVersion(installationId, redis);
    await appendAudit({
      installationId,
      redis,
      action: "create",
      name: input.name,
      actor: args.createdBy,
      detail: {
        engine: input.engine,
        token: args.agentTokenName,
        github_repos: input.plugins.github?.enabled ? input.plugins.github.repos : [],
      },
    });
    return record;
  });
}

export async function getAgent(args: {
  installationId: string;
  name: string;
  redis: Redis;
}): Promise<FleetAgent | null> {
  const raw = await args.redis.get(agentKey(args.installationId, args.name));
  if (!raw) return null;
  return parseStoredAgent(raw);
}

export async function listAgents(args: {
  installationId: string;
  redis: Redis;
}): Promise<FleetAgent[]> {
  const names = await args.redis.zrange<string[]>(indexKey(args.installationId), 0, -1);
  if (!names || names.length === 0) return [];
  const records = await Promise.all(
    names.map((name) => args.redis.get(agentKey(args.installationId, name))),
  );
  const out: FleetAgent[] = [];
  const orphans: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const parsed = records[i] ? parseStoredAgent(records[i]) : null;
    if (parsed) out.push(parsed);
    else orphans.push(names[i]);
  }
  if (orphans.length > 0) {
    await Promise.all(
      orphans.map((name) =>
        args.redis
          .zrem(indexKey(args.installationId), name)
          .catch((err: unknown) => console.warn(`[fleet-store] ZREM orphan ${args.installationId}:${name}`, err)),
      ),
    );
  }
  return out;
}

/**
 * Apply a validated PATCH to an existing agent. Each present patch field
 * overwrites the stored value; absent fields are left as-is. NOTE: `patch.plugins`
 * REPLACES the whole plugins set (replace-not-merge) — the caller (route → form)
 * submits the complete plugin set, and repos in `patch.plugins.github` have
 * already been coverage-resolved by the route before this is called.
 */
export async function updateAgent(args: {
  installationId: string;
  name: string;
  patch: UpdateAgentInput;
  actor: string;
  redis: Redis;
}): Promise<FleetAgent> {
  const { installationId, name, patch, redis } = args;
  return await withRedisLock(agentLockKey(installationId, name), redis, async () => {
    const existing = parseStoredAgent(await redis.get(agentKey(installationId, name)));
    if (!existing) throw new AgentNotFoundError(installationId, name);
    const updated: FleetAgent = {
      ...existing,
      ...(patch.engine !== undefined ? { engine: patch.engine } : {}),
      ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
      ...(patch.system_prompt !== undefined ? { system_prompt: patch.system_prompt } : {}),
      ...(patch.plugins !== undefined ? { plugins: patch.plugins } : {}),
      ...(patch.agent_token_name !== undefined ? { agent_token_name: patch.agent_token_name } : {}),
      updated_at: new Date().toISOString(),
      config_version: existing.config_version + 1,
    };
    // display_name: explicit null clears it.
    if (patch.display_name !== undefined) {
      if (patch.display_name === null) delete (updated as { display_name?: string }).display_name;
      else updated.display_name = patch.display_name;
    }
    await redis.set(agentKey(installationId, name), JSON.stringify(updated));
    await bumpRosterVersion(installationId, redis);
    await appendAudit({ installationId, redis, action: "update", name, actor: args.actor });
    return updated;
  });
}

export async function setAgentEnabled(args: {
  installationId: string;
  name: string;
  enabled: boolean;
  actor: string;
  redis: Redis;
}): Promise<FleetAgent> {
  const { installationId, name, enabled, redis } = args;
  return await withRedisLock(agentLockKey(installationId, name), redis, async () => {
    const existing = parseStoredAgent(await redis.get(agentKey(installationId, name)));
    if (!existing) throw new AgentNotFoundError(installationId, name);
    const updated: FleetAgent = {
      ...existing,
      enabled,
      updated_at: new Date().toISOString(),
      config_version: existing.config_version + 1,
    };
    await redis.set(agentKey(installationId, name), JSON.stringify(updated));
    await bumpRosterVersion(installationId, redis);
    await appendAudit({ installationId, redis, action: enabled ? "enable" : "disable", name, actor: args.actor });
    return updated;
  });
}

/**
 * Delete the agent RECORD only. The linked capability token is intentionally
 * NOT revoked — it is shared and managed independently on the Credentials
 * screen, and may back other agents. Returns true if a record existed.
 */
export async function deleteAgent(args: {
  installationId: string;
  name: string;
  actor: string;
  redis: Redis;
}): Promise<boolean> {
  const { installationId, name, redis } = args;
  return await withRedisLock(agentLockKey(installationId, name), redis, async () => {
    const existed = await redis.del(agentKey(installationId, name));
    await redis.zrem(indexKey(installationId), name);
    await bumpRosterVersion(installationId, redis);
    if (existed > 0) {
      await appendAudit({ installationId, redis, action: "delete", name, actor: args.actor });
    }
    return existed > 0;
  });
}
