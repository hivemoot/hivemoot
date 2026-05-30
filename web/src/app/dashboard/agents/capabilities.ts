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
