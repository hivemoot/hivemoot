# Redis Key Naming Convention

> Status: canonical convention for new Redis keys in hivemoot.dev.
> Audience: anyone adding a new Redis key.
> Out of scope: in-flight migration of legacy keys (see §Legacy below).

## TL;DR

```
hive:v1:<entity>[:<sub-entity>]:<id-1>[:<id-2>]...    primary records
hive:v1:idx:<entity>:<lookup-attribute>:<value>       secondary indexes
hive:v1:lock:<entity>:<id>                            distributed locks
```

- **Namespace**: always `hive:` (project-wide singleton).
- **Version**: always `v1:` (or higher) directly after the namespace.
- **Separator**: only `:` — never hyphens for separation.
- **Hyphens** are allowed *inside* a single segment (`agent-token`,
  `war-room`) but never between segments.
- **Singular nouns** for entities (`room`, not `rooms`;
  `agent-token`, not `agent-tokens`).
- **`idx:` sub-namespace** marks secondary indexes (anything used
  for "find me the X for this Y" lookups, not the primary record).
- **`lock:` sub-namespace** marks distributed locks consumed via
  `withRedisLock`.

## Why this convention

The Redis ecosystem has converged on `:` as the key segment
separator and on hierarchical names that read like pseudo-paths.
Sources: Redis blog, oneuptime, Redimo, MoldStud, Medium / DEV.to.
Versioning the prefix lets us migrate schemas safely (write `v2:`
alongside, dual-write, drop `v1:`) without losing the safety of
"old code can't accidentally read the new shape."

The `idx:` and `lock:` sub-namespaces are project-specific
clarifications — they make secondary lookups visually distinct from
primary records (so a quick `KEYS hive:v1:room:*` doesn't conflate
"a room" with "an index pointing at a room").

## Examples

### Primary records

```
hive:v1:agent-token:{installationId}:{name}      # token envelope
hive:v1:room:{installationId}:{roomId}           # war room core
hive:v1:room:{roomId}:events                     # event log (sorted set)
hive:v1:room:{roomId}:participants               # materialized RSVP (hash)
hive:v1:room:{roomId}:claim                      # synthesis claim (string TTL)
```

### Secondary indexes

```
hive:v1:idx:agent-token:hash:{tokenHash}                                  # bearer → identity
hive:v1:idx:agent-token:installation:{installationId}                     # tokens per installation
hive:v1:idx:room:subject:{installationId}:{subjectType}:{subjectRef}      # open-room uniqueness
hive:v1:idx:room:installation:{installationId}                            # rooms by opened_at
hive:v1:idx:room:status:{installationId}:{status}                         # rooms at status
```

### Locks

```
hive:v1:lock:agent-token:{installationId}:{name}    # serialize issue/revoke
hive:v1:lock:room:{installationId}:{roomId}         # serialize room writes
hive:v1:lock:task:{taskId}                          # serialize task transitions
```

## Audit / streams

For append-only audit logs, prefer Redis Streams keyed by the
audit subject:

```
hive:v1:agent-token:{installationId}:audit          # XADD per token usage event
```

Audit entries MUST never carry raw bearers or other secrets — only
fingerprints, hashes, or opaque IDs.

## TTLs

Keys with a natural lifetime carry an explicit `EX`/`EXPIRE`. The
TTL is part of the key contract; document it next to the key
definition. Examples:

| Key | TTL | Why |
|---|---|---|
| `hive:v1:room:{roomId}:claim` | 5 min | Auto-revert if queen crashes mid-synthesis |
| `hive:v1:room:{roomId}:idem:{key}` | 90 days | Idempotency window outlives any retry plausible |
| Closed `hive:v1:room:*` siblings | 30 days | Audit retention; paired EXPIRE in close script |
| `hive:v1:agent-token:{...}:meta` | None | Lives with the envelope; cleaned up by revoke |

## Lua scripts

Multi-key atomic operations use Lua scripts following the existing
`agent-token.ts` pattern (`ROTATE_TOKEN_SCRIPT`,
`REVOKE_TOKEN_SCRIPT`). Scripts SHOULD return structured tuples
that distinguish success from each named failure mode, so callers
can dispatch precisely:

```lua
-- Convention (each script picks the discriminators it needs from this set):
--   {1, ...}    success (positive numeric tag, optional payload)
--   {0,  "<reason>"}   conflict / no-op outcome that the caller
--                      surfaces as a 4xx with a stable code. The
--                      reason string is the discriminator (e.g.
--                      "name_taken", "claim_active", "subject_taken").
--                      May ALSO be used for benign idempotency replay
--                      where the caller treats both the same way.
--   {-1, ...}   precondition failed (status mismatch, claim invalid)
--   {-2, ...}   sequence drift (caller should re-fetch and retry)
--   {-3, ...}   unrecoverable (claim_lost, force_close window)
```

Callers `switch` on the tag and discriminator, mapping each to a
distinct response shape. The convention is internally consistent
across modules: ISSUE returns `{0, "name_taken"}` for the "name
already exists" case, ROOM_RECOVER_DECIDING returns `{0,
"claim_active"}` for the "queen still working" case, etc.

Pin the script's `KEYS` ordering and `ARGV` ordering in a
JSDoc/Python docstring next to the constant so callers can audit
the contract without re-reading the script body.

## Rules summary

1. **Always** prefix with `hive:v<n>:`.
2. **Always** use `:` to separate segments. Never use `:` inside a
   single segment.
3. **Always** singular nouns for entities.
4. **Always** mark secondary lookups with `idx:`.
5. **Always** mark locks with `lock:`.
6. **Always** document the TTL (or "no TTL") next to the key
   definition.
7. **Never** put raw secrets in audit-log entries.
8. **Never** mix hyphen-as-separator and colon-as-separator (use
   only `:` between segments; hyphens stay inside single segments).
9. **Never** create a new key without registering it in the owning
   module's key constants block (one source of truth per module).

## Legacy keys (grandfathered)

These predate this convention. They keep working unmodified; do
not "drive-by" rename them as part of unrelated work — schedule a
dedicated migration PR per family if/when needed.

| Legacy key | Status |
|---|---|
| `hive:agent-token:{installationId}` | Replaced wholesale by Phase B cutover (envelopes 401'd, reissued under new convention) |
| `agent-token-hash:{hash}` | Replaced wholesale by Phase B cutover |
| `hive:byok:{installationId}` | Stays. Migrate when BYOK store is independently revisited. |
| `hive:agent-health:*` | Stays. Migrate when agent-health is independently revisited. |
| `hive:tasks:*` / `hive:task-lock:*` | Stays. Migrate when task-store is independently revisited. |
| `setup-session:*`, `oauth-state:*`, `user:*` | Stays. Migrate when session/auth subsystem is independently revisited. |

When migrating a legacy family:

1. Pick a future deploy window with planned downtime.
2. Stop writes (or write to both old and new names).
3. Migrate readers in one deploy.
4. Drop the old names in a follow-up.

## When to bump from `v1` to `v2`

Bump the version prefix when:

- The on-disk shape of an entity changes incompatibly (a removed
  field, a renamed field, a changed serialization format).
- Adding a sub-entity that the same key shape can't accommodate
  (e.g., switching from a single hash to per-attribute keys).
- A bug requires storage-layer cleanup that's safer with a fresh
  prefix.

For additive changes (new optional fields on a JSON envelope, new
indexes), keep `v1` and just add the new keys / fields.

The version is per-entity-family, not global. `agent-token` can be
on `v2:` while `room` is still on `v1:` — the `v` prefix is part
of the key contract per family, not a global toggle.
