/**
 * Engine → (provider, allowed-kinds) constraint map (MODEL_AUTH_DESIGN.md §1.4).
 *
 * The engine catalog (`engine-catalog.ts`) carries NO credential metadata —
 * adding it there would create a third source of truth alongside
 * `apiary.engines.yaml`. Instead this backend-only validator DERIVES the
 * required `(provider, allowed kinds)` from the resolved engine's `tool` +
 * `provider`, reusing `resolveEngine()` so the engine list is never
 * re-encoded here.
 *
 * The tool→provider translation lives in this module and ONLY this module
 * (the design's §1.4 "translation layer"): the engine `tool` set
 * (claude/codex/opencode/kilo/gemini) and the credential `provider` set
 * (anthropic/openai/openrouter/zai/google) are NOT 1:1 —
 *   codex (tool)    → openai (provider)
 *   kilo (tool)     → openrouter (provider)
 *   opencode/zai    → zai (provider)
 *   claude (tool)   → anthropic (provider)
 *   gemini (tool)   → google (provider)
 *
 * Stage 1 ships the PURE VALIDATOR + its tests only. No agent wiring yet —
 * Stage 2 (agent association) consumes `validateCredentialForEngine` to reject
 * a credential whose provider/kind is incompatible with the agent's engine.
 */

import { resolveEngine } from "@/server/engine-catalog";
import type {
  ModelCredentialKind,
  ModelCredentialProvider,
} from "@/server/model-credential-store";

/**
 * tool → required credential provider. The catalog's explicit `provider`
 * field (e.g. kilo→openrouter, opencode→zai) takes precedence when present;
 * this map is the fallback for engines whose provider is implied by the tool
 * (claude→anthropic, codex→openai, gemini→google).
 *
 * Kept as a closed `Record` keyed by the known catalog tools so an unknown
 * tool fails closed (returns no mapping → validation rejects).
 */
const TOOL_TO_PROVIDER: Readonly<Record<string, ModelCredentialProvider>> = {
  claude: "anthropic",
  codex: "openai",
  kilo: "openrouter",
  opencode: "zai",
  gemini: "google",
};

/**
 * Per-provider allowed credential kinds.
 *
 *   - openai (codex): `oauth_subscription` ONLY. Codex uses device-auth /
 *     ChatGPT subscription; there is no plain-api-key path in the fleet
 *     (MODEL_AUTH_DESIGN.md §1.4 — "codex* → oauth_subscription only").
 *   - anthropic (claude): either an OAuth subscription token OR an api key.
 *   - everything else (openrouter/zai/google): `api_key`.
 *
 * Closed map: a provider absent here has no allowed kinds → validation
 * rejects (fail-closed).
 */
const PROVIDER_ALLOWED_KINDS: Readonly<
  Record<ModelCredentialProvider, readonly ModelCredentialKind[]>
> = {
  anthropic: ["oauth_subscription", "api_key"],
  openai: ["oauth_subscription"],
  openrouter: ["api_key"],
  zai: ["api_key"],
  google: ["api_key"],
};

export interface EngineCredentialConstraint {
  /** The credential provider this engine requires. */
  provider: ModelCredentialProvider;
  /** The credential kinds this engine accepts. */
  allowedKinds: readonly ModelCredentialKind[];
}

/**
 * Resolve the credential constraint for an engine id. Returns `null` for an
 * unknown engine OR an engine whose tool/provider doesn't map to a known
 * credential provider (fail-closed — the caller treats `null` as "cannot
 * validate, reject").
 *
 * Resolution order for the provider:
 *   1. the catalog entry's explicit `provider` (if it's a known credential
 *      provider) — covers kilo→openrouter, opencode→zai;
 *   2. otherwise the `tool → provider` fallback map — covers
 *      claude→anthropic, codex→openai, gemini→google.
 */
export function getEngineCredentialConstraint(
  engineId: string,
): EngineCredentialConstraint | null {
  const engine = resolveEngine(engineId);
  if (!engine) return null;

  // Prefer the catalog's explicit provider when it is a recognized credential
  // provider; else fall back to the tool→provider map.
  const explicit = engine.provider;
  const provider: ModelCredentialProvider | undefined =
    explicit && explicit in PROVIDER_ALLOWED_KINDS
      ? (explicit as ModelCredentialProvider)
      : TOOL_TO_PROVIDER[engine.tool];

  if (!provider) return null;

  const allowedKinds = PROVIDER_ALLOWED_KINDS[provider];
  if (!allowedKinds || allowedKinds.length === 0) return null;

  return { provider, allowedKinds };
}

export type ValidateCredentialForEngineResult =
  | { ok: true; provider: ModelCredentialProvider }
  | { ok: false; reason: string };

/**
 * Validate that a credential's `(provider, kind)` is compatible with the
 * given engine (MODEL_AUTH_DESIGN.md §1.4). Pure function — no I/O. Stage 2
 * calls this at agent create/update time (authoritative; never trust the
 * form). Returns a structured ok/reason so callers can surface a precise
 * error to the operator.
 *
 *   - unknown engine                → reject ("unknown engine")
 *   - provider mismatch             → reject (names the required provider)
 *   - provider ok but kind not allowed for it → reject (names allowed kinds)
 */
export function validateCredentialForEngine(
  engineId: string,
  credential: { provider: ModelCredentialProvider; kind: ModelCredentialKind },
): ValidateCredentialForEngineResult {
  const constraint = getEngineCredentialConstraint(engineId);
  if (!constraint) {
    return {
      ok: false,
      reason: `Unknown engine '${engineId}' — cannot determine the required credential provider.`,
    };
  }

  if (credential.provider !== constraint.provider) {
    return {
      ok: false,
      reason: `Provider mismatch: engine '${engineId}' requires a '${constraint.provider}' credential, but got '${credential.provider}'.`,
    };
  }

  if (!constraint.allowedKinds.includes(credential.kind)) {
    return {
      ok: false,
      reason: `Kind '${credential.kind}' is not allowed for engine '${engineId}' (provider '${constraint.provider}'); allowed: ${constraint.allowedKinds.join(", ")}.`,
    };
  }

  return { ok: true, provider: constraint.provider };
}
