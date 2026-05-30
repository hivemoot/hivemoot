# Agent Token Capabilities — Design

> Status: design proposal (Phase B of the post-apiarist-V1 ultra plan).
> Scope: per-key capability system for hivemoot.dev API, replacing the
> single-token-per-installation "all-or-nothing" implicit permissions.
> Co-ships: REDIS_KEY_CONVENTION.md (canonical key naming spec).

## Problem

Today every agent token has implicit "all capabilities" — it can mint
GitHub installation tokens, post agent health, claim tasks. There's
exactly one token per installation; every service on every Hive shares
it. Adding new API endpoints (war rooms, task creation, task verifiers,
read-only roles) means every existing token automatically gains the new
capability. That's the inverse of least-privilege.

## Goals

- **Per-key capabilities** — each agent token declares an explicit set
  of API capabilities; backend gates every endpoint on the required cap
- **Per-key role binding** — each token also carries an `agent_role`
  field set at issuance, used server-side to authoritatively name the
  actor for any audit / multi-actor protocol (war rooms etc.); never
  accepted from request body (closes WAR_ROOM_DESIGN.md S1)
- **Multiple keys per installation** — one Hive can have several tokens
  (`apiarist`, `worker`, `queen`, `dispatcher`, …) each with its own
  scope and rotation cycle
- **Per-service token selection** — apiary deploy script wires each
  agent service to the right token by name
- **No backward compatibility** — single client (in active development),
  no legacy fallback paths to maintain. Clean cutover.
- **Foundation for future API capabilities** — war room endpoints, task
  verifiers, monitoring tools all build on this scaffold

## Non-goals

- Capability hierarchies / inheritance (just a flat set per token)
- Per-capability rate limits (cap is allow/deny only — rate limiting
  stays a separate concern)
- Capability propagation / delegation (queen can't sub-mint scoped
  tokens for sub-tasks; if needed, that's a Phase J+ concern)

---

## Schema

`AgentTokenEnvelope` evolves with required fields:

```typescript
interface AgentTokenEnvelope {
  // — encryption envelope (existing) —
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
  tokenHash: string;
  fingerprint: string;
  createdAt: string;
  createdBy: string;          // admin token name that issued this one
  expiresAt: string | null;

  // — NEW: per-key identity (required) —
  name: string;               // operator-chosen, unique per (installationId, name)
  agent_role: string;         // e.g. "drone", "queen", "apiarist"; bound at issue,
                              // server-derived for any role-bearing API call
  capabilities: string[];     // REQUIRED, ≥1 entry, gates hivemoot.dev API.
                              // Top-level (NOT nested under policy) per the
                              // B.1.b implementation: required fields stay
                              // top-level; the optional V1.5+ policy container
                              // holds optional GitHub-narrowing fields.

  // — V1.5+/V1.6 GitHub-narrowing policy (optional container) —
  policy?: {
    allowed_repos?: string[];        // V1.5 — repo narrowing for installation-token mints
    allowed_permissions?: {          // V1.6 (Phase C) — GitHub permission narrowing
      contents?: "read" | "write";
      pull_requests?: "read" | "write";
      issues?: "read" | "write";
    };
  };
}
```

**Schema note** (closes guard R1 G2 on PR #503): an earlier draft of
this section nested `capabilities` inside `policy`. The shipping
shape above hoists it to the top level — `capabilities` is required,
and pulling it out of the optional `policy` container makes the type
narrower and the middleware import simpler (`envelope.capabilities`,
not `envelope.policy.capabilities`). The `policy` container retains
only the optional V1.5/V1.6 GitHub-narrowing fields.

**Strict-mode notes:**
- Envelopes loaded WITHOUT `name` → 401 with `code:
  TOKEN_LEGACY_UNSCOPED` (operator triage signal — distinct from
  generic `INVALID_BEARER`)
- Envelopes loaded WITHOUT `capabilities` (or empty) → 401 with same
  code
- Envelopes loaded WITHOUT `agent_role` → 401 with same code
- `name` uniqueness enforced per `(installationId, name)` via
  `withRedisLock` on `hive:v1:lock:agent-token:{installationId}:{name}`
  + Lua `SET NX` on the envelope key (closes guard F)
- `name` validated against regex `^[a-z][a-z0-9_-]{0,31}$` — lowercase
  ASCII, starts with a letter, ≤32 chars (closes guard D)
- `agent_role` validated against the same regex
- Capability strings validated against
  `^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$` — bare `*`, OR lowercase
  dot-separated identifier with an OPTIONAL `*` ONLY as the final
  segment. Closes builder R2.1 — the prior regex
  `^[a-z_]+(\.[a-z_*]+)+$` permitted shapes like `tasks.*claim` or
  `tasks.cl*aim` because `*` was allowed mid-segment

The `AgentTokenHashRecord` (reverse index) shape changes:

```typescript
interface AgentTokenHashRecord {
  installationId: string;
  name: string;        // NEW — needed by middleware to load the envelope by name
  // expiresAt removed — middleware now reads expiry from the envelope.
}
```

**Latency + bearer-resurrection** (closes guard R2 N5 + builder
R2 + builder R3 on PR #503): auth needs a hash-index read AND an
envelope read AND a check that the envelope's `tokenHash` matches
the presented bearer's SHA-256. The two reads are DEPENDENT —
the envelope key requires `{installationId, name}` returned by
the first read — so they CAN'T be batched via
`redis.pipeline()`; the second key constructor depends on the
first read's result.

(Earlier drafts of this section had a `redis.pipeline().get().get()`
pseudocode that builder R3 correctly identified as impossible.)

The shipped pattern is a single Lua EVAL — `RESOLVE_BEARER_SCRIPT`
— that does both reads + the bearer-resurrection check
server-side. One Redis round-trip, no JS-side ordering bug
possible. The script is in §Atomic operations below; the
TypeScript wrapper is `web/src/server/agent-token-v1.ts:
resolveBearerToEnvelope`. B.1.c middleware just consumes the
typed result.

**Why the `tokenHash` check is load-bearing.** The hash index is
intentionally NOT TTL'd (per the storage-table TTL column —
TTLing it risks dropping the index slightly before the envelope
under clock skew). So an explicit-expiry token whose envelope
gets swept by Redis leaves a stale hash record pointing at
`{installationId, name}`. If the operator subsequently issues a
NEW token with the SAME name (now permitted because
`pruneOrphanedIndexEntries` cleared the sorted-set entry), the
OLD bearer's hash → name → envelope path would resolve to the
NEW envelope's identity. The script's
`envelope.tokenHash != presentedHash → {-3, "stale_bearer"}`
branch is what closes this. Middleware translates `stale_bearer`
to 401 TOKEN_EXPIRED.

**Acceptance criterion for B.1.c**: a regression test demonstrates
"issue → TTL-sweep envelope → reissue same name → present old
bearer → middleware returns 401 TOKEN_EXPIRED (NOT auth success
under new envelope's identity)." B.1.b ships the storage-state
demonstration of the scenario in `agent-token-v1.test.ts`'s
"bearer-resurrection invariant" test + exercises the resolver
script's `stale_bearer` branch directly via
`resolveBearerToEnvelope` end-to-end.

### Storage layout (Redis)

Follows REDIS_KEY_CONVENTION.md. All keys versioned `v1:`.

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `hive:v1:agent-token:{installationId}:{name}` | string (JSON envelope) | None for `expiresAt: null` tokens; `expiresAt - now() + 300` (5-min safety margin to absorb Redis-vs-API clock skew — closes guard R2.1 G-R2.1-4) for tokens with explicit expiry. The auth middleware ALWAYS does its own `expiresAt`-from-envelope check; Redis TTL is the eventually-consistent sweep, not the user-visible gate. | Token core record |
| `hive:v1:idx:agent-token:hash:{tokenHash}` | string (JSON `{installationId, name}`) | None | Bearer → identity reverse index |
| `hive:v1:idx:agent-token:installation:{installationId}` | sorted set (token names, score = `createdAt` epoch ms) | None | Token list per installation; sort by creation order for stable `tokens list` output (closes hivemoot reviewer #5 issue 4) |
| `hive:v1:agent-token:{installationId}:{name}:meta` | hash | None | Mutable side-state (`lastUsedAt`, `callCount`) — see §`lastUsedAt` write strategy |
| `hive:v1:agent-token:{installationId}:audit` | stream | bounded by `MAXLEN ~N` (split by event class — see §Audit log for the math) | Rolling audit log; entries carry `fingerprint`, NEVER raw bearer |
| `hive:v1:lock:agent-token:{installationId}:{name}` | string (lock holder) | 30 s | Issue / revoke / set-capabilities serialization |

### Atomic operations (Lua)

Closes guard F (uniqueness mechanism), Queen #6 (set cleanup),
hivemoot reviewer #3 (revoke as 3+ key atomic op). Three scripts,
each with a documented return-shape contract per
REDIS_KEY_CONVENTION.md.

**`ISSUE_TOKEN_SCRIPT`** — atomic SET NX on the envelope key, plus
hash index + installation sorted-set add. Closes builder R2.1
sorted-set/`SADD` mismatch + guard R2 N1 (atomic limit) + builder
R2.2 (envelope TTL contract for `--expires-in` tokens).

```lua
-- R2 shipping shape (matches web/src/server/agent-token-v1.ts):
-- KEYS: [envelopeKey, hashIndexKey, installationSortedSetKey, auditStreamKey]
-- ARGV: [name, envelopeJson, hashRecordJson, createdAtMs,
--        tokenLimit, expirySecsOrZero, auditEntryJsonOrEmpty]
--   expirySecsOrZero: 0 = no TTL (expiresAt: null tokens);
--                     positive int = (expiresAt - now() + 300)
--                     where +300 is the clock-skew safety margin
--                     (closes guard R2.1 G-R2.1-4 + builder R2.2
--                     "TTL contract not implemented in script")
--   auditEntryJsonOrEmpty: pre-built audit entry JSON, or "" to
--                          skip the XADD. Atomic-audit guarantee
--                          per guard R1 G1 on PR #503: audit emit
--                          inside the same EVAL when non-empty.
--   installationId is encoded in the envelope KEY's prefix; the
--                  script never uses it directly (was in design's
--                  earlier 7-arg form; impl drops the redundant
--                  arg per guard R1 G8 on PR #503).
-- Returns:
--   {1, name}                success
--   {0, "name_taken"}        name already exists
--   {-1, "limit"}            installation already at tokenLimit names
local existing = redis.call("get", KEYS[1])
if existing then return {0, "name_taken"} end
local count = redis.call("zcard", KEYS[3])
if count >= tonumber(ARGV[5]) then return {-1, "limit"} end
if tonumber(ARGV[6]) > 0 then
  redis.call("set", KEYS[1], ARGV[2], "EX", tonumber(ARGV[6]))
else
  redis.call("set", KEYS[1], ARGV[2])
end
redis.call("set", KEYS[2], ARGV[3])
redis.call("zadd", KEYS[3], tonumber(ARGV[4]), ARGV[1])
if ARGV[7] ~= "" then
  redis.call("xadd", KEYS[4], "MAXLEN", "~", "10000", "*", "entry", ARGV[7])
end
return {1, ARGV[1]}
```

The hash index is intentionally NOT TTL'd at issue: middleware
verifies expiry from the envelope on every auth, so a "hash
exists, envelope expired" race resolves cleanly with the
envelope-side check. If we TTL'd the hash index too, a small
clock skew between Redis nodes could drop the index slightly
before the envelope and produce confusing "bearer not recognized"
errors instead of the cleaner `TOKEN_EXPIRED`.

The `0` return reuses the convention's "benign conflict" slot but
with a stable string discriminator (`"name_taken"`) so callers map
to 409 NAME_TAKEN unambiguously. The convention table's `{0, ...}`
description is updated correspondingly (closes guard R2.1
"convention drift" minor).

**`REVOKE_TOKEN_SCRIPT`** — atomic 4-key cleanup (envelope + reverse
index + installation sorted-set membership + meta). Closes hivemoot
reviewer #3 (3+ keys atomic) + builder R2.1 sorted-set parity.

```lua
-- R2 shipping shape:
-- KEYS: [envelopeKey, hashIndexKey, installationSortedSetKey, metaKey, auditStreamKey]
-- ARGV: [name, auditEntryJsonOrEmpty]
-- Returns:
--   {1, name}    success (envelope existed, all keys cleaned)
--   {0, name}    nothing to revoke (envelope already gone)
local existed = redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
redis.call("del", KEYS[4])
redis.call("zrem", KEYS[3], ARGV[1])
if ARGV[2] ~= "" then
  redis.call("xadd", KEYS[5], "MAXLEN", "~", "10000", "*", "entry", ARGV[2])
end
if existed == 0 then return {0, ARGV[1]} end
return {1, ARGV[1]}
```

The audit stream is intentionally NOT deleted on revoke — the audit
trail outlives the token. Stream entries trim themselves via
`XADD ... MAXLEN ~10000` so unbounded growth is bounded by config,
not by token lifetime.

**`SET_CAPABILITIES_SCRIPT`** — atomic mutation of the capabilities
field on the envelope, with audit emission.

```lua
-- R2 shipping shape:
-- KEYS: [envelopeKey, auditStreamKey]
-- ARGV: [newEnvelopeJson, expirySecsOrZero, auditEntryJsonOrEmpty]
-- Returns:
--   {1}                  success
--   {-1, "no_envelope"}  envelope missing (race with revoke; caller surfaces 404)
local existing = redis.call("get", KEYS[1])
if not existing then return {-1, "no_envelope"} end
if tonumber(ARGV[2]) > 0 then
  redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
else
  redis.call("set", KEYS[1], ARGV[1])
end
if ARGV[3] ~= "" then
  redis.call("xadd", KEYS[2], "MAXLEN", "~", "10000", "*", "entry", ARGV[3])
end
return {1}
```

**`RESOLVE_BEARER_SCRIPT`** — single-RTT bearer→envelope
resolution. Closes builder R3 on PR #503: the dependent reads
(envelope key needs `{installationId, name}` from the hash
record) can't be batched at the JS layer, so the read +
bearer-resurrection check happens in one Lua EVAL.

```lua
-- B.1.c shipping shape (matches web/src/server/agent-token-v1.ts):
-- KEYS: [hashIndexKey]
-- ARGV: [envelopeKeyPrefix, presentedHash]
--   envelopeKeyPrefix = "hive:v1:agent-token:" — passed as ARGV
--                       so the prefix lives in TS code (single
--                       source of truth) rather than Lua.
-- Returns:
--   {1, envelopeJson, installationId}
--                                  success — caller cjson.parses
--                                  envelope; installationId is
--                                  surfaced from the hash record
--                                  so the middleware can build
--                                  the meta-key (lastUsedAt
--                                  write) and return it on the
--                                  auth result without an extra
--                                  round-trip. The V1 envelope
--                                  schema does NOT carry
--                                  installationId; it lives only
--                                  in the storage key + the hash
--                                  record.
--   {-1, "unknown_bearer"}         hash index miss
--   {-2, "envelope_missing"}       hash record points at TTL-swept
--                                  or evicted envelope
--   {-3, "stale_bearer"}           bearer-resurrection scenario:
--                                  envelope.tokenHash differs from
--                                  presentedHash (same-name
--                                  reissue race; see
--                                  §"Latency + bearer-resurrection")
local hashRecord = redis.call("get", KEYS[1])
if not hashRecord then return {-1, "unknown_bearer"} end
local parsed = cjson.decode(hashRecord)
local envKey = ARGV[1] .. parsed.installationId .. ":" .. parsed.name
local envelope = redis.call("get", envKey)
if not envelope then return {-2, "envelope_missing"} end
local envParsed = cjson.decode(envelope)
if envParsed.tokenHash ~= ARGV[2] then return {-3, "stale_bearer"} end
return {1, envelope, parsed.installationId}
```

Middleware (B.1.c, see
`web/src/server/agent-token-v1-auth.ts`) wraps this via
`resolveBearerToEnvelope` and maps each failure code to its
HTTP response:

- `unknown_bearer` → 401 `agent_auth_v1_unknown_bearer`
  ("Invalid or unknown bearer"). Hash index miss = bearer was
  never issued OR was revoked (revoke DELs the hash index).
- `envelope_missing` → 401 `agent_auth_v1_token_expired`
  ("Token expired or superseded"). Hash record exists but envelope
  is gone. Most likely cause: Redis TTL swept the explicit-expiry
  envelope past the +300s skew margin (hash index intentionally
  NOT TTL'd to avoid clock-skew dropping it before the envelope).
  Closes guard R1 G2 + builder R1 #1 on PR #504 — earlier draft
  mapped this to `unknown_bearer`, which would tell a legitimate-
  but-expired caller their bearer was "never issued."
- `stale_bearer` → 401 `agent_auth_v1_token_expired`. Bearer-
  resurrection: envelope.tokenHash differs from presentedHash;
  the bearer's name was reissued under a new envelope.

On success, middleware applies the wall-clock `expiresAt` check
(envelope-side is the user-visible gate) and the per-endpoint
`requires` capability check via `bearerHasCapability`.

**`ROTATE_TOKEN_SCRIPT`** — atomically replaces the bearer for an
existing named token (closes hivemoot reviewer #5 issue 1: prior
revoke+issue path produced a downtime window because the bearer
became invalid for in-flight requests between the two ops).

```lua
-- R2 shipping shape:
-- KEYS: [envelopeKey, oldHashIndexKey, newHashIndexKey, auditStreamKey]
-- ARGV: [name, newEnvelopeJson, newHashRecordJson, expirySecsOrZero, auditEntryJsonOrEmpty]
-- Returns:
--   {1, name}              success
--   {-1, "no_envelope"}    name doesn't exist (race with revoke)
local existing = redis.call("get", KEYS[1])
if not existing then return {-1, "no_envelope"} end
redis.call("del", KEYS[2])                            -- old hash index
if tonumber(ARGV[4]) > 0 then
  redis.call("set", KEYS[1], ARGV[2], "EX", tonumber(ARGV[4]))
else
  redis.call("set", KEYS[1], ARGV[2])
end
redis.call("set", KEYS[3], ARGV[3])                   -- new hash index
if ARGV[5] ~= "" then
  redis.call("xadd", KEYS[4], "MAXLEN", "~", "10000", "*", "entry", ARGV[5])
end
return {1, ARGV[1]}
```

The new bearer is reachable via the new hash index immediately;
the old bearer's hash index is gone in the same atomic call. The
**Redis-atomicity** window is zero — but the **operationally-
visible** window is non-zero (closes guard R2.1 G-R2.1-1):
between `tokens rotate` returning the new bearer and the operator
finishing their `apiary.secrets.yaml` edit + redeploy, services on
the Hive still hold the old bearer (now invalid) and 401-storm
exactly like cutover.

V1 chose the staging-and-restart path explicitly. The runbook step
sequence:

1. `hivemoot tokens rotate --installation-id N --name worker` (new
   bearer printed once)
2. `apiary stop` on the Hive (services stop holding the old bearer)
3. Update `apiary.secrets.yaml` with the new bearer
4. `apiary start` (services pick up the new bearer)

V1.1 may add an "overlap window" path (a TTL'd second
`hive:v1:idx:agent-token:hash:{oldHash}` entry valid for N minutes
after rotation, so step 2-3 can happen without a downtime gap).
For V1, the explicit stop-and-start sequence is acceptable.

**Expiry preservation on rotate** (closes guard R2.1 G-R2.1-2 +
G-R2.2-2): `ROTATE_TOKEN_SCRIPT`'s `expirySecsOrZero` ARGV is
computed by the caller as `expiresAt - now() + 300` from the
**existing envelope's** `expiresAt` — same +300s clock-skew safety
margin ISSUE uses. Rotate does NOT reset the lifetime clock; both
issue and rotate produce envelopes whose Redis TTLs trail the
envelope's own `expiresAt` by 5 min so the auth middleware's
envelope-side check is always the user-visible gate. Operators
who want to extend lifetime must explicitly `tokens issue --name X
--expires-in 30d` to mint a successor with a fresh window, then
revoke the previous slot. "Rotate ≠ extend."

### Migration cleanup script (closes guard A)

The cap cutover replaces `hive:agent-token:{installationId}` (legacy)
with `hive:v1:agent-token:{installationId}:{name}` (new). Leftover
legacy keys would orphan forever otherwise. Cap-system PR ships a
one-shot Node script `web/scripts/cleanup-legacy-agent-tokens.ts`
that the operator runs once after the cutover deploy:

```bash
$ node dist/scripts/cleanup-legacy-agent-tokens.js
Found 1 legacy envelope: hive:agent-token:107212709 → DELETE
Found 3 legacy hash indexes: agent-token-hash:abcd…, … → DELETE
Cleaned up 4 keys.
```

The script's behavior is documented in the runbook and idempotent —
re-runs find nothing.

---

## Capability vocabulary

Dot-separated strings, grouped by subsystem. Wildcards (`tasks.*`,
`rooms.*`, `*`) supported at the policy level; expanded at request
time against a hardcoded TypeScript registry — see §Wildcard
expansion.

| Capability | Endpoint(s) gated | Notes |
|---|---|---|
| `installation_token.mint` | `POST /api/github/installation-tokens` | Apiarist's only required cap |
| `pull_requests.merge` | `POST /api/github/installation-tokens` | Allows a local_queen bearer to mint merge-capable GitHub tokens when paired with `installation_token.mint` and exact merge policy |
| `agent_health.report` | `POST /api/agent-health` | Workers, queen, anyone reporting |
| `agent_health.read` | `GET /api/agent-health/*` | Monitoring tools |
| `tasks.claim` | `POST /api/tasks/claim` | Worker side |
| `tasks.progress` | `POST /api/tasks/{id}/progress`, heartbeat | Worker side |
| `tasks.complete` | `POST /api/tasks/{id}/complete` | Worker side |
| `tasks.create` | `POST /api/tasks` (Bearer-auth path) | Bot/queen, dispatcher; coexists with cookie-auth path used by dashboard (see §`tasks.create` dual-auth) |
| `tasks.read` | `GET /api/tasks/{id}`, `GET /api/tasks` | Queen, monitoring |
| `tasks.cancel` | `POST /api/tasks/{id}/cancel` | Queen (admin) |
| `tasks.verify` | `POST /api/tasks/{id}/verify` (future) | Future task-verifier role |
| `rooms.watch` | `GET /api/rooms/watching` (Phase D) | Worker side |
| `rooms.read` | `GET /api/rooms/{id}`, `GET /api/rooms/{id}/events` | Worker (own role's rooms) + queen + monitoring |
| `rooms.read_all` | room list / monitoring endpoints | Installation-wide room read |
| `rooms.contribute` | `POST /api/rooms/{id}/{present,withdraw,contribute}` (Phase D) | Worker side |
| `rooms.create` | `POST /api/rooms` | Bot (queen module) |
| `rooms.update` | `POST /api/rooms/{id}/event` | Bot (queen module) |
| `rooms.decide` | `POST /api/rooms/{id}/decide`, `DELETE /api/rooms/{id}/claim` | Bot (queen module) |
| `rooms.close` | `POST /api/rooms/{id}/close` | Bot (queen module) |
| `rooms.synthesize` | local queen synthesis/merge endpoints | Local-mode queen synthesis and merge confirmation path |
| `rooms.force_close` | `POST /api/rooms/{id}/force-close`, `POST /api/rooms/{id}/replay` | Admin |
| `fleet.read` | `GET /api/fleet/desired-state` | Reconciler / monitoring — reads the installation's agent roster + config. Never auto-granted to an agent |
| `agent_tokens.manage` | `POST /api/agent-tokens`, `DELETE /api/agent-tokens/{name}`, `POST /api/agent-tokens/{name}/set-capabilities`, etc. | Token-management endpoints — see §Per-installation admin protection |
| `*` | All capabilities (admin tokens only) | NOT included by `agent_tokens.manage` unless explicit (see §Wildcard) |

**Total: 23 capabilities** + `*` wildcard. Recount includes
`rooms.read_all`, `rooms.synthesize`, `pull_requests.merge`, and `fleet.read`.

### `tasks.create` dual-auth

`POST /api/tasks` today uses `authenticateByokRequest` (cookie
session, dashboard operator). Bearer-token callers (bot/queen,
dispatcher) need a second auth path on the same endpoint. PR 1
ships dual auth: try cookie first; fall back to Bearer with
`requires: "tasks.create"`. Closes hivemoot reviewer #3 issue 2.

### `authenticateTaskExecutorRequest` keeps its lighter path

`task-executor-auth.ts` is a hot-path auth used by task progress
heartbeats. Capability check inlines into that function (one extra
hash-record field check) rather than routing through the full
middleware. Function signature: same as today, plus a `requires`
parameter. The hash record now carries `name`, so the envelope
load to read capabilities adds one Redis call per auth (acceptable
at task-heartbeat cadence). Closes hivemoot reviewer #4 issue 2.

### Wildcard expansion

Closes guard E + Queen R1 #4 + hivemoot reviewer #2 issue.

Wildcards expand at request time against a single TypeScript `const`:

```typescript
// web/src/server/agent-token-capabilities.ts
export const KNOWN_CAPABILITIES = [
  "installation_token.mint",
  "pull_requests.merge",
  "agent_health.report",
  "agent_health.read",
  "tasks.claim",
  "tasks.progress",
  "tasks.complete",
  "tasks.create",
  "tasks.read",
  "tasks.cancel",
  "tasks.verify",
  "rooms.watch",
  "rooms.read",
  "rooms.read_all",
  "rooms.contribute",
  "rooms.create",
  "rooms.update",
  "rooms.decide",
  "rooms.close",
  "rooms.synthesize",
  "rooms.force_close",
  "agent_tokens.manage",
] as const;

// Capabilities that must be listed explicitly. Even prefix wildcards
// never reach these, so `agent_tokens.*` does not grant token
// management and `pull_requests.*` does not grant merge execution.
const ADMIN_CLASS_CAPABILITIES = new Set<string>([
  "agent_tokens.manage",
  "pull_requests.merge",
]);

export function expandWildcards(capabilities: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of capabilities) {
    if (c === "*") {
      // Bare wildcard — operator must opt in via tokens issue
      // --allow-wildcards. Excludes admin-class caps; operator must
      // list those explicitly.
      for (const k of KNOWN_CAPABILITIES) {
        if (!ADMIN_CLASS_CAPABILITIES.has(k)) out.add(k);
      }
      continue;
    }
    if (c.endsWith(".*")) {
      const prefix = c.slice(0, -2);  // "tasks.*" → "tasks"
      for (const k of KNOWN_CAPABILITIES) {
        if (k.startsWith(prefix + ".") && !ADMIN_CLASS_CAPABILITIES.has(k)) {
          out.add(k);
        }
      }
      continue;
    }
    out.add(c);
  }
  return out;
}
```

This file is the single source of truth — middleware, presets, and
`/api/whoami` all import from here. Adding a new capability is a
PR-touching-this-file change. The CHANGELOG entry for that PR MUST
call out wildcard implication ("now grants `X` to existing
`tasks.*` holders").

**Bare `*`**: must be opted into at issue time via `--allow-wildcards`
flag on `tokens issue`. CLI default rejects bare `*`. Excludes
`agent_tokens.manage` or `pull_requests.merge` unless explicitly
added. Closes guard issue "`*` includes token management" trap and
keeps merge execution from appearing on old wildcard tokens.

**Capability count surfacing**: the dashboard (Phase I) shows a
"this token can call:" list expanded against current
`KNOWN_CAPABILITIES` so silent-grant-on-new-cap is visible per-token
at review time.

---

## Presets

Hardcoded named bundles for common roles. Used via `--preset <name>`
in the issue CLI. Operators always free to bypass with explicit
`--capabilities <list>`.

| Preset | Capabilities | Notes |
|---|---|---|
| `apiarist` | `installation_token.mint` | Host-side daemon. Single cap. Used by the apiarist UDS path; never put in a container. |
| `worker` | `agent_health.report`, `tasks.claim`, `tasks.progress`, `tasks.complete`, `rooms.watch`, `rooms.read`, `rooms.contribute` | Containers (drone, builder, guard, etc.). **Does NOT include `installation_token.mint`** — workers always go through apiarist (closes hivemoot reviewer #3 issue 1). |
| `queen` | worker − `tasks.claim`/`tasks.progress`/`tasks.complete` + `tasks.create`, `tasks.read`, `tasks.cancel`, `rooms.create`, `rooms.read`, `rooms.update`, `rooms.decide`, `rooms.close` | Bot's room-management token (bot-as-queen — see WAR_ROOM_DESIGN.md §V1 architecture decision). |
| `local_queen` | `queen` + `rooms.synthesize`, `installation_token.mint`, `pull_requests.merge` | Local hive queen; requires explicit repo and merge-permission policy |
| `dispatcher` | `tasks.create`, `tasks.read` | Dashboard or external task creator |
| `monitoring` | `agent_health.read`, `tasks.read`, `rooms.read` | Read-only operator |
| `admin` | `*` + `agent_tokens.manage` (explicit, opted-in) | Admin tokens; see §Per-installation admin protection |

Presets are part of the codebase (TypeScript `const` map, same file
as `KNOWN_CAPABILITIES`). Adding a new capability to a preset is a
code change reviewed via PR. Existing tokens don't auto-update —
operators reissue or `set-capabilities --add`/`--remove`/`--preset`.

`set-capabilities --preset worker` is **deliberately a snap to the
*current* preset definition**, not "snap to preset at time of issue."
This is documented in the CLI help text (closes guard's "set-
capabilities preset semantics" question).

---

## API enforcement

Backend middleware sits in front of every protected route. Each route
declares its required capability via a thin wrapper around the existing
`authenticateAgentRequest`:

```typescript
export async function POST(request: NextRequest) {
  const auth = await authenticateAgentRequest(request, {
    requires: "rooms.create",
  });
  if (!auth.ok) return auth.response;
  // … handler logic, with auth.installationId, auth.name,
  // auth.agentRole, auth.capabilities, auth.policy in scope
}
```

`authenticateAgentRequest` (extended from existing) does the bearer
lookup AND the capability check in one call. Missing capability →
403 with structured body:

```json
{
  "code": "MISSING_CAPABILITY",
  "required": "rooms.create",
  "granted": ["installation_token.mint", "agent_health.report"],
  "message": "Token 'apiarist' on installation 12345 cannot create war rooms — needed capability: rooms.create"
}
```

Legacy unscoped tokens → 401 with:

```json
{
  "code": "TOKEN_LEGACY_UNSCOPED",
  "message": "Token envelope missing required fields (name, capabilities, agent_role). Reissue with `hivemoot tokens issue`."
}
```

(closes guard "strict-mode error code" minor.)

### Call-site refactor scope (closes Queen R1 #2)

`resolveTokenToInstallation` returns `{ installationId, expiresAt }`
today. The new shape returns `{ installationId, name, agentRole,
capabilities, policy, expiresAt }`. Affected call sites:

- `web/src/server/agent-health-auth.ts`
- `web/src/server/task-executor-auth.ts`
- `web/src/app/api/github/installation-tokens/route.ts`
- (any future route adopting bearer auth)

PR 1 enumerates and updates each. The capability check is added at
each call site or via the wrapper above; no call site is silently
left without a `requires` declaration (a lint rule enforces this on
new auth-using routes).

### `withInstallationLock` scope (closes hivemoot reviewer #3 issue 3)

Today's `withInstallationLock` serializes per-installation. The new
issue/revoke/set-capabilities path uses
`withRedisLock("hive:v1:lock:agent-token:{installationId}:{name}")`
— per-`(installationId, name)`. The Lua scripts above use `SET NX`
inside, so the lock is defense-in-depth, not the primary uniqueness
mechanism.

### `lastUsedAt` write strategy (closes Queen R1 #5, guard G,
hivemoot reviewer #2 issue 4, hivemoot reviewer #4 issue 3)

`lastUsedAt` is updated by middleware on successful auth — but
**not synchronously, not on every call, not on `/api/whoami`**.
The strategy:

1. **Separate key**: stored at
   `hive:v1:agent-token:{installationId}:{name}:meta` field
   `lastUsedAt`. Envelope is read-only on the auth hot path.
2. **Debounced**: middleware reads the existing `lastUsedAt`; if it
   is within 60 s of now, skip the write. Otherwise update.
3. **Fire-and-forget**: middleware returns the auth result before
   the meta write completes. A failed meta write is logged but does
   not fail the request.
4. **Skipped for `/api/whoami`**: the read-only introspection
   endpoint never updates `lastUsedAt` (closes hivemoot reviewer
   #2 issue 4 directly).
5. **Skipped for the hot task-heartbeat path**: heartbeats are too
   frequent to be a useful "last used" signal anyway. The path uses
   `authenticateTaskExecutorRequest` which opts out of meta writes.

Per-token granularity (Q5 in original open questions). Per-capability
granularity is deferred to V1.1 if operators ask for it.

### `/api/whoami` introspection endpoint

```
GET /api/whoami
Authorization: Bearer hmt_xxx

→ {
    "name": "worker",
    "agent_role": "drone",
    "installationId": "107212709",
    "fingerprint": "1a2b3c4d",
    "capabilities": ["agent_health.report", "tasks.claim", ...],
    "policy": {
      "allowedRepos": ["hivemoot/hivemoot"],
      "allowedPermissions": {"contents": "read"}
    },
    "expiresAt": null,
    "lastUsedAt": "2026-04-26T18:00:00Z"
  }
```

**`/whoami` is a snapshot for debugging — enforcement is the
middleware check on the protected route** (closes guard I).
Capabilities are mutable server-side; agents MUST NOT cache
`/whoami` and skip the per-call middleware result. The agent
runtime startup logs this with a "snapshot at startup" qualifier
to make the trap visible to operators.

### Graceful revocation (closes guard J)

V1 behavior: **hard stop**. Revoke deletes the hash index immediately;
in-flight calls 401 on next read. The current task fails / orphans;
queen handles via the existing task watchdog. Documented in the
operator runbook (`apiarist/README.md`'s revoke section will reference
this).

V1.1 may add a 5-minute grace window if hard-stop produces visibly
bad task UX. Tracked as a follow-up open question, not blocking V1.

---

## Capability × `allowed_repos` × `allowed_permissions` interactions
(closes hivemoot reviewer #5 issue 3)

The three policy dimensions are intentionally independent:

- **`capabilities`** — gates which hivemoot.dev API endpoints the
  bearer can call (e.g., `installation_token.mint`, `tasks.claim`).
- **`allowed_repos`** — narrows the GitHub installation token's
  repository scope when minted via `installation_token.mint`.
- **`allowed_permissions`** — narrows the GitHub installation
  token's permission scope (Phase C, V1.6).

A request must pass ALL THREE checks where applicable. The
combinations that produce confusing operator errors (and how the
system surfaces them):

| Token shape | API behavior | Operator signal |
|---|---|---|
| `capabilities: ["installation_token.mint"]`, `allowed_repos: []` | 200 with empty-scope token (useless) | CLI `tokens issue` warns at issue time when `installation_token.mint` is granted with empty `allowed_repos`: *"Warning: token can mint but has no allowed_repos — minted GitHub tokens will have zero-repo scope. Set --allowed-repos or skip this cap."* |
| `capabilities: ["tasks.claim"]`, `allowed_repos: []` | Claim succeeds; downstream `gh` calls fail when the worker tries to operate on a repo | Documented; operator runbook explains "claimed tasks fail at GitHub-call time when allowed_repos is empty." |
| `capabilities: []` at **issue time** | 422 `EMPTY_CAPABILITIES` from `tokens issue` (validation rejects empty list at write time) | n/a — never reaches storage |
| Legacy envelope (no `capabilities` field) loaded from Redis at **auth time** | 401 `TOKEN_LEGACY_UNSCOPED` returned by middleware (envelope shape predates V1) | Operator must reissue via `tokens issue` (closes guard R2.1 G-R2.1-3 — the prior single row collapsed two distinct scenarios at two different times) |
| `capabilities: ["installation_token.mint"]`, `allowed_permissions: { contents: "read" }` (Phase C) | Minted token can read but not write | Worker correctly fails with GitHub 403 if it tries to push; `/api/whoami` shows the limited permission set explicitly |

**Validation at `tokens issue`**: the CLI flags clearly suspicious
combinations (capability granted with no resource scope to use it
on) but does NOT block — operators sometimes WANT a deliberately-
stub-scoped token (e.g., for audit/canary). Hard rejections only on
empty `capabilities` (401-on-load) and on `--capabilities` strings
that fail the regex.

The point of independence: capability narrows API access;
`allowed_repos`/`allowed_permissions` narrow GitHub access. Both
need to be set deliberately. Folding them together (e.g., implicit
"if you have `tasks.claim`, you must have at least 1 repo") would
make the system harder to audit, not easier.

---

## CLI surface (`hivemoot tokens`)

```bash
# Issue
hivemoot tokens issue --installation-id 12345 --name worker \
                       --preset worker --agent-role drone
hivemoot tokens issue --installation-id 12345 --name custom \
                       --capabilities tasks.claim,rooms.contribute \
                       --agent-role custom-role
hivemoot tokens issue --installation-id 12345 --name pilot \
                       --preset worker --agent-role drone --expires-in 30d
hivemoot tokens issue --installation-id 12345 --name super \
                       --capabilities '*,agent_tokens.manage' \
                       --allow-wildcards --agent-role admin

# `--agent-role` is REQUIRED on issue. Default presets carry a
# suggested agent_role (apiarist→apiarist, worker→worker etc.) but
# the operator must explicitly confirm via the flag — there is no
# implicit default.

# Issue prints the bearer ONCE to stdout (or --output FILE);
# not retrievable later. (GET /api/agent-token/{id} that previously
# returned the plaintext via BYOK decryption is REMOVED — closes
# guard "GET-after-issue contract change" minor.)

# Inspect
hivemoot tokens list --installation-id 12345
hivemoot tokens show --installation-id 12345 --name worker

# Modify (--add, --remove, --preset all supported; --remove closes
# hivemoot reviewer #2 issue 2)
hivemoot tokens set-capabilities --installation-id 12345 --name worker \
                                  --add rooms.read
hivemoot tokens set-capabilities --installation-id 12345 --name worker \
                                  --remove tasks.cancel
hivemoot tokens set-capabilities --installation-id 12345 --name worker \
                                  --preset worker
hivemoot tokens set-policy --installation-id 12345 --name worker \
                            --allowed-repos hivemoot/hivemoot,hivemoot/colony

# Rotate (atomic — keeps the same name + capabilities, just swaps
# the bearer; Redis-atomic but operationally requires stop-and-restart
# — see §Atomic operations / ROTATE_TOKEN_SCRIPT for the runbook)
hivemoot tokens rotate --installation-id 12345 --name worker

# Revoke
hivemoot tokens revoke --installation-id 12345 --name pilot
```

All commands support `--json` for machine-readable output.

The CLI authenticates against hivemoot.dev using a special **admin
token** — see §Per-installation admin protection / Bootstrap path.

### Token count limit (closes hivemoot reviewer #2 issue 1)

Hard limit of **20 named tokens per installation**. `tokens issue`
returns 422 `TOO_MANY_TOKENS` if at limit. Limit is configurable in
backend env (`AGENT_TOKEN_LIMIT_PER_INSTALLATION`) but ships at 20.
Prevents `hive:v1:idx:agent-token:installation:*` set growth and
sets a sane upper bound on `hivemoot tokens list` output.

### Per-installation admin protection (closes guard B + C)

Token-management endpoints (`POST /api/agent-tokens`, `DELETE
/api/agent-tokens/{name}`, etc.) require the `agent_tokens.manage`
capability. This capability is gated by the `AgentTokenEnvelope`
middleware just like any other.

### Bootstrap path (closes guard B — blocking)

The very first admin token is issued by the **dashboard** (cookie
auth, no bearer needed): a new dashboard page
`/dashboard/installation/tokens` — protected by the existing
`authenticateByokRequest` (logged-in installation admin) — calls a
backend route `POST /api/agent-tokens/bootstrap` that issues an
admin-preset token. The plaintext is shown ONCE in the dashboard
UI for the operator to copy.

After bootstrap, all subsequent CLI operations use that admin
token's bearer. Revoking the bootstrap admin token without first
issuing a replacement will lock the operator out — the dashboard
bootstrap page remains as the recovery path (cookie auth always
works for the installation owner).

**Bootstrap admin token defaults to `expiresAt: now + 24h`**
(closes guard R2 N4). The one-time-display + paste flow gives
ample window for any browser-extension or screen-recording surface
to capture the bearer; persisting that exposure indefinitely is
too much trust for a one-shot UI flow. Operators MUST issue a
successor admin token (`tokens issue --preset admin --expires-in
30d` or however long they want, deliberately confirmed) within
the 24h window. If they miss it, re-bootstrap via the dashboard —
the cookie-auth path always works for the installation owner.

The CLI's `tokens issue --preset admin` requires
`agent_tokens.manage` capability on the bearer — which only the
bootstrap-issued admin (or another admin issued from it) carries.

---

## Apiary deploy integration

`apiary.yaml` schema gains `agent_token_name` per service:

```yaml
repos:
  hivemoot:
    repo: hivemoot/hivemoot
    refresh_token: true
    overrides:
      drone:
        agent_token_name: worker
      builder:
        agent_token_name: worker
      guard:
        agent_token_name: worker
```

`apiary.secrets.yaml`:

```yaml
agent_tokens:
  apiarist: hmt_aaa…   # used by host-side apiarist daemon (mint-only)
  worker:   hmt_bbb…   # used by drone/builder/guard containers
  # No "queen" token in apiary.secrets.yaml — the bot's queen module
  # holds its own token in Vercel env (see WAR_ROOM_DESIGN.md
  # §Bot queen module behavior).
```

Deploy script per service:
1. Resolve `agent_token_name` (default `worker` if unset)
2. Look up token value in `apiary.secrets.yaml.agent_tokens.{name}`
3. Stage to per-service secrets dir at the existing 0600/0640 file
   modes (no new hardening pass needed — closes guard's
   `apiary.secrets.yaml` file-mode minor)

The apiarist daemon on the host loads the `apiarist` token (only
`installation_token.mint` capability — narrowest scope, smallest
blast radius if leaked).

---

## Cutover plan (no backward compat — with rollback)

Single deploy approach since there's exactly one client (the Hive),
in active development. Re-ordered from R1 to **bring services down
before the backend deploy**, eliminating the 5-10 minute 401 storm
window (closes guard H + Queen R1 #3).

### PR 1 — Backend + CLI

- Schema enforcement (envelope must have `name`, `agent_role`,
  `capabilities` ≥1)
- `/api/whoami` endpoint
- `KNOWN_CAPABILITIES` registry + capability middleware
- New CLI subgroup: `hivemoot tokens
  issue/list/show/set-capabilities/set-policy/revoke`
- Bootstrap dashboard route `POST /api/agent-tokens/bootstrap`
- Migration cleanup script `web/scripts/cleanup-legacy-agent-tokens.ts`
- Tests: happy path, missing capability 403, wildcard expansion,
  preset application, name uniqueness conflict, agent_role binding,
  legacy envelope rejection

### PR 2 — Apiary deploy script

- Read `agent_token_name` per service from `apiary.yaml` overrides
- Look up `agent_tokens.{name}` from `apiary.secrets.yaml`
- Per-service token staging
- Reject `war_room: true` on a service whose token doesn't carry
  `allowed_permissions` (Phase C dependency — see WAR_ROOM_DESIGN.md
  §16)

### Hive cutover (operator action — re-ordered)

```bash
# 1. Stop services on the Hive (no 401 storm)
ssh agent@hive 'cd /opt/apiary && sudo ./deploy-apiary.sh --stop'

# 2. Deploy backend (PR 1 ships strict-mode envelope check)
#    (Vercel deploy)

# 3. Bootstrap admin token via dashboard (one-time, cookie auth)
#    Open https://www.hivemoot.dev/dashboard/installation/tokens
#    Click "Bootstrap admin token" → copy the bearer

# 4. Issue per-purpose tokens
hivemoot tokens issue --installation-id 107212709 --name apiarist \
                       --preset apiarist --agent-role apiarist
hivemoot tokens issue --installation-id 107212709 --name worker \
                       --preset worker --agent-role worker

# 5. Update apiary.secrets.yaml with the new bearer values
#    (manual edit, replace single health_token with agent_tokens map)

# 6. Optional: update apiary.yaml with per-service overrides if not
#    using the default "worker" name

# 7. Redeploy services
ssh agent@hive 'cd /opt/apiary && sudo ./deploy-apiary.sh'

# 8. Verify
hivemoot tokens list --installation-id 107212709    # tokens visible
ssh agent@hive 'sudo journalctl -u hivemoot-* --since 1m | grep -i auth'
                                                     # no 401s

# 9. Run cleanup script for legacy keys
node /opt/hivemoot/web/dist/scripts/cleanup-legacy-agent-tokens.js
```

### Rollback (closes Queen R1 #3)

If PR 1 misbehaves after deploy and the new tokens turn out broken:

1. Restore the prior backend deploy from Vercel (one-click in
   dashboard).
2. The old envelope at `hive:agent-token:{installationId}` still
   exists (PR 1 doesn't delete it — only the cleanup script in step
   9 above does, and that only runs after operator confirms
   success).
3. Restore `apiary.secrets.yaml` `health_token` from version control
   (operator MUST commit it before cutover).
4. Restart services.

The two-step (PR 1 deploy → operator runs cleanup script) is what
makes rollback possible. Operators are reminded in the runbook to
**not run the cleanup script until at least 1 hour of clean
operation**.

### Post-cutover cleanup

After cutover succeeds, the cleanup script removes legacy
`hive:agent-token:*` and `agent-token-hash:*` entries. The
`health_token` field can be removed from `apiary.secrets.yaml` (no
longer read).

---

## Backward compatibility — explicitly NONE

This design intentionally ships strict-mode from day one. Reasons:

- One client (the Hive) in active development; no third-party
  integrations to coordinate with
- Backward-compat fallback paths add code complexity for zero
  shipping benefit
- Operational disruption window is small + planned (and now
  zero-401-storm thanks to stop-first re-ordering)

Cost: existing token gets invalidated by the PR 1 deploy + operator
cutover. Mitigation: rollback path documented above; cleanup is
deferred to operator-run script.

---

## Audit log (closes guard "audit log location" minor + Queen R1 audit)

Per `hive:v1:agent-token:{installationId}:audit` Redis stream.

Per-entry shape (JSON inside `XADD`):

```json
{
  "ts": "2026-04-26T18:00:00Z",
  "fingerprint": "1a2b3c4d",          // first 8 chars of tokenHash; never raw bearer
  "name": "worker",
  "action": "auth.success",            // or auth.failure / issue / revoke / set_capabilities
  "endpoint": "POST /api/tasks/claim",
  "required_capability": "tasks.claim",
  "outcome": "ok",
  "client_ip": "192.168.50.202"
}
```

Streams are split by event class (closes guard R2 N2 — single
`MAXLEN ~10000` claimed 30-day retention but at task-heartbeat
volume actually held only minutes-to-hours):

| Stream | Event classes | `MAXLEN ~N` | Realistic retention |
|---|---|---|---|
| `hive:v1:agent-token:{installationId}:audit` | mutations only — `issue`, `revoke`, `set_capabilities`, `rotate`, `bootstrap` | 10000 | Effectively unbounded for V1 — operator mutations are infrequent (~10/day max). |
| `hive:v1:agent-token:{installationId}:auth` | `auth.success`, `auth.failure` | 100000 | Hours-to-days at single-Hive load. Higher trim budget because volume is higher; the audit-trail signal lives in the mutations stream above. |

The split prevents the high-frequency auth events from displacing
the low-frequency mutation events that operators actually care
about (who issued, who revoked, when capabilities changed). At
V1.1, the auth stream may export to Vercel Analytics for longer
retention; mutations stay in Redis indefinitely (unbounded MAXLEN
acceptable at <1000 entries/year/installation).

The audit-emission helper `auditAppend(installationId, eventClass,
entry)` is the only call site; no path can omit `MAXLEN ~N` (closes
guard R2 minor "Audit XADD MAXLEN consistency").

---

## Open design questions

These need a decision before PR 1 lands. R2 deltas marked **CHANGED**.

1. **Token naming — free-form vs. enum?**
   Free-form with regex `^[a-z][a-z0-9_-]{0,31}$` (closes guard D's
   "validation undefined"). CLI warns on names not matching known
   preset roster.

2. **Wildcards — keep or drop?**
   Keep. Required `--allow-wildcards` flag for bare `*`. Hardcoded
   `KNOWN_CAPABILITIES` registry as the expansion source of truth
   (closes guard E + Queen #4).

3. **Token expiry default?**
   NULL = no expiry for V1.

4. **CLI namespace — `hivemoot tokens` or `hivemoot agent-tokens`?**
   `hivemoot tokens`.

5. **`lastUsedAt` granularity — per-token or per-(token, capability)?**
   Per-token V1, see §`lastUsedAt` write strategy. Per-capability
   in V1.1 if operators ask.

6. **Capability deny-lists?**
   Skip. Drop wildcards and list explicitly if needed.

7. **Audit log retention?**
   Two streams, each per-installation, each with its own
   `MAXLEN ~N` budget (see §Audit log for the math): the
   `:audit` stream (mutations only) is effectively unbounded
   at <10/day, the `:auth` stream (auth.success / auth.failure)
   covers hours-to-days at single-Hive load. Closes guard R2 N2
   "30-day retention claim was actually minutes-to-hours at
   task-heartbeat volume." V1.1 may export `:auth` to Vercel
   Analytics for longer retention.

8. **CHANGED — Token count limit per installation?**
   20 hard cap (closes hivemoot reviewer #2 issue 1). Configurable
   via env.

9. **CHANGED — `set-capabilities --remove` symmetry?**
   Ship `--remove` alongside `--add` and `--preset` (closes
   hivemoot reviewer #2 issue 2).

10. **CHANGED — Graceful revoke window?**
    V1 hard stop, V1.1 may add 5-min grace if needed (closes
    guard J).

---

## What this unlocks

- **War rooms (Phase D)** declare `rooms.create` / `rooms.contribute`
  / etc. capabilities at endpoint definition time — no retrofit. Bot
  becomes the war-room queen via the `queen` preset (see
  WAR_ROOM_DESIGN.md §V1 architecture decision).
- **Future task evolution** (verifier role) gets the capability
  scaffold for free.
- **Per-service token rotation** becomes a routine operation
  (`hivemoot tokens revoke worker` then re-issue).
- **Per-service blast radius is bounded** — leaked `worker` token
  can't create war rooms, can't mint installation tokens (workers
  go through apiarist, not the API directly), and can't write
  outside its `allowed_repos`.
- **Operational clarity** — token names tell you what they're for;
  `lastUsedAt` flags unused tokens for cleanup; audit stream gives
  per-bearer call history with fingerprint correlation.
- **Server-derived role for multi-actor protocols** — war rooms,
  task verifiers, future incident-response coordination all read
  the actor identity from the bound `agent_role` field, not from
  client-supplied request bodies. The S1 class of role-spoofing
  bugs is structurally impossible.
