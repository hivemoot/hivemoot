/**
 * Audit-stream emit helper for the V1 agent-token system (Phase B.1.d-i).
 *
 * Per CAPABILITIES_DESIGN.md §Audit log, audit emit is split into
 * two streams per installation:
 *
 *   - `:audit` (mutations) — issue / revoke / set_capabilities /
 *     rotate / bootstrap. Bounded by `MAXLEN ~10000`. At <10
 *     mutations/day this is effectively unbounded (V1 retention).
 *   - `:auth`  (auth events) — auth.success / auth.failure. Bounded
 *     by `MAXLEN ~100000`. Hours-to-days at single-Hive load. The
 *     split prevents high-volume auth events from displacing
 *     low-volume mutation events that operators actually care about
 *     for forensics.
 *
 * **Security: never log raw bearers.** Audit entries carry the
 * SHA-256 fingerprint (first 8 hex chars of `tokenHash`) for
 * correlation, never the raw bearer or the full hash. The
 * `AuditEntry` type below enforces this — there is no `token`
 * field; the closest approximation is `fingerprint` which is
 * already plaintext metadata in storage.
 *
 * Wiring contract:
 *
 *   - For ISSUE / REVOKE / SET_CAPABILITIES / ROTATE: callers
 *     build an `AuditEntry` and pass it as JSON via the script's
 *     `auditEntryJsonOrEmpty` ARGV slot. The script does the XADD
 *     atomically with the storage write (closes the lost-audit
 *     window guard R1 G1 was protecting against).
 *
 *   - For BOOTSTRAP / WHOAMI / auth.success / auth.failure: caller
 *     uses `auditAppend(...)` directly (no Lua script wraps the
 *     event-source for these — they live in route handlers and
 *     the middleware).
 */

import { type Redis } from "@upstash/redis";
import {
  ENVELOPE_PREFIX,
} from "@/server/agent-token-v1";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUDIT_SUFFIX = ":audit";
const AUTH_SUFFIX = ":auth";

/**
 * Per CAPABILITIES_DESIGN.md §Audit log retention math:
 *
 *   - Mutations stream: 10,000 entries. At <10 mutations/day this
 *     is effectively unbounded; the trim is a safety net.
 *   - Auth stream: 100,000 entries. Hours-to-days at single-Hive
 *     load (1 RPS auth → ~28h retention).
 *
 * `~` prefix is Redis's "approximate trim" mode — slightly more
 * efficient because it lets Redis trim at radix-tree node
 * boundaries rather than exact counts. The ~10x slack is
 * acceptable for an audit log that's bounded by config.
 */
export const AUDIT_STREAM_MAXLEN = 10000;
export const AUTH_STREAM_MAXLEN = 100000;

// ---------------------------------------------------------------------------
// Stream key helpers
// ---------------------------------------------------------------------------

/** `hive:v1:agent-token:{installationId}:audit` — mutations stream. */
export function auditStreamKey(installationId: string): string {
  return `${ENVELOPE_PREFIX}${installationId}${AUDIT_SUFFIX}`;
}

/** `hive:v1:agent-token:{installationId}:auth` — auth events stream. */
export function authStreamKey(installationId: string): string {
  return `${ENVELOPE_PREFIX}${installationId}${AUTH_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

/**
 * Event classes that emit to the `:audit` (mutations) stream.
 *
 * The `queen.*` prefix is for queen-runtime events emitted by
 * `resolve-action`, `seal-decision`, `confirm-merge`, etc. — see
 * `queen-audit.ts` for the typed wrappers + payload schemas. They
 * reuse the agent-token mutations stream rather than introducing
 * a new one (same retention math, single grep target for
 * operators forensic-correlating queen events with token
 * mutations).
 */
export type AuditMutationAction =
  | "issue"
  | "revoke"
  | "set_capabilities"
  | "rotate"
  | "bootstrap"
  | "queen.verdict_floor_override"
  | "queen.action_downgrade";

/** Event classes that emit to the `:auth` (auth events) stream. */
export type AuditAuthAction = "auth.success" | "auth.failure";

interface BaseAuditEntry {
  /** Server-side timestamp (ISO 8601 UTC). */
  ts: string;
  /** First 8 hex chars of the bearer's SHA-256. NEVER raw bearer. */
  fingerprint: string;
  /** Token name (`name` field on the envelope). Empty for bootstrap
   * (the bootstrap admin token's name is created in the same call
   * that emits the event). */
  name: string;
  /** Optional client metadata. */
  client_ip?: string;
}

export interface AuditMutationEntry extends BaseAuditEntry {
  action: AuditMutationAction;
  /** Operator who initiated the action — admin token's name when
   * called via the API; "dashboard" when called via cookie auth
   * (bootstrap path). */
  actor: string;
  /** Optional structured detail. JSON.stringify'd inside the entry
   * for the stream. Use cases:
   *   - issue: `{capabilities, agent_role, expiresAt}`
   *   - set_capabilities: `{from: [...], to: [...]}`
   *   - rotate: `{}` (no narrative needed beyond the action itself)
   *   - revoke: `{reason?}`
   */
  detail?: Record<string, unknown>;
}

export interface AuditAuthEntry extends BaseAuditEntry {
  action: AuditAuthAction;
  /** API endpoint that triggered the auth check, e.g.
   * `"GET /api/whoami"` or `"POST /api/tasks/claim"`. */
  endpoint: string;
  /** Capability the route required (or null when route is
   * intentionally cap-less, e.g. /api/whoami). */
  required_capability: string | null;
  /** "ok" | "missing_bearer" | "unknown_bearer" | "token_expired"
   * | "missing_capability" | "server_misconfiguration" — the
   * stable wire-error code from `AGENT_AUTH_V1_ERROR` minus the
   * `agent_auth_v1_` prefix, OR "ok" on success. */
  outcome: string;
}

export type AuditEntry = AuditMutationEntry | AuditAuthEntry;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lua wrapper for `XADD ... MAXLEN ~ N * entry <json>`. Sidesteps
 * the variation in Upstash Redis SDK xadd/xtrim surface area by
 * letting the Redis server do the canonical command directly.
 *
 * KEYS: [streamKey]
 * ARGV: [maxlen, entryJson]
 * Returns: the new stream entry ID (string) on success.
 */
const XADD_AUDIT_SCRIPT = `
return redis.call("xadd", KEYS[1], "MAXLEN", "~", tonumber(ARGV[1]), "*", "entry", ARGV[2])
`;

/**
 * Emit an audit entry to the appropriate stream. Routes the event
 * to the mutations stream (`:audit`) or auth stream (`:auth`)
 * based on the action class, applying the right MAXLEN trim.
 *
 * Best-effort: failures are logged but do not throw. The audit
 * stream is observability state; a Redis hiccup on XADD shouldn't
 * fail the operator's actual mutation.
 *
 * For ISSUE / REVOKE / SET_CAPABILITIES / ROTATE, the storage
 * layer's Lua scripts handle the audit XADD atomically with the
 * storage write — callers there pass the audit-entry JSON via
 * the script's `auditEntryJsonOrEmpty` ARGV slot. This function
 * is for paths that DON'T have a wrapping script (BOOTSTRAP,
 * /api/whoami auth events, etc.).
 *
 * Returns void — fire-and-forget by design.
 */
export async function auditAppend(args: {
  redis: Redis;
  installationId: string;
  entry: AuditEntry;
}): Promise<void> {
  try {
    const isMutation = isMutationAction(args.entry.action);
    const streamKey = isMutation
      ? auditStreamKey(args.installationId)
      : authStreamKey(args.installationId);
    const maxlen = isMutation ? AUDIT_STREAM_MAXLEN : AUTH_STREAM_MAXLEN;
    await args.redis.eval(
      XADD_AUDIT_SCRIPT,
      [streamKey],
      [String(maxlen), JSON.stringify(args.entry)],
    );
  } catch (err) {
    console.warn(
      `[agent-token-v1-audit] auditAppend failed for ${args.installationId} action=${args.entry.action}`,
      err,
    );
  }
}

/**
 * Build a structured audit entry as JSON for passing into one of
 * the storage-layer scripts' `auditEntryJsonOrEmpty` ARGV slot.
 * Convenience wrapper around `JSON.stringify(entry)` so the
 * caller's call site is symmetric with `auditAppend(...)`.
 */
export function buildAuditEntryJson(entry: AuditEntry): string {
  return JSON.stringify(entry);
}

/**
 * Classifier used by `auditAppend` to route entries to the
 * `:audit` (mutations) or `:auth` stream.
 *
 * Exported (slice 2c-a builder pass-1): the queen-audit module
 * extended `AuditMutationAction` with `queen.*` events, and the
 * stream routing depends on this classifier accepting them at
 * runtime. The TypeScript narrowing on the enum alone doesn't
 * pin the JS branch; consumers (queen-audit.test.ts) call this
 * directly to assert the new actions are mutation-class.
 */
export function isMutationAction(action: string): action is AuditMutationAction {
  return (
    action === "issue" ||
    action === "revoke" ||
    action === "set_capabilities" ||
    action === "rotate" ||
    action === "bootstrap" ||
    action === "queen.verdict_floor_override" ||
    action === "queen.action_downgrade"
  );
}
