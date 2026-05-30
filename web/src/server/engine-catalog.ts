/**
 * Engine catalog — the backend-authoritative mirror of the fleet's
 * `apiary.engines.yaml`. An "engine" is a named (tool, provider, model,
 * tool_options) combination an agent references by id.
 *
 * Why mirror it here: with the backend as the authoritative source of truth for
 * the fleet, the desired-state endpoint must return a FULLY RESOLVED engine
 * descriptor so the sidecar can render a container without reading
 * `apiary.engines.yaml`. The reconciler trusts this descriptor; the engine id is
 * an enum (validated against this catalog), never free-form, so it can never
 * become a container flag or path.
 *
 * Keep in sync with `apiary/apiary.engines.yaml`. Adding an engine here + matching
 * provider credentials on the hive is what makes it selectable for an agent.
 */

export interface EngineCatalogEntry {
  /** Stable engine id (matches `apiary.engines.yaml` key). */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** The CLI tool the agent container runs (claude / codex / opencode / …). */
  tool: string;
  /** Optional API provider override (e.g. zai, openrouter). */
  provider?: string;
  /** Optional model id passed to the tool. */
  model?: string;
  /** Optional tool-specific runtime knobs (e.g. codex reasoning effort). */
  tool_options?: Record<string, string>;
}

/**
 * Fully-resolved engine descriptor returned in the desired-state contract.
 * `provider`/`model`/`tool_options` are always present (null when not set) so
 * the consumer never has to distinguish "absent" from "explicitly null".
 */
export interface ResolvedEngine {
  id: string;
  tool: string;
  provider: string | null;
  model: string | null;
  tool_options: Record<string, string> | null;
}

export const ENGINE_CATALOG: readonly EngineCatalogEntry[] = [
  { id: "claude", label: "Claude (default)", tool: "claude" },
  { id: "claude-opus", label: "Claude Opus 4.6", tool: "claude", model: "claude-opus-4-6" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", tool: "claude", model: "claude-opus-4-7" },
  { id: "claude-sonnet", label: "Claude Sonnet 4.6", tool: "claude", model: "claude-sonnet-4-6" },
  {
    id: "codex",
    label: "Codex (gpt-5.4, medium)",
    tool: "codex",
    model: "gpt-5.4",
    tool_options: { model_reasoning_effort: "medium" },
  },
  { id: "codex-spark", label: "Codex Spark", tool: "codex", model: "gpt-5.3-codex-spark" },
  {
    id: "codex-xhigh",
    label: "Codex (gpt-5.4, xhigh)",
    tool: "codex",
    model: "gpt-5.4",
    tool_options: { model_reasoning_effort: "xhigh" },
  },
  {
    id: "codex-gpt-5-5-xhigh",
    label: "Codex (gpt-5.5, xhigh)",
    tool: "codex",
    model: "gpt-5.5",
    tool_options: { model_reasoning_effort: "xhigh" },
  },
  { id: "kimi", label: "Kimi K2.5", tool: "kilo", provider: "openrouter", model: "openrouter/moonshotai/kimi-k2.5" },
  { id: "minimax", label: "MiniMax M2.5", tool: "kilo", provider: "openrouter", model: "openrouter/minimax/minimax-m2.5" },
  { id: "gemini", label: "Gemini 3.1 Pro", tool: "gemini", model: "gemini-3.1-pro-preview" },
  { id: "zai", label: "GLM-5.1 (Z.AI)", tool: "opencode", provider: "zai", model: "zai/glm-5.1" },
] as const;

const ENGINE_BY_ID: ReadonlyMap<string, EngineCatalogEntry> = new Map(
  ENGINE_CATALOG.map((e) => [e.id, e]),
);

/** True when `id` is a known engine. */
export function isKnownEngine(id: string): boolean {
  return ENGINE_BY_ID.has(id);
}

/**
 * Resolve an engine id to its full descriptor. Returns `null` for an unknown
 * id so callers fail closed (the fleet store rejects unknown engines at
 * validation, so this is a defensive double-check for the desired-state path).
 */
export function resolveEngine(id: string): ResolvedEngine | null {
  const entry = ENGINE_BY_ID.get(id);
  if (!entry) return null;
  return {
    id: entry.id,
    tool: entry.tool,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    tool_options: entry.tool_options ?? null,
  };
}
