/**
 * Capability vocabulary + preset expansion + validation primitives for
 * the per-key agent-token capability system (Phase B per
 * `docs/architecture/CAPABILITIES_DESIGN.md`).
 *
 * This module is the single source of truth for:
 * - The complete vocabulary of capabilities the API recognizes
 *   (`KNOWN_CAPABILITIES`).
 * - Capabilities that admin tokens grant but wildcards never expand
 *   to (`ADMIN_CLASS_CAPABILITIES`) — bare `*` and prefix `tasks.*` /
 *   `rooms.*` / etc. always exclude these.
 * - Hardcoded preset bundles (`PRESETS`) for issuance ergonomics:
 *   `apiarist`, `worker`, `queen`, `dispatcher`, `monitoring`, `admin`.
 * - Wildcard expansion at request time (`expandCapabilities`). Adding
 *   a new capability is a PR-touching-this-file change; the
 *   CHANGELOG entry should call out wildcard implications.
 * - Validation regexes for `name`, `agent_role`, and capability
 *   strings.
 *
 * The middleware, `/api/whoami`, the `hivemoot tokens` CLI, and the
 * issue/revoke/set-capabilities endpoints all import from here.
 * Diverging the vocabulary across consumers is exactly the silent
 * privilege-grant footgun the design doc was filed to prevent.
 */

// ---------------------------------------------------------------------------
// Validation regexes
// ---------------------------------------------------------------------------

/**
 * Token names + agent roles: lowercase ASCII, must start with a letter,
 * up to 32 chars, underscore + hyphen allowed inside. The leading-letter
 * rule keeps "1worker", "_admin", "-x" out — names should look like
 * identifiers a human would copy from a runbook.
 */
export const NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Capability strings: bare `*`, OR lowercase identifier with optional
 * `*` ONLY as the trailing segment. The R2.1 design review rejected
 * the prior `^[a-z_]+(\.[a-z_*]+)+$` regex because it permitted
 * mid-segment `*` (`tasks.*claim`, `tasks.cl*aim`).
 *
 *   matches:  *
 *             tasks.claim
 *             tasks.*
 *             agent_health.report
 *
 *   rejects:  Tasks.Claim       (uppercase)
 *             tasks.            (trailing dot)
 *             *.claim           (leading wildcard segment)
 *             tasks.*claim      (mid-segment wildcard)
 *             tasks.*.foo       (trailing-only invariant)
 *             tasks..claim      (empty segment)
 */
export const CAPABILITY_REGEX = /^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/;

/**
 * Strict validators that throw `CapabilityValidationError` on rejection.
 * Use at envelope-write time (issue / set-capabilities) so a malformed
 * string can never land in storage. The error carries the offending
 * field so route handlers can surface it directly to the operator.
 */
export class CapabilityValidationError extends Error {
  public readonly field: string;
  public readonly value: string;
  constructor(field: string, value: string, expectedDescription: string) {
    super(
      `Invalid ${field}: ${JSON.stringify(value)}. Expected ${expectedDescription}.`,
    );
    this.name = "CapabilityValidationError";
    this.field = field;
    this.value = value;
  }
}

export function validateName(value: string): void {
  if (!NAME_REGEX.test(value)) {
    throw new CapabilityValidationError(
      "name",
      value,
      "lowercase ASCII identifier starting with a letter, ≤32 chars (matching /^[a-z][a-z0-9_-]{0,31}$/)",
    );
  }
}

export function validateAgentRole(value: string): void {
  if (!NAME_REGEX.test(value)) {
    throw new CapabilityValidationError(
      "agent_role",
      value,
      "lowercase ASCII identifier starting with a letter, ≤32 chars (matching /^[a-z][a-z0-9_-]{0,31}$/)",
    );
  }
}

export function validateCapabilityString(value: string): void {
  if (!CAPABILITY_REGEX.test(value)) {
    throw new CapabilityValidationError(
      "capability",
      value,
      "bare `*` OR lowercase dot-separated identifier with optional trailing-only `*` (matching /^(\\*|[a-z_]+(\\.[a-z_]+)*(\\.\\*)?)$/)",
    );
  }
}

// ---------------------------------------------------------------------------
// Capability vocabulary
// ---------------------------------------------------------------------------

/**
 * Every capability the API recognizes. Wildcard expansion (`*`,
 * `tasks.*`, etc.) resolves against this list at request time.
 * Adding a new capability MUST update this constant; the CHANGELOG
 * for that PR should call out the wildcard implication ("now grants
 * `X` to existing `tasks.*` holders").
 *
 * Ordered by subsystem (installation_token → agent_health → tasks →
 * rooms → agent_tokens) for diff readability.
 */
export const KNOWN_CAPABILITIES = [
  // Installation-token brokerage (apiarist's only required cap).
  "installation_token.mint",
  // PR merge execution. Additive to installation_token.mint; the
  // broker honors it only after the bearer policy is checked.
  "pull_requests.merge",
  // Agent health observability.
  "agent_health.report",
  "agent_health.read",
  // Task lifecycle (workers).
  "tasks.claim",
  "tasks.progress",
  "tasks.complete",
  // Task management (bot/queen, dispatcher).
  "tasks.create",
  "tasks.read",
  "tasks.cancel",
  "tasks.verify",
  // War rooms — workers.
  "rooms.watch",
  "rooms.read",
  "rooms.contribute",
  // War rooms — installation-wide read (queen / monitoring / operator).
  // Distinct from `rooms.read` (worker self-rooms only) — see #517
  // builder R1: workers should not be able to enumerate every room
  // in the installation via the list endpoint or read sibling keys
  // for rooms outside their role-bound visibility set. The
  // worker-side visibility helper (`canReadRoomForBearer`) lands
  // with `/api/rooms/watching` in a follow-up slice.
  "rooms.read_all",
  // War rooms — bot (queen module).
  // Note (#519 guard N5): `POST /api/rooms` 409 `subject_already_open`
  // surfaces `existingRoomId` in the response body. Today the only
  // preset granting `rooms.create` (queen) also includes
  // `rooms.read_all`, so the disclosure is benign — the bearer can
  // already enumerate every room in the installation. Any future
  // preset with `rooms.create` but WITHOUT `rooms.read_all` would
  // turn the 409 into a roomId-discovery oracle. Keep this pairing
  // when adding a new preset, or strip `existingRoomId` from the
  // 409 when the bearer lacks `rooms.read_all`.
  "rooms.create",
  "rooms.update",
  "rooms.decide",
  "rooms.close",
  // War rooms — local-mode queen synthesis path (RFC PR 3 / D14).
  // Gates GET /api/rooms/synthesis-ready, GET decided-pending-ready,
  // POST claim-synthesis, POST resolve-action, POST seal-decision,
  // POST confirm-merge, POST report-merge-result. Additive to the
  // existing `rooms.decide` + `rooms.close` set so cloud queen
  // (cloud mode) and hive queen (local mode) can coexist with
  // distinct capability surfaces — no silent expansion of the
  // existing `queen` preset.
  "rooms.synthesize",
  // War rooms — admin.
  "rooms.force_close",
  // Token management (admin only — see ADMIN_CLASS_CAPABILITIES).
  "agent_tokens.manage",
] as const;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/**
 * Capabilities that admin classes grant but wildcards never expand to.
 * Both bare `*` and prefix `*.*` paths exclude these.
 *
 * Without this carve-out, an operator who issued `--capabilities
 * agent_tokens.*` thinking it's "everything in the agent_tokens
 * family except admin" would silently get full token-management
 * capability. The same applies to merge execution: pull_requests.*
 * must not silently grant PR merge rights. Admin-class caps are
 * reachable only via explicit single-string listing.
 */
export const ADMIN_CLASS_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  "agent_tokens.manage",
  "pull_requests.merge",
]);

// ---------------------------------------------------------------------------
// Wildcard expansion
// ---------------------------------------------------------------------------

/**
 * Expand a capability list (which may contain wildcards) into the
 * concrete capability set the bearer effectively holds. Used at
 * middleware request time when checking whether the bearer satisfies
 * an endpoint's `requires` capability.
 *
 * Rules:
 *   1. `*` → every entry in `KNOWN_CAPABILITIES` EXCEPT
 *      `ADMIN_CLASS_CAPABILITIES`.
 *   2. `<prefix>.*` → every `KNOWN_CAPABILITIES` entry whose key
 *      starts with `<prefix>.`, EXCEPT `ADMIN_CLASS_CAPABILITIES`.
 *   3. Concrete strings → added as-is. Unknown concrete strings are
 *      preserved (the caller's middleware can choose to log + fail or
 *      ignore; the validator earlier in the lifecycle rejects them at
 *      issue time).
 *
 * Returns a `Set<string>` so callers can `.has()` in O(1) for the cap
 * check. Idempotent — safe to call repeatedly on the same input.
 */
export function expandCapabilities(
  capabilities: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const entry of capabilities) {
    if (entry === "*") {
      for (const k of KNOWN_CAPABILITIES) {
        if (!ADMIN_CLASS_CAPABILITIES.has(k)) out.add(k);
      }
      continue;
    }
    if (entry.endsWith(".*")) {
      const prefix = entry.slice(0, -2);
      for (const k of KNOWN_CAPABILITIES) {
        if (k.startsWith(prefix + ".") && !ADMIN_CLASS_CAPABILITIES.has(k)) {
          out.add(k);
        }
      }
      continue;
    }
    out.add(entry);
  }
  return out;
}

/**
 * Convenience wrapper for the middleware's request-time check:
 * does the bearer hold the `required` capability after wildcard
 * expansion?
 */
export function bearerHasCapability(
  bearerCapabilities: readonly string[],
  required: string,
): boolean {
  return expandCapabilities(bearerCapabilities).has(required);
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * Preset capability bundles for common roles. Used by `tokens issue
 * --preset <name>` for issuance ergonomics; operators always free to
 * bypass with `--capabilities <list>`.
 *
 * `set-capabilities --preset <name>` is deliberately a snap to the
 * CURRENT preset definition (not the one at issue time) — adding a
 * new preset member during system evolution is the intended path
 * for granting it to existing preset-issued tokens.
 *
 * Preset wiring rationale (cross-referenced in CAPABILITIES_DESIGN.md):
 * - `apiarist`: only mints installation tokens. Smallest blast
 *   radius; runs on the host as a UDS broker.
 * - `worker`: containers (drone, builder, guard). NO
 *   `installation_token.mint` — workers go through apiarist's UDS,
 *   not the API directly.
 * - `queen`: bot's room-management token. Bot creates/updates/
 *   decides/closes rooms; doesn't itself claim or progress tasks.
 * - `dispatcher`: dashboard or external task creator.
 * - `monitoring`: read-only operator.
 * - `admin`: bare `*` + explicit `agent_tokens.manage` (the
 *   wildcard expansion does NOT include the latter).
 */
export const PRESETS: Readonly<Record<string, readonly string[]>> = {
  apiarist: [
    "installation_token.mint",
  ],
  worker: [
    "agent_health.report",
    "tasks.claim",
    "tasks.progress",
    "tasks.complete",
    "rooms.watch",
    "rooms.read",
    "rooms.contribute",
  ],
  queen: [
    "agent_health.report",
    "tasks.create",
    "tasks.read",
    "tasks.cancel",
    "rooms.create",
    "rooms.read",
    "rooms.read_all",
    "rooms.update",
    "rooms.decide",
    "rooms.close",
  ],
  // Local-mode queen preset (RFC PR 3 / D14 + builder pass-2 §2 +
  // builder pass-7 §5). Distinct from `queen` so a leaked existing
  // queen bearer cannot inherit `rooms.synthesize` or
  // `installation_token.mint` privileges. Critically does NOT
  // include `rooms.watch` (used to be a worker-style discovery
  // channel; the local queen polls `synthesis-ready` instead, which
  // is gated by `rooms.synthesize`).
  //
  // G16 — `installation_token.mint` is normally apiarist-only with
  // a UDS broker pattern. The local queen needs to mint installation
  // tokens directly (it runs in-container, can't go through a host
  // broker). Squash merge execution additionally requires
  // `pull_requests.merge`; both are bounded by D10's token policy.
  local_queen: [
    "agent_health.report",
    "tasks.create",
    "tasks.read",
    "tasks.cancel",
    "rooms.create",
    "rooms.read",
    "rooms.read_all",
    "rooms.update",
    "rooms.decide",
    "rooms.close",
    "rooms.synthesize",
    "installation_token.mint",
    "pull_requests.merge",
  ],
  dispatcher: [
    "tasks.create",
    "tasks.read",
  ],
  monitoring: [
    "agent_health.read",
    "tasks.read",
    "rooms.read",
    "rooms.read_all",
  ],
  admin: [
    "*",
    "agent_tokens.manage",
  ],
} as const;

export type PresetName = keyof typeof PRESETS;

export function isKnownPreset(name: string): name is PresetName {
  return Object.prototype.hasOwnProperty.call(PRESETS, name);
}

/**
 * Resolve a preset name to its capability list. Throws
 * `CapabilityValidationError` on unknown name so the caller surfaces
 * a clear error instead of silently issuing a token with `[]` caps.
 */
export function resolvePreset(name: string): readonly string[] {
  if (!isKnownPreset(name)) {
    throw new CapabilityValidationError(
      "preset",
      name,
      `one of: ${Object.keys(PRESETS).sort().join(", ")}`,
    );
  }
  return PRESETS[name];
}

// ---------------------------------------------------------------------------
// Mint-capable issuance gate (PR 645 builder pass-1 B1 / pass-2 / pass-3;
// RFC D10 + G16)
// ---------------------------------------------------------------------------

/**
 * The exact `allowed_permissions` shape RFC D10 specifies for the
 * local_queen mint policy. Mint-capable non-apiarist tokens must be
 * issued with this set verbatim — narrower fails closed (bearer
 * cannot use a permission it needs), broader violates D10 by
 * exceeding the queen's needed scope.
 *
 * `contents: "write"` is needed for the approved squash-merge
 * execution path. The broker's default remains `contents: "read"`;
 * local queen has to carry `pull_requests.merge` before this scope is
 * requested.
 */
export const LOCAL_QUEEN_REQUIRED_PERMISSIONS: Readonly<
  Record<string, "read" | "write" | "admin">
> = Object.freeze({
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
});

/**
 * Issue-time policy gate for mint-capable presets and roles.
 *
 * Per RFC D10 + G16, tokens granting `installation_token.mint` for
 * the new `local_queen` role must be issued with BOTH halves of
 * the D10 policy:
 *   - `allowed_repos` — non-empty list (repo fan-out bound)
 *   - `allowed_permissions` — exactly the LOCAL_QUEEN_REQUIRED_PERMISSIONS
 *      set (permission scope bound, including the contents:write scope
 *      GitHub requires for squash merge execution)
 *
 * The default mint endpoint intersects V1_PERMISSIONS with the
 * bearer's allowed_permissions; the merge-capable mint uses this
 * exact local-queen scope as its ceiling. Without this gate enforcing
 * both halves, a leaked allowedRepos-only local_queen bearer would
 * have ambiguous scope at mint time.
 *
 * `apiarist` is exempt from BOTH halves: the existing host-broker
 * preset predates the policy model and tightening it would break
 * in-the-wild apiarist tokens. The next slice tracks graduating
 * apiarist into the gate too — until then it stays legacy.
 *
 * Used by:
 *   - POST /api/agent-tokens (operator-bearer issue)
 *   - POST /api/dashboard/agent-tokens (cookie-auth issue)
 *   - POST /api/agent-tokens/{name}/set-capabilities (recap; only
 *     when the operation transitions a token INTO mint-capable shape)
 */
export interface MintPolicyGateInput {
  /** Effective capability list of the resulting/updated token. */
  capabilities: readonly string[];
  /**
   * Preset name when the issue came from a preset; null for the
   * explicit-capabilities path. The apiarist + admin carve-outs key
   * on this server-resolved preset name (see pass-2 fix).
   */
  presetName?: string | null;
  /**
   * Whether the caller passed `allowWildcards: true` — the explicit
   * opt-in for bare `*` admin issuance. When the capability list
   * contains a bare `*` AND this flag is true, the gate treats the
   * token as the admin chain-root shape (which already grants
   * `installation_token.mint` via wildcard expansion) and exempts
   * it from D10. Mirrors the explicit `*` rejection rule on the
   * mint endpoint's auth path. Default false.
   */
  allowWildcards?: boolean;
  /**
   * The policy that will be persisted with the token (snake_case
   * storage shape). null when no policy was supplied.
   */
  policy?: {
    allowed_repos?: readonly string[] | null;
    allowed_permissions?: Readonly<Record<string, string>> | null;
  } | null;
}

/**
 * Legacy carve-outs for the mint-policy gate. Both predate the D10
 * model and tightening either would break in-the-wild tokens:
 *   - `apiarist`: host-broker preset (UDS-based mint pattern).
 *   - `admin`: bare-`*` admin preset, the chain root for issuing
 *      other tokens. Admin tokens hold every cap by wildcard
 *      expansion including `installation_token.mint`; per RFC
 *      they are intentionally privileged and predate D10's
 *      per-token policy model. New mint-capable presets MUST go
 *      through the gate; this set is closed.
 *
 * Pass-4 (B1, builder pass-3 follow-up): admin was added explicitly
 * after a bypass via `capabilities: ["*"]` was found — see
 * `validateMintPolicyRequirement` doc for the wildcard expansion fix.
 */
const MINT_GATE_LEGACY_PRESETS: ReadonlySet<string> = new Set([
  "apiarist",
  "admin",
]);

/**
 * Issue-time policy gate.
 *
 * # Pass-4 fix — wildcard-aware capability detection (B1, builder pass-3 follow-up)
 *
 * Pass-3's gate used `capabilities.includes("installation_token.mint")`
 * — a literal-string check. Authorization at the mint endpoint
 * uses `bearerHasCapability` which expands wildcards, so:
 *   - `capabilities: ["installation_token.*"]` does NOT trigger the
 *     gate (no literal match) but DOES satisfy
 *     `requires: "installation_token.mint"` at mint time
 *   - `capabilities: ["pull_requests.*"]` can satisfy
 *     `pull_requests.merge` for merge-capable minting
 *   - `capabilities: ["*"]` (with `allowWildcards: true`) has the
 *     same shape
 *
 * Both bypasses are now closed by switching the gate to
 * `bearerHasCapability` for every mint-capable permission — the SAME
 * predicate authorization uses. If the bearer can EVER mint at request
 * time, the gate fires at issue time. Symmetric semantics, no
 * asymmetry to exploit.
 *
 * `admin` is added to the legacy carve-out alongside `apiarist`.
 * Admin tokens are the chain root and intentionally hold every
 * cap by wildcard; subjecting them to the D10 gate would break
 * the bootstrap path. See `MINT_GATE_LEGACY_PRESETS`.
 *
 * # Pass-3 fix — both halves of D10
 *
 * Pass-2 only enforced repo fan-out (allowed_repos). The mint
 * endpoint falls back to V1_PERMISSIONS (which includes
 * `contents: "read"`) when allowed_permissions is omitted,
 * violating D10's permission scope half. The gate now also
 * requires the exact LOCAL_QUEEN_REQUIRED_PERMISSIONS shape.
 *
 * # Pass-2 fix — apiarist carve-out is preset-only
 *
 * Pass-1 trusted operator-supplied `agent_role` for the apiarist
 * exemption. Now keys ONLY on the server-resolved preset name.
 */
export function validateMintPolicyRequirement(
  args: MintPolicyGateInput,
): { ok: true } | { ok: false; message: string } {
  // Wildcard-aware: ["installation_token.*"] and ["*"] both trigger
  // the gate, matching the request-time auth predicate exactly.
  const grantsMint =
    bearerHasCapability(args.capabilities, "installation_token.mint") ||
    bearerHasCapability(args.capabilities, "pull_requests.merge");
  if (!grantsMint) return { ok: true };

  // Server-resolved preset-name gate ONLY — agent_role is operator-
  // supplied and cannot be trusted for a security decision.
  // Both apiarist (legacy host-broker) and admin (chain root) are
  // explicit carve-outs predating D10.
  if (args.presetName !== null && args.presetName !== undefined) {
    if (MINT_GATE_LEGACY_PRESETS.has(args.presetName)) return { ok: true };
  }

  // Explicit-caps admin opt-in: `capabilities: ["*"]` + the
  // documented `allowWildcards: true` flag is the explicit
  // power-user path for issuing an admin chain-root bearer
  // without going through `preset: "admin"`. Bare `*` already
  // expands to `installation_token.mint` (and every other non-
  // admin-class cap), so the gate would fire on every admin
  // token without this carve-out. Matches the
  // MINT_GATE_LEGACY_PRESETS["admin"] exemption shape, just
  // wired through capabilities rather than preset.
  //
  // The carve-out requires BOTH: a literal bare `*` in the cap
  // list AND the operator's deliberate opt-in flag. Any other
  // wildcard form (e.g. `installation_token.*`) does NOT qualify
  // — those still trip the gate.
  if (args.allowWildcards && args.capabilities.includes("*")) {
    return { ok: true };
  }

  // ----- Half 1 of D10: allowed_repos ≥ 1 -----
  const repos = args.policy?.allowed_repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    return {
      ok: false,
      message:
        "Tokens granting installation_token.mint or pull_requests.merge " +
        "must be issued with " +
        "a non-empty policy.allowedRepos list (RFC D10 half 1: bound " +
        "the mint repo fan-out). Pass policy: { allowedRepos: " +
        "['owner/repo', ...] } at issue time. The legacy apiarist " +
        "preset is exempt only via `preset: 'apiarist'`.",
    };
  }

  // ----- Half 2 of D10: allowed_permissions matches local-queen set -----
  const perms = args.policy?.allowed_permissions;
  if (!perms || typeof perms !== "object") {
    return {
      ok: false,
      message:
        "Tokens granting installation_token.mint or pull_requests.merge " +
        "must be issued with " +
        "policy.allowedPermissions matching the RFC D10 local-queen " +
        "permission scope (contents: write, pull_requests: write, " +
        "issues: write, metadata: read). Omitting allowedPermissions " +
        "falls back to the broker default at mint time, which is " +
        "not sufficient for approved squash merge execution.",
    };
  }

  const required = LOCAL_QUEEN_REQUIRED_PERMISSIONS;
  const requiredKeys = Object.keys(required);
  const givenKeys = Object.keys(perms);
  const allRequiredPresent = requiredKeys.every(
    (k) => perms[k] === required[k],
  );
  const noExtraKeys = givenKeys.every((k) =>
    Object.prototype.hasOwnProperty.call(required, k),
  );
  if (!allRequiredPresent || !noExtraKeys) {
    const expected = JSON.stringify(required);
    const got = JSON.stringify(perms);
    return {
      ok: false,
      message:
        `Tokens granting installation_token.mint must have ` +
        `policy.allowedPermissions exactly equal to the RFC D10 ` +
        `local-queen scope ${expected}. Got ${got}. Notably ` +
        `\`contents\` MUST be omitted — the local queen synthesizes ` +
        `verdicts from war-room contributions and must not read repo ` +
        `files.`,
    };
  }

  return { ok: true };
}
