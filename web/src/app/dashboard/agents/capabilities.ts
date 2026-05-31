/**
 * Soft (non-blocking) capability gate for the plugin-first agent form.
 *
 * The linked capability token is INDEPENDENT of the agent — it carries
 * capabilities only and the backend never rejects an agent because the token
 * lacks a capability an enabled plugin needs. The dashboard simply WARNS the
 * operator when a plugin they enabled won't actually work with the selected
 * token, so they can fix it on Credentials. None of this blocks submit.
 *
 * The capability requirements (authoritative copy of the runtime's gate):
 *   - tasks      → tasks.claim (+ ideally tasks.progress, tasks.complete)
 *   - war_rooms  → rooms.watch, rooms.read
 *   - war_rooms (contribute=true) → + rooms.contribute
 *   - github / schedule → no token capability needed (they drive WHEN/WHERE the
 *     agent runs, not WHAT V1 API surface it calls)
 *
 * This MIRRORS the backend capability vocabulary; it never imports a server-only
 * module so it stays a pure client-side check.
 */

import { type FleetPlugins, type PluginKey, PLUGIN_LABELS } from "./types";

// ---------------------------------------------------------------------------
// Plugin → required-capability mapping
// ---------------------------------------------------------------------------

/**
 * A capability an enabled plugin needs, plus whether it's strictly REQUIRED for
 * the plugin to function or merely RECOMMENDED. The warning treats both the
 * same way for "what's missing" reporting, but the distinction documents intent
 * (e.g. tasks.claim is required to claim at all; progress/complete are needed to
 * report back).
 */
export interface CapabilityRequirement {
  capability: string;
  required: boolean;
}

/** Capabilities the `tasks` plugin needs to do its job. */
export const TASKS_REQUIREMENTS: CapabilityRequirement[] = [
  { capability: "tasks.claim", required: true },
  { capability: "tasks.progress", required: false },
  { capability: "tasks.complete", required: false },
];

/** Capabilities the `war_rooms` plugin needs (observe-only baseline). */
export const WAR_ROOMS_OBSERVE_REQUIREMENTS: CapabilityRequirement[] = [
  { capability: "rooms.watch", required: true },
  { capability: "rooms.read", required: true },
];

/** The extra capability a CONTRIBUTING war-rooms agent needs (to post). */
export const WAR_ROOMS_CONTRIBUTE_REQUIREMENT: CapabilityRequirement = {
  capability: "rooms.contribute",
  required: true,
};

/**
 * The full set of capabilities the enabled plugins need, given the form's
 * current plugin config. `github` and `schedule` contribute nothing.
 */
export function requiredCapabilitiesForPlugins(plugins: FleetPlugins): CapabilityRequirement[] {
  const out: CapabilityRequirement[] = [];
  if (plugins.tasks?.enabled) {
    out.push(...TASKS_REQUIREMENTS);
  }
  if (plugins.war_rooms?.enabled) {
    out.push(...WAR_ROOMS_OBSERVE_REQUIREMENTS);
    if (plugins.war_rooms.contribute) out.push(WAR_ROOMS_CONTRIBUTE_REQUIREMENT);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token capability expansion (mirror the server's wildcard semantics)
// ---------------------------------------------------------------------------

/**
 * The capabilities a fleet agent's plugins can ever need (the closed range of
 * `requiredCapabilitiesForPlugins`). All are non-admin-class, so a bare `*`
 * token covers every one of them — matching the server's `expandCapabilities`
 * semantics. Hardcoded so the check stays a pure client-side preview.
 */
const PLUGIN_NEEDABLE_CAPABILITIES = [
  "tasks.claim",
  "tasks.progress",
  "tasks.complete",
  "rooms.watch",
  "rooms.read",
  "rooms.contribute",
] as const;

/**
 * Expand a token's capability list into the concrete set it effectively grants,
 * restricted to plugin-needable capabilities. Mirrors `expandCapabilities`:
 *   - bare `*`        → every plugin-needable capability
 *   - `<prefix>.*`    → every needable capability under that prefix
 *   - concrete string → added as-is
 */
function expandTokenCapabilities(tokenCaps: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const entry of tokenCaps) {
    if (entry === "*") {
      for (const c of PLUGIN_NEEDABLE_CAPABILITIES) out.add(c);
      continue;
    }
    if (entry.endsWith(".*")) {
      const prefix = entry.slice(0, -2);
      for (const c of PLUGIN_NEEDABLE_CAPABILITIES) {
        if (c.startsWith(prefix + ".")) out.add(c);
      }
      continue;
    }
    out.add(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Token lacks capability" detection
// ---------------------------------------------------------------------------

/** One plugin's unmet capability needs, keyed for operator-readable warnings. */
export interface PluginCapabilityGap {
  plugin: PluginKey;
  /** Capabilities the enabled plugin needs that the token does not grant. */
  missing: string[];
}

/**
 * Compute the per-plugin capability gaps for the current plugin config against
 * the selected token's capabilities. A plugin appears in the result ONLY when it
 * is enabled AND the token is missing ≥1 capability it needs.
 *
 * Returns an empty array when there is no gap (or no token / nothing enabled).
 * This is advisory — callers must NOT block submit on a non-empty result.
 */
export function detectCapabilityGaps(
  plugins: FleetPlugins,
  tokenCapabilities: readonly string[],
): PluginCapabilityGap[] {
  const granted = expandTokenCapabilities(tokenCapabilities);
  const gaps: PluginCapabilityGap[] = [];

  if (plugins.tasks?.enabled) {
    const missing = TASKS_REQUIREMENTS.map((r) => r.capability).filter((c) => !granted.has(c));
    if (missing.length > 0) gaps.push({ plugin: "tasks", missing });
  }

  if (plugins.war_rooms?.enabled) {
    const reqs = [...WAR_ROOMS_OBSERVE_REQUIREMENTS];
    if (plugins.war_rooms.contribute) reqs.push(WAR_ROOMS_CONTRIBUTE_REQUIREMENT);
    const missing = reqs.map((r) => r.capability).filter((c) => !granted.has(c));
    if (missing.length > 0) gaps.push({ plugin: "war_rooms", missing });
  }

  return gaps;
}

/**
 * Render the capability gaps into a single operator-readable warning string, or
 * `null` when there is no gap. Phrased in plugin terms ("Tasks needs …") so the
 * operator knows which toggle is affected.
 */
export function describeCapabilityGaps(gaps: PluginCapabilityGap[]): string | null {
  if (gaps.length === 0) return null;
  const parts = gaps.map((g) => `${PLUGIN_LABELS[g.plugin]} needs ${g.missing.join(", ")}`);
  return `The selected token is missing capabilities for enabled plugins: ${parts.join("; ")}. The agent can still be created — fix the token on Credentials if these plugins should work.`;
}
