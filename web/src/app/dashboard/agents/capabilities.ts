/**
 * Client-side preview of the capabilities a fleet agent will receive, derived
 * purely from its enabled triggers.
 *
 * This MIRRORS the backend's `deriveCapabilities` closed allowlist
 * (`@/server/agent-token-capabilities`). It exists only to render an accurate
 * "Capabilities this agent will receive" preview in the create/edit form — the
 * server remains the single source of truth and re-derives capabilities on
 * every write, so a drift here only affects the preview, never the grant.
 *
 * The mapping (authoritative copy):
 *   - always                       → agent_health.report
 *   - tasks                        → tasks.claim, tasks.progress, tasks.complete
 *   - war_rooms                    → rooms.watch, rooms.read
 *   - war_rooms (contribute=true)  → + rooms.contribute
 *   - schedule                     → (nothing)
 *   - pull_requests                → (nothing)
 *   - mentions                     → (nothing)
 */

export interface TriggerFlags {
  schedule: boolean;
  pull_requests: boolean;
  mentions: boolean;
  tasks: boolean;
  war_rooms: boolean;
  /** Observe-only (false/omitted) ⇒ no rooms.contribute. */
  war_rooms_contribute?: boolean;
}

const ALWAYS_CAPABILITIES = ["agent_health.report"] as const;
const TASKS_CAPABILITIES = ["tasks.claim", "tasks.progress", "tasks.complete"] as const;
const WAR_ROOMS_OBSERVE_CAPABILITIES = ["rooms.watch", "rooms.read"] as const;

/**
 * Returns the sorted, de-duplicated capability list the agent will be granted.
 * `agent_health.report` is always present (every agent reports health).
 */
export function previewCapabilities(flags: TriggerFlags): string[] {
  const caps = new Set<string>(ALWAYS_CAPABILITIES);
  if (flags.tasks) for (const c of TASKS_CAPABILITIES) caps.add(c);
  if (flags.war_rooms) {
    for (const c of WAR_ROOMS_OBSERVE_CAPABILITIES) caps.add(c);
    // Only a contributing (non-observe-only) war-room agent may post.
    if (flags.war_rooms_contribute) caps.add("rooms.contribute");
  }
  // schedule / pull_requests / mentions add nothing — they drive WHEN the agent
  // runs, not WHAT API surface it can call.
  return Array.from(caps).sort();
}

// ---------------------------------------------------------------------------
// Token coverage — does the linked token's capability list cover what the
// agent's enabled triggers need?
// ---------------------------------------------------------------------------

/**
 * The capabilities a fleet agent can ever need (the closed range of
 * `previewCapabilities`). All are non-admin-class, so a bare `*` token covers
 * every one of them — matching the server's `expandCapabilities` semantics
 * where `*` expands to all KNOWN_CAPABILITIES except the admin-class
 * (`agent_tokens.manage`, `pull_requests.merge`). Hardcoded here so the
 * coverage check stays a pure client-side preview and never imports a
 * server-only module.
 */
const AGENT_NEEDABLE_CAPABILITIES = [
  "agent_health.report",
  "tasks.claim",
  "tasks.progress",
  "tasks.complete",
  "rooms.watch",
  "rooms.read",
  "rooms.contribute",
] as const;

/**
 * Expand a token's capability list into the concrete set it effectively
 * grants, restricted to the capabilities an agent could need. Mirrors the
 * server's `expandCapabilities`:
 *   - bare `*`        → every agent-needable capability
 *   - `<prefix>.*`    → every needable capability under that prefix
 *   - concrete string → added as-is
 *
 * Admin-class wildcard carve-outs are irrelevant here because no agent-needable
 * capability is admin-class, so we never need to subtract anything.
 */
function expandTokenCapabilities(tokenCaps: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const entry of tokenCaps) {
    if (entry === "*") {
      for (const c of AGENT_NEEDABLE_CAPABILITIES) out.add(c);
      continue;
    }
    if (entry.endsWith(".*")) {
      const prefix = entry.slice(0, -2);
      for (const c of AGENT_NEEDABLE_CAPABILITIES) {
        if (c.startsWith(prefix + ".")) out.add(c);
      }
      continue;
    }
    out.add(entry);
  }
  return out;
}

/**
 * Whether the token's capabilities cover every needed capability. Used to warn
 * (never block) when a trigger is enabled that the linked token can't satisfy —
 * e.g. the tasks trigger is on but the token can't claim tasks.
 *
 * `needed` is typically `previewCapabilities(triggers)`. Wildcards in
 * `tokenCaps` (`*`, `tasks.*`) are expanded before comparison.
 */
export function tokenCoversCapabilities(
  tokenCaps: string[],
  needed: string[],
): { covered: boolean; missing: string[] } {
  const granted = expandTokenCapabilities(tokenCaps);
  const missing = needed.filter((cap) => !granted.has(cap));
  return { covered: missing.length === 0, missing };
}
