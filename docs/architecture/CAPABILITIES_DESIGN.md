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

  // — policy (gains capabilities; existing fields stay) —
  policy: {
    allowed_repos?: string[];        // V1.5 — repo narrowing for installation-token mints
    allowed_permissions?: {          // V1.6 (Phase C) — GitHub permission narrowing
      contents?: "read" | "write";
      pull_requests?: "read" | "write";
      issues?: "read" | "write";
    };
    capabilities: string[];          // NEW — required, ≥1 entry, gates hivemoot.dev API
  };
}
```

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
  `^[a-z_]+(\.[a-z_*]+)+$` — lowercase ASCII, dot-separated, optional
  `*` only as a trailing segment

The `AgentTokenHashRecord` (reverse index) shape changes:

```typescript
interface AgentTokenHashRecord {
  installationId: string;
  name: string;        // NEW — needed by middleware to load the envelope by name
  // expiresAt removed — middleware now reads expiry from the envelope (one
  // extra Redis read per auth, marginal cost; keeps the truth in one place)
}
```

### Storage layout (Redis)

Follows REDIS_KEY_CONVENTION.md. All keys versioned `v1:`.

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `hive:v1:agent-token:{installationId}:{name}` | string (JSON envelope) | None for `expiresAt: null` tokens; `expiresAt - now()` Redis TTL for tokens with explicit expiry (closes hivemoot reviewer #5 issue 2) | Token core record |
| `hive:v1:idx:agent-token:hash:{tokenHash}` | string (JSON `{installationId, name}`) | None | Bearer → identity reverse index |
| `hive:v1:idx:agent-token:installation:{installationId}` | sorted set (token names, score = `createdAt` epoch ms) | None | Token list per installation; sort by creation order for stable `tokens list` output (closes hivemoot reviewer #5 issue 4) |
| `hive:v1:agent-token:{installationId}:{name}:meta` | hash | None | Mutable side-state (`lastUsedAt`, `callCount`) — see §`lastUsedAt` write strategy |
| `hive:v1:agent-token:{installationId}:audit` | stream | 30 days (per-entry trim) | Rolling audit log; entries carry `fingerprint`, NEVER raw bearer |
| `hive:v1:lock:agent-token:{installationId}:{name}` | string (lock holder) | 30 s | Issue / revoke / set-capabilities serialization |

### Atomic operations (Lua)

Closes guard F (uniqueness mechanism), Queen #6 (set cleanup),
hivemoot reviewer #3 (revoke as 3+ key atomic op). Three scripts,
each with a documented return-shape contract per
REDIS_KEY_CONVENTION.md.

**`ISSUE_TOKEN_SCRIPT`** — atomic SET NX on the envelope key, plus
hash index + installation set cleanup if the name was previously
revoked-then-reissued.

```lua
-- KEYS: [envelopeKey, hashIndexKey, installationSetKey]
-- ARGV: [installationId, name, envelopeJson, hashRecordJson]
-- Returns:
--   {1, name}    success
--   {0, name}    name already exists (callers map to 409 NAME_TAKEN)
local existing = redis.call("get", KEYS[1])
if existing then return {0, ARGV[2]} end
redis.call("set", KEYS[1], ARGV[3])
redis.call("set", KEYS[2], ARGV[4])
redis.call("sadd", KEYS[3], ARGV[2])
return {1, ARGV[2]}
```

**`REVOKE_TOKEN_SCRIPT`** — atomic 3-key cleanup (envelope + reverse
index + installation set membership). Closes hivemoot reviewer #3.

```lua
-- KEYS: [envelopeKey, hashIndexKey, installationSetKey, metaKey]
-- ARGV: [name]
-- Returns:
--   {1, name}    success
--   {0, name}    nothing to revoke (already gone)
local existed = redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
redis.call("del", KEYS[4])
redis.call("srem", KEYS[3], ARGV[1])
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
-- KEYS: [envelopeKey, auditStreamKey]
-- ARGV: [newEnvelopeJson, auditEntryJson, expirySecsOrZero]
-- Returns:
--   {1}          success
--   {-1}         envelope missing (race with revoke; caller surfaces 404)
local existing = redis.call("get", KEYS[1])
if not existing then return {-1} end
if tonumber(ARGV[3]) > 0 then
  redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[3]))
else
  redis.call("set", KEYS[1], ARGV[1])
end
redis.call("xadd", KEYS[2], "MAXLEN", "~", "10000", "*",
                   "entry", ARGV[2])
return {1}
```

**`ROTATE_TOKEN_SCRIPT`** — atomically replaces the bearer for an
existing named token (closes hivemoot reviewer #5 issue 1: prior
revoke+issue path produced a downtime window because the bearer
became invalid for in-flight requests between the two ops).

```lua
-- KEYS: [envelopeKey, oldHashIndexKey, newHashIndexKey, auditStreamKey]
-- ARGV: [newEnvelopeJson, newHashRecordJson, auditEntryJson, expirySecsOrZero]
-- Returns:
--   {1}                success
--   {-1, "no_envelope"}    name doesn't exist (race with revoke)
local existing = redis.call("get", KEYS[1])
if not existing then return {-1, "no_envelope"} end
redis.call("del", KEYS[2])                            -- old hash index
if tonumber(ARGV[4]) > 0 then
  redis.call("set", KEYS[1], ARGV[1], "EX", tonumber(ARGV[4]))
else
  redis.call("set", KEYS[1], ARGV[1])
end
redis.call("set", KEYS[3], ARGV[2])                   -- new hash index
redis.call("xadd", KEYS[4], "MAXLEN", "~", "10000", "*",
                   "entry", ARGV[3])
return {1}
```

The new bearer is reachable via the new hash index immediately;
the old bearer's hash index is gone in the same atomic call. Total
"invalid bearer" window: zero. The CLI command for this is
`hivemoot tokens rotate --installation-id N --name worker` —
operators rotating fleet credentials get atomic semantics matching
the existing `agent-token.ts:ROTATE_TOKEN_SCRIPT` pattern.

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
| `rooms.contribute` | `POST /api/rooms/{id}/{present,withdraw,contribute}` (Phase D) | Worker side |
| `rooms.create` | `POST /api/rooms` | Bot (queen module) |
| `rooms.update` | `POST /api/rooms/{id}/event` | Bot (queen module) |
| `rooms.decide` | `POST /api/rooms/{id}/decide`, `DELETE /api/rooms/{id}/claim` | Bot (queen module) |
| `rooms.close` | `POST /api/rooms/{id}/close` | Bot (queen module) |
| `rooms.force_close` | `POST /api/rooms/{id}/force-close`, `POST /api/rooms/{id}/replay` | Admin |
| `agent_tokens.manage` | `POST /api/agent-tokens`, `DELETE /api/agent-tokens/{name}`, `POST /api/agent-tokens/{name}/set-capabilities`, etc. | Token-management endpoints — see §Per-installation admin protection |
| `*` | All capabilities (admin tokens only) | NOT included by `agent_tokens.manage` unless explicit (see §Wildcard) |

**Total: 19 capabilities** + `*` wildcard. (R1 said 17, vocabulary
table had 18 — recount yields 19 after `agent_tokens.manage` added
and `rooms.read` carved out from worker preset.)

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
  "rooms.contribute",
  "rooms.create",
  "rooms.update",
  "rooms.decide",
  "rooms.close",
  "rooms.force_close",
  "agent_tokens.manage",
] as const;

export function expandWildcards(capabilities: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of capabilities) {
    if (c === "*") {
      // Bare wildcard — operator must opt in via tokens issue
      // --allow-wildcards. The wildcard does NOT include
      // agent_tokens.manage unless the operator explicitly adds it.
      for (const k of KNOWN_CAPABILITIES) {
        if (k !== "agent_tokens.manage") out.add(k);
      }
      continue;
    }
    if (c.endsWith(".*")) {
      const prefix = c.slice(0, -2);  // "tasks.*" → "tasks"
      for (const k of KNOWN_CAPABILITIES) {
        if (k.startsWith(prefix + ".")) out.add(k);
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
`agent_tokens.manage` unless explicitly added. Closes guard issue
"`*` includes token management" trap.

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
| `capabilities: []` (rejected at issue) | n/a — capabilities ≥1 is enforced | 401 `TOKEN_LEGACY_UNSCOPED` (covered earlier) |
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
# the bearer; zero invalid-bearer window vs revoke+reissue path)
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

Stream is bounded with `MAXLEN ~10000` per installation (auto-trim
oldest). Retention is approximately 30 days at single-Hive auth
volume. V1.1 may add an export-to-Vercel-Analytics path for longer
retention; not blocking V1.

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
   30 days rolling via stream `MAXLEN ~10000` (closes guard +
   hivemoot reviewer audit-location asks). Storage location:
   Redis stream per-installation (`hive:v1:agent-token:{installationId}:audit`).

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
