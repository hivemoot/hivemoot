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

/** Hard cap on agents per installation. Kept ≤ the 20-token cap in
 * `agent-token-v1.ts` because every agent auto-issues one token — the token cap
 * is the binding backstop, this is the clearer-errored primary guard. */
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
// Types
// ---------------------------------------------------------------------------

export type AgentDuty = "standing" | "dispatch";

export interface ScheduleTriggerSettings {
  interval_secs: number;
  jitter_secs: number;
  prompt: string;
}
export interface PullRequestsTriggerSettings {
  watch_new_prs: boolean;
  watch_review_requests: boolean;
  /** Empty = react to all authors; non-empty = only these GitHub logins. */
  author_allowlist: string[];
  poll_interval_secs: number;
}
export interface MentionsTriggerSettings {
  poll_interval_secs: number;
}
// Tasks/war-room participation have no extra settings beyond enabled / contribute.
export type TasksTriggerSettings = Record<string, never>;
export interface WarRoomsTriggerSettings {
  /** false = observe only (watch+read); true = also present + contribute. */
  contribute: boolean;
}

export interface TriggerState<S> {
  enabled: boolean;
  settings: S;
}

export interface AgentTriggers {
  schedule: TriggerState<ScheduleTriggerSettings>;
  pull_requests: TriggerState<PullRequestsTriggerSettings>;
  mentions: TriggerState<MentionsTriggerSettings>;
  tasks: TriggerState<TasksTriggerSettings>;
  war_rooms: TriggerState<WarRoomsTriggerSettings>;
}

export interface FleetAgent {
  /** Identifier: matches NAME_REGEX, unique per installation. Doubles as the
   * agent_token_name, the container AGENT_ID, and the health-join key. */
  name: string;
  display_name?: string;
  /** owner/name — the repo the agent operates on. Immutable after create. */
  repo: string;
  engine: string;
  duty: AgentDuty;
  skills: string[];
  system_prompt: string;
  triggers: AgentTriggers;
  /** false = paused (reconciler stops the container; still listed in desired-state). */
  enabled: boolean;
  /** true = the on-prem reconciler owns this agent's lifecycle. */
  managed: boolean;
  /** The auto-issued V1 token name (== `name`). */
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
  repo: string;
  engine: string;
  duty: AgentDuty;
  skills: string[];
  system_prompt: string;
  triggers: AgentTriggers;
}

/** PATCH input. `name` and `repo` are immutable (repo change would require a
 * token-policy rewrite + GitHub re-coverage; delete+recreate instead). */
export interface UpdateAgentInput {
  display_name?: string | null;
  engine?: string;
  duty?: AgentDuty;
  skills?: string[];
  system_prompt?: string;
  triggers?: AgentTriggers;
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

function validateScheduleTrigger(raw: unknown): FleetValidation<TriggerState<ScheduleTriggerSettings>> {
  if (typeof raw !== "object" || raw === null) return fail("triggers.schedule", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;
  const s = (t.settings ?? {}) as Record<string, unknown>;
  const interval = clampInt(s.interval_secs ?? 21600, MIN_INTERVAL_SECS, MAX_INTERVAL_SECS);
  if (interval === null) {
    return fail("triggers.schedule.interval_secs", `must be an integer in [${MIN_INTERVAL_SECS}, ${MAX_INTERVAL_SECS}].`);
  }
  const jitter = clampInt(s.jitter_secs ?? 600, 0, MAX_JITTER_SECS);
  if (jitter === null) return fail("triggers.schedule.jitter_secs", `must be an integer in [0, ${MAX_JITTER_SECS}].`);
  if (jitter > interval) return fail("triggers.schedule.jitter_secs", "jitter must be ≤ interval.");
  const prompt = typeof s.prompt === "string" ? sanitizePrompt(s.prompt, MAX_SCHEDULE_PROMPT_CHARS) : "";
  if (enabled && prompt.length === 0) {
    return fail("triggers.schedule.prompt", "a schedule prompt is required when the schedule trigger is enabled.");
  }
  return { ok: true, value: { enabled, settings: { interval_secs: interval, jitter_secs: jitter, prompt } } };
}

function validatePullRequestsTrigger(raw: unknown): FleetValidation<TriggerState<PullRequestsTriggerSettings>> {
  if (typeof raw !== "object" || raw === null) return fail("triggers.pull_requests", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;
  const s = (t.settings ?? {}) as Record<string, unknown>;
  const watch_new_prs = s.watch_new_prs !== false; // default true
  const watch_review_requests = s.watch_review_requests !== false; // default true
  if (enabled && !watch_new_prs && !watch_review_requests) {
    return fail("triggers.pull_requests", "enable at least one of watch_new_prs / watch_review_requests.");
  }
  const poll = clampInt(s.poll_interval_secs ?? 300, MIN_POLL_SECS, MAX_POLL_SECS);
  if (poll === null) return fail("triggers.pull_requests.poll_interval_secs", `must be in [${MIN_POLL_SECS}, ${MAX_POLL_SECS}].`);
  const rawAllow = Array.isArray(s.author_allowlist) ? s.author_allowlist : [];
  if (rawAllow.length > MAX_AUTHOR_ALLOWLIST) {
    return fail("triggers.pull_requests.author_allowlist", `at most ${MAX_AUTHOR_ALLOWLIST} authors.`);
  }
  const author_allowlist: string[] = [];
  const seen = new Set<string>();
  for (const a of rawAllow) {
    if (typeof a !== "string" || !GITHUB_LOGIN_REGEX.test(a)) {
      return fail("triggers.pull_requests.author_allowlist", `invalid GitHub login ${JSON.stringify(a)}.`);
    }
    if (!seen.has(a)) {
      seen.add(a);
      author_allowlist.push(a);
    }
  }
  return {
    ok: true,
    value: { enabled, settings: { watch_new_prs, watch_review_requests, author_allowlist, poll_interval_secs: poll } },
  };
}

function validateMentionsTrigger(raw: unknown): FleetValidation<TriggerState<MentionsTriggerSettings>> {
  if (typeof raw !== "object" || raw === null) return fail("triggers.mentions", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;
  const s = (t.settings ?? {}) as Record<string, unknown>;
  const poll = clampInt(s.poll_interval_secs ?? 90, MIN_POLL_SECS, MAX_POLL_SECS);
  if (poll === null) return fail("triggers.mentions.poll_interval_secs", `must be in [${MIN_POLL_SECS}, ${MAX_POLL_SECS}].`);
  return { ok: true, value: { enabled, settings: { poll_interval_secs: poll } } };
}

function validateTasksTrigger(raw: unknown): FleetValidation<TriggerState<TasksTriggerSettings>> {
  if (typeof raw !== "object" || raw === null) return fail("triggers.tasks", "must be an object.");
  const enabled = (raw as Record<string, unknown>).enabled === true;
  return { ok: true, value: { enabled, settings: {} } };
}

function validateWarRoomsTrigger(raw: unknown): FleetValidation<TriggerState<WarRoomsTriggerSettings>> {
  if (typeof raw !== "object" || raw === null) return fail("triggers.war_rooms", "must be an object.");
  const t = raw as Record<string, unknown>;
  const enabled = t.enabled === true;
  const s = (t.settings ?? {}) as Record<string, unknown>;
  const contribute = s.contribute === true;
  return { ok: true, value: { enabled, settings: { contribute } } };
}

export function validateTriggers(raw: unknown): FleetValidation<AgentTriggers> {
  if (typeof raw !== "object" || raw === null) return fail("triggers", "triggers must be an object.");
  const t = raw as Record<string, unknown>;
  const schedule = validateScheduleTrigger(t.schedule ?? {});
  if (!schedule.ok) return schedule;
  const pull_requests = validatePullRequestsTrigger(t.pull_requests ?? {});
  if (!pull_requests.ok) return pull_requests;
  const mentions = validateMentionsTrigger(t.mentions ?? {});
  if (!mentions.ok) return mentions;
  const tasks = validateTasksTrigger(t.tasks ?? {});
  if (!tasks.ok) return tasks;
  const war_rooms = validateWarRoomsTrigger(t.war_rooms ?? {});
  if (!war_rooms.ok) return war_rooms;

  // Reject the privileged war-room "queen" surface from the dashboard: any
  // truthy queen/creation flag means the caller wants room creation/synthesis,
  // which needs mint/merge caps + an explicit repo policy the dashboard can't
  // supply. Route those through the admin token path instead.
  if ((t as Record<string, unknown>).queen != null && (t as { queen?: { enabled?: unknown } }).queen?.enabled === true) {
    return fail("triggers.queen", "War-room creation/synthesis (queen) is not available from the dashboard — issue a queen token via the admin path.");
  }

  return {
    ok: true,
    value: {
      schedule: schedule.value,
      pull_requests: pull_requests.value,
      mentions: mentions.value,
      tasks: tasks.value,
      war_rooms: war_rooms.value,
    },
  };
}

function validateDuty(value: unknown): FleetValidation<AgentDuty> {
  if (value === "standing" || value === "dispatch") return { ok: true, value };
  return fail("duty", "duty must be 'standing' or 'dispatch'.");
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
  const repo = validateRepo(raw.repo);
  if (!repo.ok) return repo;
  const engine = validateEngine(raw.engine);
  if (!engine.ok) return engine;
  const duty = validateDuty(raw.duty ?? "standing");
  if (!duty.ok) return duty;
  const skills = validateSkills(raw.skills ?? []);
  if (!skills.ok) return skills;
  const system_prompt = validateSystemPrompt(raw.system_prompt);
  if (!system_prompt.ok) return system_prompt;
  const triggers = validateTriggers(raw.triggers ?? {});
  if (!triggers.ok) return triggers;
  const display_name = validateDisplayName(raw.display_name);
  if (!display_name.ok) return display_name;

  return {
    ok: true,
    value: {
      name: name.value,
      repo: repo.value,
      engine: engine.value,
      duty: duty.value,
      skills: skills.value,
      system_prompt: system_prompt.value,
      triggers: triggers.value,
      ...(display_name.value !== undefined ? { display_name: display_name.value } : {}),
    },
  };
}

/** Validate a PATCH body — only present fields are validated/returned. */
export function validateUpdateAgentInput(raw: Record<string, unknown>): FleetValidation<UpdateAgentInput> {
  const patch: UpdateAgentInput = {};
  if ("name" in raw || "repo" in raw) {
    return fail("name", "name and repo are immutable; delete and recreate to change them.");
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
  if ("duty" in raw) {
    const r = validateDuty(raw.duty);
    if (!r.ok) return r;
    patch.duty = r.value;
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
  if ("triggers" in raw) {
    const r = validateTriggers(raw.triggers);
    if (!r.ok) return r;
    patch.triggers = r.value;
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

function isTriggerStateShape(v: unknown): v is { enabled: boolean; settings: Record<string, unknown> } {
  return typeof v === "object" && v !== null && typeof (v as { enabled?: unknown }).enabled === "boolean";
}

/** Parse a stored record into a FleetAgent, returning null on any shape
 * violation (no-throw, like the task store) so a single corrupt record can't
 * break a list read. */
function parseStoredAgent(raw: unknown): FleetAgent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.repo !== "string" || typeof r.engine !== "string") return null;
  if (typeof r.system_prompt !== "string" || !Array.isArray(r.skills)) return null;
  const tr = r.triggers as Record<string, unknown> | undefined;
  if (
    !tr ||
    !isTriggerStateShape(tr.schedule) ||
    !isTriggerStateShape(tr.pull_requests) ||
    !isTriggerStateShape(tr.mentions) ||
    !isTriggerStateShape(tr.tasks) ||
    !isTriggerStateShape(tr.war_rooms)
  ) {
    return null;
  }
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
 * caller (route) has already issued the V1 token named `agent_token_name`;
 * if this throws, the route revokes that token so no orphan remains.
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
      repo: input.repo,
      engine: input.engine,
      duty: input.duty,
      skills: input.skills,
      system_prompt: input.system_prompt,
      triggers: input.triggers,
      enabled: true,
      managed: args.managed ?? true,
      agent_token_name: args.agentTokenName,
      created_at: nowIso,
      created_by: args.createdBy,
      updated_at: nowIso,
      config_version: 1,
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
      detail: { repo: input.repo, engine: input.engine },
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
      ...(patch.duty !== undefined ? { duty: patch.duty } : {}),
      ...(patch.skills !== undefined ? { skills: patch.skills } : {}),
      ...(patch.system_prompt !== undefined ? { system_prompt: patch.system_prompt } : {}),
      ...(patch.triggers !== undefined ? { triggers: patch.triggers } : {}),
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
 * Delete the agent RECORD only. Token revocation is the route's responsibility
 * and MUST happen first (fail-closed): the route revokes the token, then calls
 * this. Returns true if a record existed.
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
