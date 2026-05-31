/**
 * Pure, framework-free logic for the plugin-first agent form.
 *
 * Extracted from `AgentConfigForm.tsx` so the payload-building and client-side
 * validation can be unit-tested in the node test environment (the test runner
 * has no DOM). The React component owns state + rendering and delegates the
 * canonical-shape and validation decisions here.
 *
 * The functions here MIRROR the backend rules in `@/server/fleet-store`
 * (`validatePlugins` / `validateCreateAgentInput` / `validateUpdateAgentInput`)
 * so the operator gets fast feedback before the round-trip; the server remains
 * the single source of truth and re-validates on every write.
 */

import { type FleetPlugins } from "./types";

// Bounds mirror @/server/fleet-store.
export const MAX_SYSTEM_PROMPT_CHARS = 16_000;
export const MAX_SCHEDULE_PROMPT_CHARS = 2_000;
export const MAX_DISPLAY_NAME_CHARS = 80;
export const NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

/** GitHub login, for the watch_new_prs_authors allowlist. */
const GITHUB_LOGIN_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

// ---------------------------------------------------------------------------
// Plugin enablement state (the form's working model)
// ---------------------------------------------------------------------------

/**
 * The form's full plugin working state. Every plugin block is always present
 * (enabled or not) so the canonical submit payload is unambiguous and the PATCH
 * replace-set semantics are honoured. `Required<FleetPlugins>` guarantees each
 * key exists in the form even before the operator touches it.
 */
export type PluginsFormState = Required<FleetPlugins>;

/**
 * Build the canonical `plugins` object to submit (POST or PATCH). Includes ONLY
 * the fields the backend stores per plugin; the empty `watch_new_prs_authors`
 * key is omitted (empty = all authors, matching the backend's normalization).
 *
 * Every plugin block is included (enabled or not) — the backend type-validates
 * present-but-disabled blocks and the PATCH path replaces the whole set, so
 * sending the complete set keeps "this plugin is off" explicit rather than
 * ambiguous-omitted.
 *
 * IMPORTANT: this returns ONLY plugin data. There is no top-level repos / duty /
 * triggers anywhere — repos live exclusively under `plugins.github.repos`.
 */
export function buildPluginsPayload(state: PluginsFormState): FleetPlugins {
  const authors = state.github.watch_new_prs_authors ?? [];
  return {
    github: {
      enabled: state.github.enabled,
      repos: [...state.github.repos],
      watch_new_prs: state.github.watch_new_prs,
      watch_review_requests: state.github.watch_review_requests,
      watch_mentions: state.github.watch_mentions,
      poll_interval_secs: state.github.poll_interval_secs,
      // Only carry the allowlist when non-empty (empty = react to all authors).
      ...(authors.length > 0 ? { watch_new_prs_authors: authors } : {}),
    },
    schedule: {
      enabled: state.schedule.enabled,
      interval_secs: state.schedule.interval_secs,
      jitter_secs: state.schedule.jitter_secs,
      prompt: state.schedule.prompt,
    },
    tasks: { enabled: state.tasks.enabled },
    war_rooms: { enabled: state.war_rooms.enabled, contribute: state.war_rooms.contribute },
  };
}

/** Parse a comma/space-separated author string into a deduped login list. */
export function parseAuthorList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    const t = token.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True when ≥1 plugin is enabled (mirrors the backend "at least one" rule). */
export function anyPluginEnabled(state: PluginsFormState): boolean {
  return (
    state.github.enabled ||
    state.schedule.enabled ||
    state.tasks.enabled ||
    state.war_rooms.enabled
  );
}

/** True when the github plugin has ≥1 watch flag on (its trigger requirement). */
export function githubHasWatch(github: PluginsFormState["github"]): boolean {
  return github.watch_new_prs || github.watch_review_requests || github.watch_mentions;
}

export interface FormValidationInput {
  isEdit: boolean;
  name: string;
  displayName: string;
  engine: string;
  agentTokenName: string;
  systemPrompt: string;
  plugins: PluginsFormState;
}

/**
 * Client-side validation for fast feedback. Returns an error string or null.
 * Mirrors the backend's hard rules:
 *   - name matches NAME_REGEX (create only; name is immutable on edit)
 *   - a token is selected; an engine is selected
 *   - display name / system prompt within bounds
 *   - at least one plugin enabled
 *   - github enabled ⇒ ≥1 watch flag AND ≥1 repo selected
 *   - schedule enabled ⇒ non-empty prompt
 *
 * NOTE: capability gaps are intentionally NOT validated here — they are soft,
 * non-blocking warnings (the token is independent of the agent).
 */
export function validateForm(input: FormValidationInput): string | null {
  if (!input.isEdit && !NAME_REGEX.test(input.name)) {
    return "Name must be a lowercase identifier starting with a letter (≤32 chars, a–z 0–9 _ -).";
  }
  if (!input.agentTokenName) return "Pick a token for this agent.";
  if (!input.engine) return "Pick an engine.";
  if (input.displayName.trim().length > MAX_DISPLAY_NAME_CHARS) {
    return `Display name must be ≤${MAX_DISPLAY_NAME_CHARS} characters.`;
  }
  if (input.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
    return `System prompt must be ≤${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters.`;
  }

  if (!anyPluginEnabled(input.plugins)) {
    return "Enable at least one plugin — an agent with no plugins does nothing.";
  }

  const { github, schedule } = input.plugins;
  if (github.enabled) {
    if (!githubHasWatch(github)) {
      return "Enable at least one GitHub watch (new PRs / review requests / mentions).";
    }
    if (github.repos.length === 0) {
      return "Select at least one repository for the GitHub plugin.";
    }
    const badAuthor = (github.watch_new_prs_authors ?? []).find(
      (a) => !GITHUB_LOGIN_REGEX.test(a),
    );
    if (badAuthor !== undefined) {
      return `"${badAuthor}" is not a valid GitHub login in the PR-author list.`;
    }
  }
  if (schedule.enabled && schedule.prompt.trim().length === 0) {
    return "A schedule prompt is required when the Schedule plugin is enabled.";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hydration — turn a stored FleetAgent's plugins into the full form state
// ---------------------------------------------------------------------------

/**
 * Merge a stored agent's (possibly partial) plugins into a complete form state,
 * filling any absent plugin from defaults. Used when editing an existing agent.
 */
export function hydratePluginsState(
  defaults: PluginsFormState,
  stored: FleetPlugins | undefined,
): PluginsFormState {
  if (!stored) return defaults;
  return {
    github: stored.github
      ? {
          ...defaults.github,
          ...stored.github,
          watch_new_prs_authors: stored.github.watch_new_prs_authors ?? [],
        }
      : defaults.github,
    schedule: stored.schedule ? { ...defaults.schedule, ...stored.schedule } : defaults.schedule,
    tasks: stored.tasks ? { ...defaults.tasks, ...stored.tasks } : defaults.tasks,
    war_rooms: stored.war_rooms
      ? { ...defaults.war_rooms, ...stored.war_rooms }
      : defaults.war_rooms,
  };
}
