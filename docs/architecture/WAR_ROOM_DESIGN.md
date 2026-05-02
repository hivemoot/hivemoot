# War Room — Design

> Status: design proposal (Phase D of the post-apiarist-V1 ultra plan).
> Scope: chat-style, presence-driven multi-agent coordination space, **bot-managed**.
>
> **Doc revision in progress (2026-05-02):** the canonical model has
> moved from explicit RSVP + `awaiting_rsvp` state → presence /
> heartbeat with a single `awaiting_contributions` open state. The
> §Concept and §Presence-driven lifecycle sections below reflect
> the new model. Deeper sections (specific Lua scripts, API route
> specs around `/present`, `rsvp_deadline_secs`) still describe the
> deprecated model and are being updated alongside the code that
> implements the new one. When in doubt, the §Presence-driven
> lifecycle section is authoritative.
> Depends on: Phase B (capability system), Phase C (apiarist V1.6
> `allowed_permissions` for read-only worker tokens — security claim
> "workers physically cannot write to GitHub" is FALSE until Phase C
> ships; see §16).

## Problem

After the apiarist V1 pilot, all subscriber-mode agents in a fleet share a
single GitHub identity (`hivemoot[bot]`). The pre-apiarist model relied on
each agent having a distinct GitHub user identity (drone-fleet,
builder-fleet, guard-fleet) for both routing (`@-mention drone-fleet` →
drone wakes) and conflict-free PR review state (each user gets one
reviewer slot). With shared bot identity, both break:

- **Routing**: `@-mention hivemoot[bot]` doesn't tell us which agent
  should answer. All five agents would either ignore it or all five
  would race to respond.
- **State conflict**: PR review state per reviewer is "last write wins."
  Five agents submitting state-bearing reviews means the latest one
  silently overwrites the others' verdicts at the merge gate.

War rooms are the architectural answer: a coordination layer where
multiple specialized worker agents contribute analyses around a single
subject, and the **bot** synthesizes them into one coherent GitHub
action (review comment, approve/request-changes, etc.) under
`hivemoot[bot]`'s identity.

---

## V1 architecture: the bot is the queen

The original sketch had a dedicated "queen agent" run as a standalone
service alongside drone/builder/guard. We instead run the queen as a
**module inside the existing Probot bot** for V1.

### Why bot-as-queen for V1

The synthesis loop has five steps: (1) detect a GitHub event, (2)
create-or-update the room, (3) collect contributions while watching
participant heartbeats, (4) synthesize via LLM, (5) post one GitHub
action under `hivemoot[bot]`. Steps 1, 2, 3, 5 are plain backend code.
Only step 4 actually requires LLM-agent infrastructure — and the bot
already has that (BYOK key per installation, four `@ai-sdk/*`
providers + `@openrouter/ai-sdk-provider` already in
`bot/package.json`, well-tested provider abstraction).

Concretely:

| Concern | Standalone queen agent | Bot-as-queen |
|---|---|---|
| LLM key management | New BYOK plumbing per installation | Already wired |
| GitHub event detection | Polling with own read-token | Native webhook reaction (already a Probot app) |
| Bootstrap | Needs apiarist token + agent runtime + image deploy | Already deployed; just adds a webhook handler |
| Posting one GitHub action | Auth as `hivemoot[bot]` via App installation token | Already authenticated as the App |
| Cost attribution | Per-installation BYOK cost model needs separate accounting | Reuses bot's per-installation BYOK accounting |
| Failure blast radius | Queen down → no synthesis (workers still heartbeat / contribute) | Bot down → no webhooks AND no synthesis |
| Operational surface | One more systemd service, one more container | Zero new services |

The trade we make by going bot-as-queen: **bot crashes take down
synthesis along with webhook handling** (vs standalone queen which
fails independently). For a single-Hive single-bot V1 this is
acceptable; both share the same Vercel deploy lifecycle anyway.

### Decision

**V1 ships bot-as-queen.** Queen logic lives in
`bot/api/lib/queen/` — synthesis prompt, manager loop, and a
direct-Redis store (`bot/api/lib/war-room-store.ts`) that calls
the shared `@hivemoot/war-room` storage primitives without going
through hivemoot.dev's HTTP surface. Per-tenant scoping comes
from the webhook payload (`installation.id`) on creates and from
`app.eachInstallation()` iteration on the cron path; no
per-installation bearer is required. The bot's existing webhook
handler dispatches `pull_request.opened` etc. to a queen
"create-room" routine. A scheduled background job (Vercel Cron or
similar) drives the manager loop on a 2-minute tick (Hobby/Pro
Vercel Cron minimum — see §Manager loop) to claim rooms whose
participants have settled and synthesize them.

The standalone queen-agent variant is documented in §17 (Future
variants) — kept as a referenceable fallback, with explicit triggers
that would make it the right call later.

---

## Goals

- **Single visible identity** to the GitHub UI (`hivemoot[bot]`), no
  conflict on PR review state
- **Multi-agent specialization preserved** behind the scenes (drone for
  architecture, builder for code quality, guard for security, etc.)
- **Reactive / chat-style** — as the subject evolves (new commits, new
  comments), the room receives events and agents can re-contribute
- **Self-selecting via presence/heartbeat** — agents engage by
  heartbeating (long-running work) or contributing directly
  (one-shot work); queen doesn't need a fleet roster and doesn't
  gate on a separate RSVP state
- **Read-only worker tokens** — Phase C (apiarist V1.6) goal; **does
  not hold during V1 rollout window** (see §16)
- **Built on the capability system** (Phase B) — all room ops are
  capability-gated; see §10
- **Separate from tasks** — tasks evolve independently for heavy
  single-agent execution work; war rooms are the chat-style layer

## Non-goals

- War rooms don't replace tasks. Tasks are still 1:1 single-agent
  exclusive execution work; war rooms are N:1 collaborative reaction.
- Cross-installation rooms. Per-installation only in V1.
- Long-running rooms (>1 hour). V1 hard ceiling on room age.
- Queen-as-LLM-agent for non-PR subjects. V1 covers PR review +
  mention response; mention response routes to PR-shaped rooms in
  practice.

---

## Concept

A **war room** is a real-time coordination space around a single
subject. It has:

- **Subject reference**: `(subject_type, subject_ref)` like
  `(pr_review, hivemoot/colony#456)`
- **Manager**: the bot (queen module — single instance per
  installation in V1)
- **Event log**: append-only, sequence-ordered, chat-style flow of
  things that happened in the room
- **Participants**: agents engaged with the room — each has a
  status (`working` while heartbeating, `done` once they've
  contributed, `dropped` once their heartbeat lapses or they
  withdraw); per-(room, role) first-wins
- **Contributions**: per-role analyses (latest-per-role-per-room)
- **Status state machine**: `awaiting_contributions` → `deciding`
  → `closed` (or `expired`) — single open state; participant
  presence (not a separate room status) gates synthesis
- **Decision**: bot's final synthesis + the GitHub action taken
  (with metadata for audit)

Workers don't watch GitHub directly; they watch war rooms via a new
agent runtime trigger (`war-room-watcher`). The bot watches GitHub
events (via Probot webhook) and translates them into war room
creation or update events.

---

## Presence-driven lifecycle (canonical)

Per the architectural decision: queen does NOT pre-declare expected
roles. Workers self-select by engaging with the room, queen waits
for whoever shows up to either deliver work or fall silent.

There is **one open status** (`awaiting_contributions`). Engagement
is tracked at the participant level via three statuses:

- `working` — agent is actively engaged; must heartbeat ≥ once per
  `drop_threshold_secs` window or it's dropped
- `done` — agent has submitted a contribution (terminal happy path)
- `dropped` — agent's heartbeat lapsed OR it withdrew (terminal sad
  path); recorded with a `reason` for ops triage

Why the bias toward heartbeats over a one-shot RSVP: a real worker
contribution is "do a deep code review" — that can take 30s for a
trivial change or an hour for a complex PR. A liveness signal makes
the queen's wait window adaptive to the actual work being done
instead of a guessed deadline.

A short, fast contribution doesn't *need* heartbeats — `POST
/contributions` from a brand-new agent creates the slot directly in
`done`. Heartbeats are for "I'm working on it, hold synthesis."

```
T+00:00  Bot webhook: pull_request.opened on hivemoot/colony#456
         Bot calls POST /api/rooms (queen module, bot-side)
         Event #1: room_opened (actor=bot)
         Room status: awaiting_contributions

T+00:01  Workers' war-room-watchers poll /api/rooms/watching, see new room
         Each worker dispatches a TRIAGE job (cheap/fast LLM):
           input  = subject + room event log + role description
           output = JSON {decision: engage | skip, reason, eta_hint?}

T+00:05  Drone triage → engage. Drone starts deep review and heartbeats:
         POST /api/rooms/{id}/heartbeat
         Event #2: participant_heartbeat
                   (role=drone, agent_id=drone-runner-1, status=working)
         Per-(room, role) first-wins: only one runner per role

T+00:08  Builder triage → engage:
         POST /api/rooms/{id}/heartbeat
         Event #3: participant_heartbeat (role=builder, status=working)

T+00:10  Guard triage → engage:
         POST /api/rooms/{id}/heartbeat
         Event #4: participant_heartbeat (role=guard, status=working)

T+00:30  Drone finishes review:
         POST /api/rooms/{id}/contributions
         Event #5: contribution_submitted (role=drone) — drone: working → done

T+00:30+  Builder + guard continue heartbeating every ~60s while their
          deep work is in flight. (Cadence is the agent's choice; the
          server only enforces the drop threshold.)

T+01:05  Builder finishes:
         POST /api/rooms/{id}/contributions
         Event #6: contribution_submitted (role=builder) — builder: working → done

T+01:05+  Guard keeps heartbeating; queen tick every 2 min sees:
          done = {drone, builder}; working = {guard}; → wait.

T+11:30  Guard's last heartbeat was at T+10:55 (45s ago — fine).
         Watchdog passes guard untouched.

T+15:42  Guard's last heartbeat was at T+05:42. drop_threshold_secs
         (default 600) elapsed.
         Watchdog: guard → dropped, reason=heartbeat_lapsed
         Event #7: participant_dropped (role=guard, reason=heartbeat_lapsed)

T+16:00  Manager-loop tick, all three synthesis preconditions met:
         (a) ≥1 done (drone, builder)
         (b) 0 working (guard is dropped)
         (c) quiet_period_secs since last activity event has elapsed
         POST /api/rooms/{id}/decide  (claims synthesis atomically)
         Bot reads contributions, runs LLM synthesis with isolation
           prompt (see §11), posts ONE PR review on hivemoot/colony#456
           in COMMENT mode (V1 default — see §11 / §17.G)
         POST /api/rooms/{id}/close
         Event #8: queen_decision + Event #9: room_closed
```

State-machine notes:

- **Single open status**: rooms are born `awaiting_contributions`
  and stay there until they reach a terminal state. There is no
  pre-synthesis state. Worker engagement is tracked on
  participants, not on the room status.
- **Quiet period** is computed from the most recent
  `participant_heartbeat` OR `contribution_submitted` event. Once
  every working participant has gone `done` or `dropped`, no more
  heartbeats fire and the quiet window starts ticking.
- **First-wins gate** is enforced at the participant slot, on the
  *first* call from any role — whether that's `/heartbeat` or
  `/contributions`. A second runner trying to hold the same role
  receives `409 owner_conflict`.
- **Heartbeats are agent-paced**, not server-mandated. An agent
  doing 90-second work might never call `/heartbeat`; an agent
  doing an hour-long deep review heartbeats every ~60s. The server
  only enforces the drop threshold (default 600s).

The key shift from the previous RSVP-then-contribute model: queen's
"ready to synthesize" is **data-driven from participant statuses**,
not gated on a separate room transition. Removes one state, one
endpoint (`/present`), and the entire `awaiting_rsvp` →
`awaiting_contributions` transition logic.

### V2 hooks (out of scope for first cut)

- **Queen as contributor**: queen can post her own contribution to
  a room (e.g., raising a question to the workers).
- **Status reset**: queen can flip done participants back to
  `working` with an `additional_input_required` reason and a body
  describing what's needed — agents pick the room back up. Enables
  iterative refinement loops without re-opening the room.

---

## Storage layout (Redis / Upstash)

The project's storage backend is Upstash Redis with `@upstash/redis`
client; see `web/src/server/redis.ts`, `web/src/server/agent-token.ts`,
`web/src/server/task-store.ts`. There is no SQL database, no ORM, no
`DATABASE_URL`. War rooms reuse this stack — no new infrastructure
dependency.

All keys follow the project-wide convention in
`docs/architecture/REDIS_KEY_CONVENTION.md`:
`hive:v<n>:<entity>[:<sub-entity>]:<id>` for primary records,
`hive:v<n>:idx:<entity>:<lookup>:<value>` for secondary indexes,
`hive:v<n>:lock:<entity>:<id>` for locks. Multi-key atomicity is
preserved via Lua scripts.

### Key shape

Primary records:

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `hive:v1:room:{installationId}:{roomId}` | hash | None until closed; 30 days after close | Room core (status, manager, subject_ref, timing config, decision once closed) |
| `hive:v1:room:{roomId}:events` | sorted set | Inherits room TTL | Event log; member = event JSON, score = sequence number |
| `hive:v1:room:{roomId}:idem:{key}` | string | `max_age_secs * 2` (default 7200 s = 2 h) — TTL parameterized at write time, NOT hard-coded | Idempotency reverse index → sequence number |
| `hive:v1:room:{roomId}:participants` | hash | Inherits room TTL | Materialized participant per role: `{role → JSON {agent_id, status, first_seen_at, last_heartbeat_at, resolved_at?, dropped_reason?}}`. `status ∈ {working, done, dropped}`. |
| `hive:v1:room:{roomId}:contributions` | hash | Inherits room TTL | Materialized latest-per-role contributions: `{role → JSON {body, raw_md, contributed_at}}` |
| `hive:v1:room:{roomId}:seq` | counter | Inherits room TTL | Monotonic event sequence (`INCR` per event) |
| `hive:v1:room:{roomId}:claim` | string | **6 min** (intentionally 1 min ABOVE Vercel Pro `maxDuration` of 5 min — closes guard R3 N7 recovery-vs-synthesis double-post race) | Synthesis claim: → `{queenRunner, claimedThroughSequence}`. TTL deletes the claim KEY only; the room hash + status set are reverted on the next manager-loop tick by `ROOM_RECOVER_DECIDING_SCRIPT` — see §Atomic operations and §Manager loop / Recovery branch. |

Secondary indexes:

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `hive:v1:idx:room:subject:{installationId}:{subjectType}:{subjectRef}` | string | `max_age_secs` (default 3600 s = 1 h) — defense-in-depth so a stalled-recovery scenario can't permanently block new rooms (closes Queen R3 #3) | Open-room uniqueness → `{roomId}` while room is in `awaiting_contributions \| deciding`; deleted on close |
| `hive:v1:idx:room:installation:{installationId}` | sorted set (roomIds, score=`opened_at`) | None — closed rooms ZREM'd by `ROOM_CLOSE_SCRIPT`, NOT just the status-set membership (closes Queen R2 #2) | All rooms for `GET /api/rooms` filtering |
| `hive:v1:idx:room:status:{installationId}:{status}` | set (roomIds) | None | Rooms at this status; updated on every transition. Used by manager loop's "rooms to advance" scan |
| `hive:v1:idx:room:repo:{installationId}:{owner}/{repo}` | set (roomIds) | None — closed rooms SREM'd by `ROOM_CLOSE_SCRIPT` (closes guard M3) | Per-repo room filtering for dashboard |

Locks (per REDIS_KEY_CONVENTION.md):

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `hive:v1:lock:room:{installationId}:{roomId}` | string | 30 s | Defense-in-depth serialization for non-Lua-scripted multi-key writes (rare) |

Eviction: rooms set explicit TTL on close = 30 days for audit
retention; sibling keys inherit via paired `EXPIRE` calls in the
close Lua script. The `:seq` counter and `:idem:*` indexes get the
same TTL treatment so nothing leaks.

### Atomic operations (Lua)

Six scripts; each follows the return-shape convention in
REDIS_KEY_CONVENTION.md (`{1, ...}` success / `{0, ...}` benign
conflict / `{-1, ...}` precondition fail / `{-2, ...}` sequence
drift / `{-3, ...}` unrecoverable). Pin each script's `KEYS` and
`ARGV` ordering when porting to TypeScript.

**`ROOM_OPEN_SCRIPT`** — opens a room IF no open room exists for the
subject. Prevents duplicate-open race. Initializes the sequence
counter (closes guard B1), TTLs the subject index (closes Queen R3
#3), and registers the per-repo index (closes guard M3).

```lua
-- KEYS: [subjectIndexKey, roomKey, seqKey, eventsKey,
--        statusSetAwaitingContribsKey, allRoomsKey, repoIndexKey]
--   subjectIndexKey              = hive:v1:idx:room:subject:{installationId}:{subjectType}:{subjectRef}
--   roomKey                      = hive:v1:room:{installationId}:{roomId}
--   seqKey                       = hive:v1:room:{roomId}:seq
--   eventsKey                    = hive:v1:room:{roomId}:events
--   statusSetAwaitingContribsKey = hive:v1:idx:room:status:{installationId}:awaiting_contributions
--   allRoomsKey                  = hive:v1:idx:room:installation:{installationId}
--   repoIndexKey                 = hive:v1:idx:room:repo:{installationId}:{owner}/{repo}
-- ARGV: [installationId, roomId, subjectType, subjectRef, roomJson,
--        roomOpenedEventJson, openedAt, maxAgeSecs]
-- Returns: {1, roomId}    success
--          {0, existingRoomId}  another open room covers this subject
local existing = redis.call("get", KEYS[1])
if existing then return {0, existing} end

-- Reserve subject index with TTL = max_age_secs (defense-in-depth
-- so a stalled-recovery scenario can't permanently block new rooms)
redis.call("set", KEYS[1], ARGV[2], "EX", tonumber(ARGV[8]))

-- Initialize the sequence counter at 1, then write the room_opened
-- event at score 1 (counter and event score agree, closes B1)
redis.call("set", KEYS[3], 1)
redis.call("hset", KEYS[2], "data", ARGV[5])
redis.call("zadd", KEYS[4], 1, ARGV[6])

-- Register in status, by-installation, and by-repo indexes
redis.call("sadd", KEYS[5], ARGV[2])
redis.call("zadd", KEYS[6], ARGV[7], ARGV[2])
redis.call("sadd", KEYS[7], ARGV[2])
return {1, ARGV[2]}
```

**`ROOM_APPEND_EVENT_SCRIPT`** — append event idempotently with
monotonic sequence. Updates participant or contribution materialized
view depending on event_type. Closes G7 (watchdog vs claim race).
Idempotency TTL is now parameterized from ARGV (closes Queen R3 #5).

```lua
-- KEYS: [seqKey, eventsKey, idemKey, roomKey, materializedKey,
--        statusFromSetKey, statusToSetKey]
-- ARGV: [eventJsonTemplate, idempotencyKey, eventType,
--        materializedFieldName, materializedFieldJson,
--        roomStatusFrom, roomStatusTo, roomId, idemTtlSecs]
-- Returns: {seq}                     success
--          {-1, existingSequence}    idempotency replay
--          {-2, currentRoomStatus}   status precondition fail
if ARGV[2] ~= "" then
  local existing = redis.call("get", KEYS[3])
  if existing then return {-1, tonumber(existing)} end
end
local currStatus = redis.call("hget", KEYS[4], "status")
if ARGV[6] ~= "" and currStatus ~= ARGV[6] then
  return {-2, currStatus}
end
local seq = redis.call("incr", KEYS[1])
local eventJson = string.gsub(ARGV[1], "__SEQ__", tostring(seq))
redis.call("zadd", KEYS[2], seq, eventJson)
if ARGV[2] ~= "" then
  redis.call("set", KEYS[3], tostring(seq), "EX", tonumber(ARGV[9]))
end
if ARGV[4] ~= "" then
  redis.call("hset", KEYS[5], ARGV[4], ARGV[5])
end
if ARGV[7] ~= "" then
  redis.call("hset", KEYS[4], "status", ARGV[7])
  redis.call("srem", KEYS[6], ARGV[8])
  redis.call("sadd", KEYS[7], ARGV[8])
end
return {seq}
```

`status_from`/`status_to` are optional and only set for events that
intend to transition state (e.g. `participant_timed_out` doesn't
transition; `decide`-claim does). The `currStatus` precondition
prevents the `participant_timed_out` watchdog from racing
`/decide` claim — if status moved out of `awaiting_contributions`
between watchdog scan and write, the script returns `{-2, ...}` and
the watchdog re-scans on the next tick.

**`ROOM_DECIDE_CLAIM_SCRIPT`** — atomically claim synthesis. The
claim's 6-minute TTL is necessary but not sufficient for crash
recovery — see `ROOM_RECOVER_DECIDING_SCRIPT` below.

```lua
-- KEYS: [roomKey, claimKey, statusSetAwaitingKey, statusSetDecidingKey, lastSeqKey]
-- ARGV: [roomId, queenRunner, claimTtlSecs]
-- Returns: {1, currentSeq}        claim acquired
--          {0, claimingRunner}    already claimed by another tick
--          {-1, currentStatus}    not in awaiting_contributions
local status = redis.call("hget", KEYS[1], "status")
if status ~= "awaiting_contributions" then
  return {-1, status}
end
local existing = redis.call("get", KEYS[2])
if existing then
  return {0, existing}
end
local seq = tonumber(redis.call("get", KEYS[5])) or 0
local claim = cjson.encode({runner = ARGV[2], throughSequence = seq})
redis.call("set", KEYS[2], claim, "EX", tonumber(ARGV[3]))
redis.call("hset", KEYS[1], "status", "deciding",
                          "deciding_through_sequence", tostring(seq))
redis.call("srem", KEYS[3], ARGV[1])
redis.call("sadd", KEYS[4], ARGV[1])
return {1, seq}
```

**`ROOM_RECOVER_DECIDING_SCRIPT`** — atomically revert a `deciding`
room to `awaiting_contributions` IF the claim has expired (or never
existed). Closes builder R2 — the 6-minute TTL deletes the claim
key but NOT the room hash status nor the status-set membership; this
script is what the manager-loop recovery branch invokes per stuck
room.

```lua
-- KEYS: [roomKey, claimKey, statusSetDecidingKey, statusSetAwaitingKey,
--        seqKey, eventsKey]
-- ARGV: [roomId, recoveryEventJson, recoveredAt]
-- Returns: {1, sequence}    recovered (revert + recovery event emitted)
--          {0, "claim_active"}    claim still alive — caller should NOT recover
--          {-1, currentStatus}    room not in deciding (already moved on)
local status = redis.call("hget", KEYS[1], "status")
if status ~= "deciding" then
  return {-1, status}
end
local claim = redis.call("get", KEYS[2])
if claim then
  return {0, "claim_active"}
end
-- Atomically revert: hash + status sets + emit recovery event
local seq = redis.call("incr", KEYS[5])
local eventJson = string.gsub(ARGV[2], "__SEQ__", tostring(seq))
redis.call("zadd", KEYS[6], seq, eventJson)
redis.call("hset", KEYS[1], "status", "awaiting_contributions",
                          "deciding_through_sequence", "")
redis.call("srem", KEYS[3], ARGV[1])
redis.call("sadd", KEYS[4], ARGV[1])
return {1, seq}
```

The manager loop scans `hive:v1:idx:room:status:{installationId}:deciding`
every tick and calls this script for each room. The `{0, "claim_active"}`
return tells the manager "queen is still working" — skip and re-check
next tick. The `{1, ...}` return triggers an audit event and observability
metric (`recovered_deciding_rooms_count`).

**`ROOM_TERMINATE_SCRIPT`** (renamed from `ROOM_EXPIRE_SCRIPT` in R4
to reflect its broader scope) — atomically close a room without
requiring a claim. Used for any non-decided terminal transition:
expiration, synthesis-failure, force-close, manual operator close.
Closes Queen R3 #1, guard R3 N10 (closed_reason arg drift), guard
R3 N8 (deciding-state coverage), builder R3 #2 (terminal close
paths consistency).

```lua
-- KEYS: [roomKey, subjectIndexKey, statusSetCurrentKey, allRoomsKey, repoIndexKey,
--        seqKey, eventsKey, participantsKey, contributionsKey, claimKey]
-- ARGV: [roomId, terminalEventJson, closedAt, retentionSecs, closedReason]
--   closedReason ∈ {"expired", "failed_synthesis", "force_close", "manual"}
-- Returns: {1, sequence}        terminated (status → closed, sibling cleanup,
--                                          claim DELed if held)
--          {-1, currentStatus}  already in `closed` (operator double-tap)
local status = redis.call("hget", KEYS[1], "status")
if status == "closed" then
  return {-1, status}
end
-- If the room is in `deciding`, the queen had a claim — DEL it so
-- queen's mid-flight `/close` returns {-3, "claim_lost"} and aborts
-- the GitHub post (closes guard R3 N8: stuck-deciding past max_age
-- was unreachable by the prior expire script). Same path covers
-- force-close on a deciding room (S5).
redis.call("del", KEYS[10])
local seq = redis.call("incr", KEYS[6])
local eventJson = string.gsub(ARGV[2], "__SEQ__", tostring(seq))
redis.call("zadd", KEYS[7], seq, eventJson)
redis.call("hset", KEYS[1], "status", "closed",
                          "closed_at", ARGV[3],
                          "closed_reason", ARGV[5])
redis.call("del", KEYS[2])              -- subject index released
redis.call("srem", KEYS[3], ARGV[1])    -- remove from current status set
redis.call("zrem", KEYS[4], ARGV[1])    -- remove from per-installation index (R2 #2)
redis.call("srem", KEYS[5], ARGV[1])    -- remove from per-repo index (M3)
redis.call("expire", KEYS[1], tonumber(ARGV[4]))
redis.call("expire", KEYS[6], tonumber(ARGV[4]))
redis.call("expire", KEYS[7], tonumber(ARGV[4]))
redis.call("expire", KEYS[8], tonumber(ARGV[4]))
redis.call("expire", KEYS[9], tonumber(ARGV[4]))
return {1, seq}
```

Per the new `closed_reason` parameter, the manager-loop call sites
become:

| Call site | `closed_reason` |
|---|---|
| `room.age > max_age_secs` (watchdog) | `"expired"` |
| `consecutive_synthesis_failures >= 3` | `"failed_synthesis"` |
| `POST /api/rooms/{id}/force-close` | `"force_close"` |
| `POST /api/rooms/{id}/close` from operator UI (rare) | `"manual"` |

The successful `decided` path stays in `ROOM_CLOSE_SCRIPT` (which
DOES require a claim, since it represents queen completing
synthesis cleanly with sequence-consistency intact). The two
scripts split cleanly: `ROOM_CLOSE_SCRIPT` for "happy path with
claim", `ROOM_TERMINATE_SCRIPT` for everything else.

Note the per-key TTLs on the seq counter and audit/event sibling
keys (closes Queen R2 #1 — TTL leak in CLOSE), and the explicit
ZREM/SREM on by-installation and by-repo indexes (closes Queen R2
#2 — sets accumulating closed room IDs).

**`ROOM_CLOSE_SCRIPT`** — close after queen synthesis, with
sequence-consistency check. R3 fixes: B2 (status-set transition on
the `-2` drift path), B3 (sequence-stamp the closed-event JSON via
`__SEQ__` substitution), Queen R2 #1 (TTL the seq counter), Queen R2
#2 (ZREM from by-installation), and per-repo SREM.

```lua
-- KEYS: [roomKey, claimKey, lastSeqKey, statusSetDecidingKey,
--        statusSetAwaitingContribKey, subjectIndexKey, eventsKey,
--        participantsKey, contributionsKey, allRoomsKey, repoIndexKey]
-- ARGV: [roomId, expectedThroughSequence, decisionJson, closedEventJsonTemplate,
--        closedAt, retentionSecs]
-- Returns: {1, sequence}            closed cleanly
--          {-2, lastSeq}            sequence drift — claim freed, room reverted
--                                   to awaiting_contributions; caller re-synthesizes
--          {-3, "claim_lost"}       claim deleted out from under us (force-close)
--          {-3, "claim_throughSeq_mismatch"}  claim's throughSequence != ARGV[2]
local claim = redis.call("get", KEYS[2])
if not claim then return {-3, "claim_lost"} end
local parsed = cjson.decode(claim)
if tonumber(parsed.throughSequence) ~= tonumber(ARGV[2]) then
  return {-3, "claim_throughSeq_mismatch"}
end
local lastSeq = tonumber(redis.call("get", KEYS[3])) or 0
if lastSeq ~= tonumber(ARGV[2]) then
  -- New events arrived during synthesis → unclaim AND atomically
  -- revert status-set membership (closes B2: the -2 path was
  -- orphaning rooms from both deciding and awaiting_contributions
  -- status sets, making them invisible to subsequent ticks)
  redis.call("del", KEYS[2])
  redis.call("hset", KEYS[1], "status", "awaiting_contributions",
                            "deciding_through_sequence", "")
  redis.call("srem", KEYS[4], ARGV[1])           -- remove from deciding set
  redis.call("sadd", KEYS[5], ARGV[1])           -- restore to awaiting_contributions set
  return {-2, lastSeq}
end

-- Sequence-stamp the closed event JSON (closes B3) so the body
-- carries the same sequence as the sorted-set score
local closedSeq = lastSeq + 1
local closedEventJson = string.gsub(ARGV[4], "__SEQ__", tostring(closedSeq))

redis.call("hset", KEYS[1], "status", "closed",
                          "decision", ARGV[3], "closed_at", ARGV[5])
redis.call("zadd", KEYS[7], closedSeq, closedEventJson)
redis.call("set", KEYS[3], tostring(closedSeq))
redis.call("del", KEYS[2])
redis.call("del", KEYS[6])                       -- release subject index
redis.call("srem", KEYS[4], ARGV[1])             -- remove from deciding status set
redis.call("zrem", KEYS[10], ARGV[1])            -- remove from per-installation (R2 #2)
redis.call("srem", KEYS[11], ARGV[1])            -- remove from per-repo (M3)
redis.call("expire", KEYS[1], tonumber(ARGV[6]))  -- room core
redis.call("expire", KEYS[3], tonumber(ARGV[6]))  -- seq counter (Queen R2 #1)
redis.call("expire", KEYS[7], tonumber(ARGV[6]))  -- events log
redis.call("expire", KEYS[8], tonumber(ARGV[6]))  -- participants
redis.call("expire", KEYS[9], tonumber(ARGV[6]))  -- contributions
return {1, closedSeq}
```

The per-event idempotency keys (`hive:v1:room:{roomId}:idem:{key}`)
keep their independent TTLs set at append time. They naturally
outlive room data only if `idemTtlSecs > retentionSecs`, which we
prevent by deriving `idemTtlSecs = max_age_secs * 2` and
`retentionSecs = 30 days` (closes Queen R3 #5 — TTL contradiction
is gone).

### Why Redis is sufficient for V1

The relational queries the original SQL design relied on (list by
status, filter by repo, join events + participants) decompose into
narrow Redis lookups:

- "List open rooms in installation X" → `SMEMBERS
  hive:v1:idx:room:status:{X}:awaiting_rsvp ∪ awaiting_contributions ∪
  deciding`, then `HMGET` per room key.
- "List rooms by repo" → `SMEMBERS
  hive:v1:idx:room:repo:{installationId}:{owner}/{repo}` (populated by
  `ROOM_OPEN_SCRIPT`, cleaned up by close/expire scripts).
- "Stuck-room watchdog" — same status set + per-room hash read.

Avoiding SQL is an explicit project value (see CONCEPT.md: *"There is
no external database, no hidden state, no admin panel"*). The
materialized hashes (participants, contributions) replace the
denormalized SQL tables, and the events sorted set replaces
`war_room_events`. Foreign-key consistency moves to application
code, same as the existing `agent-token.ts` and `task-store.ts`
patterns.

### Why Redis is sufficient for V1

The relational queries the original SQL design relied on (list by
status, filter by repo, join events + participants) decompose into
narrow Redis lookups:

- "List open rooms in installation X" → `SMEMBERS
  hive:v1:idx:room:status:{X}:awaiting_rsvp ∪ awaiting_contributions ∪
  deciding`, then `HMGET` per room key.
- "List rooms by repo" → fetched set intersected against a per-repo
  index `hive:v1:idx:room:repo:{installationId}:{owner}/{repo}` (added
  on room open, removed on room close).
- "Stuck-room watchdog" — same status set + per-room hash read.

Avoiding SQL is an explicit project value (see CONCEPT.md: *"There is
no external database, no hidden state, no admin panel"*). The
materialized hashes (participants, contributions) replace the
denormalized SQL tables, and the events sorted set replaces
`war_room_events`. Foreign-key consistency moves to application
code, same as the existing `agent-token.ts` and `task-store.ts`
patterns.

---

## Authoritative role binding (S1)

**`role` is server-derived from the token envelope, never accepted
from the request body.**

The capability system's `AgentTokenEnvelope` (CAPABILITIES_DESIGN.md
§Storage layout) gains a required field `agent_role` set at
issuance:

```typescript
interface AgentTokenEnvelope {
  installationId: string;
  name: string;                  // e.g. "drone-fleet"
  capabilities: string[];        // e.g. ["rooms.watch", "rooms.contribute"]
  agent_role: string;            // e.g. "drone" — bound at issue time
  encryptedToken: EncryptedEnvelope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt?: string;
}
```

`POST /api/rooms/{id}/present`, `/contribute`, `/withdraw` REJECT any
client-supplied `role` field. The handler reads `role` from the
authenticated envelope. Same for `actor_role` on every event written
via `ROOM_APPEND_EVENT_SCRIPT` — composed server-side from the
envelope, not from the request body.

This prevents a `drone`-role worker token from claiming `role=guard`
on `/present`, occupying guard's RSVP slot, and emitting a
contribution that queen treats as guard's analysis.

The CLI (`hivemoot rooms present --role drone`) keeps `--role` as a
client-side ergonomic flag but the server ignores it; the server's
authoritative role wins. The CLI emits a warning if the
envelope-resolved role differs from `--role` (catches misconfigured
secrets early).

---

## Idempotency, concurrency, and validation

### Idempotency keys (G1)

The server canonically computes `idempotency_key` for every
`/present`, `/contribute`, `/withdraw`, `/decide`, `/close`,
`/event` write as:

```
sha256("v1:" + roomId + ":" + serverRole + ":" + action + ":"
       + sequenceObservedByClient)
```

`sequenceObservedByClient` is REQUIRED — sent via the
`If-Room-Sequence-At-Or-After: <N>` header. **Requests omitting the
header are rejected with `400 MISSING_SEQUENCE_HEADER`** (closes
guard M1). The fallback "server-fresh counter" path the R2 draft
allowed is removed: it produced unique-per-attempt keys (defeating
idempotency) on every client retry, masking transient network
failures as double-writes.

Clients MAY additionally send their own `Idempotency-Key` header
for local retry safety, but the **server verifies it equals the
canonical key** and rejects mismatches with
`400 INVALID_IDEMPOTENCY_KEY`. The dual mechanism lets clients
detect their own caller-side bugs (mismatched keys signal logic
errors); the server-canonical key is what's actually persisted.

Why this matters: a buggy or hostile client supplying static keys
causes 409 retry storms; the required header gives the server
ground truth on the client's view of the sequence.

### Sequence ordering with concurrent writers (Queen #3)

`hive:v1:room:{roomId}:seq` is a Redis counter. Every event acquires its
sequence via `INCR` inside `ROOM_APPEND_EVENT_SCRIPT`, atomic with
the event-set `ZADD`. Multiple workers POST'ing concurrently (present,
contribute, withdraw) get distinct, monotonic sequence numbers; the
sorted-set `ZADD` orders them by sequence regardless of arrival order
on the network.

Hot-key concern: at V1 scale (single Hive, ≤10 worker fleet, room
opens at PR-event cadence) the per-room counter sees ≤20 ops over
the room's lifetime — not hot. If V1+ shows churn, switch to
ULID/UUIDv7 for event IDs and demote `sequence` to a derived value
computed at read time.

### Size and depth caps (G2)

Hard limits enforced at the API layer with explicit error codes:

| Field | Limit | Error code |
|---|---|---|
| `body` (event JSON payload) | 8 KiB serialized | `EVENT_BODY_TOO_LARGE` |
| `raw_text` (markdown / agent output) | 32 KiB UTF-8 | `EVENT_RAW_TEXT_TOO_LARGE` |
| `body` JSON depth | 8 levels | `EVENT_BODY_TOO_DEEP` |
| Total events per room | 200 | `ROOM_EVENT_LIMIT` |
| Room age | `max_age_secs` (default 3600) | `ROOM_EXPIRED` |

Above the per-event limit, agents must summarize and link out (e.g.
to a gist or PR comment). 32 KiB is roughly 5,000 words — adequate
for a structured worker contribution, deliberately too small for
verbatim diff dumps.

### `subject_ref` validation (G3)

`subject_ref` is validated against a per-`subject_type` regex at
write time:

| `subject_type` | Regex |
|---|---|
| `pr_review` | `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[1-9][0-9]*$` |
| `mention_response` | same as `pr_review` (mention always lives on a PR/issue) |
| `issue_triage` | same as `pr_review` |

Reject violations with `400 INVALID_SUBJECT_REF`. The dashboard
treats `subject_ref` as opaque text from the schema view but renders
it via a strict template (`<owner>/<repo>#<number>` becomes a GitHub
link), never raw HTML — defense in depth against an XSS surface
arising from misvalidated input.

---

## API surface

All endpoints live on hivemoot.dev. **External callers** (workers
on the hive, CLI users) reach them via HTTP with a V1 capability
bearer (`Authorization: Bearer …`). The **bot's queen** (colocated
with the same Redis instance) bypasses HTTP entirely — it calls
the shared `@hivemoot/war-room` storage primitives directly via
`bot/api/lib/war-room-store.ts`, with per-tenant scoping from the
webhook payload (`installation.id`) on creates and from
`app.eachInstallation()` iteration on the cron path. The HTTP
surface below is therefore the contract for external consumers;
the bot's queen reproduces the same semantics by calling the
underlying storage primitives directly.

```
# Bot/queen-only (capability: rooms.create / rooms.update / rooms.decide / rooms.close)
POST   /api/rooms                          # create room (bot, on webhook)
POST   /api/rooms/{id}/event               # post a queen meta-event (subject_updated, queen_question)
POST   /api/rooms/{id}/decide              # claim synthesis atomically (S4)
POST   /api/rooms/{id}/close               # close with decision (sequence-checked)
DELETE /api/rooms/{id}/claim               # voluntary unclaim (queen abort path)

# Worker-accessible (capability: rooms.watch / rooms.contribute / rooms.read)
GET    /api/rooms/watching                 # list open rooms eligible for THIS token's role
GET    /api/rooms/{id}                     # read room core + materialized contributions
GET    /api/rooms/{id}/events?since=N      # read event log slice
POST   /api/rooms/{id}/present             # RSVP — required before contribute
POST   /api/rooms/{id}/withdraw            # explicit withdraw if no contribution warranted
POST   /api/rooms/{id}/contribute          # post analysis (idempotent)

# Operator-accessible (capability: rooms.read / rooms.force_close + admin)
GET    /api/rooms?status=&repo=&since=&until=
POST   /api/rooms/{id}/force-close         # admin escalation (S5-aware)
POST   /api/rooms/{id}/replay              # see §14 for semantics
```

Background watchdog (V1): bot-side cron-driven scan every 2 min of
`hive:v1:idx:room:status:{installationId}:awaiting_contributions`. For
each room, check participants past their RSVP-to-contribution timeout
→ emit `participant_timed_out` (transitionless event); also check
rooms past `max_age_secs` → close with `expired` reason.

The `GET /api/rooms/watching` endpoint **uses the token's bound
`agent_role` server-side**, no `role` query parameter needed. The
old `?role={role}` query parameter is removed (closes the original
draft's `role={role}` vs `role=$AGENT_ID` typo + the server-side
role-spoofing risk). Returns: open rooms in `awaiting_rsvp` or
`awaiting_contributions` for the token's installation, EXCLUDING
rooms where this role has already RSVP'd-and-resolved at the current
sequence.

**Withdrawn-role re-eligibility on `subject_updated` (closes Queen
R2 #3):** withdrawal is **scoped to the contribution round, not
permanent**. Concretely:

- After `participant_withdrew`, the role's record stays on the
  participant hash with `status: "withdrew"` and a
  `withdrew_at_sequence` field (the sequence at withdrawal).
- A `subject_updated` event written by the bot carries a fresh
  sequence; the watcher's `?since=N` poll surfaces the room again.
- `GET /api/rooms/watching` re-includes the room for that role IFF
  the room has new events past `withdrew_at_sequence` (i.e., the
  subject changed since withdrawal). The watcher's local
  `last_event_sequence_seen` and the server-side filter agree.
- On a fresh re-RSVP (`POST /present`), the participant record's
  `status` flips back to `pending`; `withdrew_at_sequence` is
  cleared. The audit log preserves the prior `participant_withdrew`
  event regardless.

For PR-shaped subjects, this matters: a worker that withdrew from a
"too small to matter" PR can re-RSVP if the PR doubles in size.
For `mention_response` subjects, this matters: a worker that
withdrew from a mention can re-RSVP if a follow-up mention adds
context.

### Worker-token reads (closes #500-builder issue 3)

Workers need to read room state + event log to do meaningful triage
and contribution. The capability mapping:

- `rooms.watch` → `GET /api/rooms/watching`
- `rooms.read` → `GET /api/rooms/{id}` and `GET
  /api/rooms/{id}/events` (scoped to rooms in this installation that
  the role has RSVP'd to OR is eligible to RSVP for)
- `rooms.contribute` → `POST /api/rooms/{id}/{present,withdraw,contribute}`

`rooms.read` is on the worker preset (not on a separate token). The
"worker can RSVP but not read" failure mode the original draft would
have produced is closed.

### `/replay` semantics (G6)

`POST /api/rooms/{id}/replay` is **option (a) from G6**: creates a
NEW room with the same `subject_type` + `subject_ref`, plus a
`replay_of: {originalRoomId}` field on the room core record. The new
room's core also carries `replayed_by: {operatorAgentId}` and
`replay_reason`. The original room remains `closed` with its decision
intact.

Why option (a) over (b) (re-open closed): re-opening collides with
the partial uniqueness invariant (`hive:v1:idx:room:subject:*` is held
only for open rooms). Creating a new room composes naturally with the
existing open-room idempotency check — if a real new room for the
same subject was opened in the meantime, replay still produces a
distinct room, no merge logic.

The contribution materialized hash is reset on the new room; the
event log starts fresh; participants list starts empty; workers
re-RSVP. The `replay_of` link lets the dashboard show the chain.

---

## Watcher behavior — agent runtime side

New plugin in agent runtime: `plugins_builtin/warroom/`.

### Two-job dispatch per room visible to a role

1. **Triage job** (cheap, ~30s LLM call):
   - Input: subject metadata + room event log slice + role description
   - Output: structured JSON `{decision: present | withdraw, reason, intent_hint?}`
2. **Heavy review job** (only if triage decided `present`):
   - Full agent stack (skills, MCP tools, etc.)
   - Output: structured contribution body + raw markdown
   - Watcher posts via `/contribute`

### Per-runner local state

Each runner tracks `last_event_sequence_seen` per room locally
(mirrors `agent/cli/hivemoot_agent/plugins_builtin/github` watch state
on disk). On each poll:

- Fetch `/api/rooms/watching` (server uses token-bound `agent_role`)
- For rooms with new events past `last_seen`: dispatch triage
- For rooms already RSVP'd at current sequence: skip
- Per-(room, role) exclusivity at backend: if `drone-runner-1` already
  RSVP'd, `drone-runner-2`'s POST `/present` returns 409 → runner-2's
  watcher logs and skips dispatch

### `agent_id` semantics (G5)

Every runner has a stable `agent_id` derived as
`sha256(installationId + ":" + agent_role + ":" + hostname +
":" + processStartTime)`.

`processStartTime` MUST be **the integer Unix epoch milliseconds at
process start** — `Date.now().toString()` for Node runners,
`str(int(time.time()*1000))` for Python runners (closes Queen R2 #4).
Pinned to one canonical format because two runners with the same
logical start time computing different formats (ISO vs epoch vs
hrtime) would derive different `agent_id`s and produce confusing
phantom 409s at the per-(room, role) gate.

In subscriber-mode fleets where multiple runners share one token:
each runner still gets a distinct `agent_id`, but the
per-(room, role) backend exclusivity gate ensures **only one of them
wins the RSVP** (first POST `/present` succeeds, others get 409 +
log + skip).

Why hostname+processStartTime: stable across the lifetime of a
runner's process (so retries from the same runner reuse the same id),
distinct between runners (no fleet-wide collisions), and survives
container restarts only by intent (a restarted runner gets a new id
and may re-RSVP if the prior one was timed out).

Recorded on the participant record as `agent_id` and on every event
the runner emits as `actor_agent_id`.

---

## Bot (queen) module behavior

Queen logic lives in `bot/api/lib/queen/`. Three responsibilities,
mapped to existing bot infrastructure:

### 1. GitHub event detection — webhook-driven (V1 primary)

The bot is already a Probot app receiving webhooks for every
installation. Existing handler dispatcher
(`bot/api/handlers/dispatcher.ts`) gains a new handler:
`war-room.handler.ts`. Events handled in V1:

- `pull_request.opened` / `reopened` → create `pr_review` room
- `pull_request.synchronize` → emit `subject_updated` on existing room
- `issue_comment.created` (PR comments mentioning the bot) → emit
  `subject_updated` on existing room or create `mention_response`

Webhook-driven means no polling token needed; the bot already has the
App-installation auth chain.

### 2. Event-to-room translation

The handler reads the event payload, decides the action (create vs.
update vs. ignore), and calls the shared `@hivemoot/war-room`
storage primitives directly via `bot/api/lib/war-room-store.ts`.
Per-tenant scoping comes from `payload.installation.id` — the bot
constructs a per-installation `WarRoomStore` per webhook, so
cross-tenant data never enters the call. No bearer token is held
by the bot; the bot's GitHub App identity is the load-bearing
trust boundary. (External callers — workers on the hive, CLI —
reach the same storage layer through hivemoot.dev's HTTP routes
with a V1 capability bearer; the bot bypasses that path.)

**Webhook-on-deciding-room behavior (closes Queen R2 #5).** When the
handler tries to write `subject_updated` and
`ROOM_APPEND_EVENT_SCRIPT` returns `{-2, "deciding"}` (status
precondition fail because queen has claimed the room), the bot:

1. Logs `webhook_deferred_room_deciding` (info level).
2. Enqueues the event to a per-room buffer
   `hive:v1:room:{roomId}:webhook-buffer` (Redis list, TTL 1 h),
   capped at 10 entries.
3. After queen completes (`/close` or sequence-drift unclaim), the
   manager loop drains the buffer atomically, emitting the buffered
   `subject_updated` events with fresh sequences. If queen drifted
   (`-2`), the drained events feed the next synthesis attempt
   naturally.

If the buffer fills (>10 entries during synthesis), oldest entries
are dropped with `webhook_buffer_overflow` warning (closes guard
R3 N9 — explicit accept of the trade-off). Cap=10 is sized for the
slow-cadence assumption: synthesis takes ≤6 min, ≤10 webhooks per
6 min on a single PR is rare even on actively-pushed PRs.

If V1 operations show legitimate overflow (e.g. on force-push
storms), three V1.1 mitigations are pre-spec'd:
- (a) Bump cap (Redis lists are cheap; 100 still bounded).
- (b) Coalesce same-event-type entries (10 force-pushes
  collapse to one "subject_updated" with the latest commit ref).
- (c) Per-event-type sub-buffers so e.g. comment-mention events
  don't displace push events.

V1 ships (a) at cap=10. Operators monitoring
`webhook_buffer_overflow_count` can prompt the V1.1 expansion if
the metric breaches a single-PR-per-day rate.

### 3. Manager loop — `is_room_ready()`

Driven by Vercel Cron at **2 minute interval** (Hobby/Pro tier
minimum; the prior 60 s claim was the design target before Vercel
Cron's tier limits became the binding constraint). The
`queen_tick_lag` watchdog metric pivots accordingly: alert when
the gap between scheduled and actual tick exceeds 360 s (= 3 ×
tick interval).

Calls a single bot endpoint `GET /api/queen/tick` that runs the
manager loop, iterating `app.eachInstallation()` so the cron
fires across every installation the bot's GitHub App is on
(no per-tenant bearer required). Two correctness gates wrap the
body:

**Endpoint authentication (closes guard A1).** The route requires
`Authorization: Bearer ${CRON_SECRET}` (Vercel Cron's documented
pattern; the env var is provisioned by Vercel and never exposed
publicly). Validation happens at the route boundary; missing or
mismatched bearer → 401 with no body. This prevents external
callers from forcing arbitrary synthesis ticks (which would burn
the installation's BYOK key on the operator's account).

**Tick serialization (closes Queen R3 #2).** Vercel Cron does not
guarantee non-overlapping invocations; a tick that runs longer
than 2 min could overlap with the next fire. The route acquires a
distributed lock at entry:

**Acquire** with `SET key runnerId NX EX 290`. **Release** with the
canonical Redlock compare-and-DEL pattern via a Lua script (NOT
`if acquired === runnerId then redis.del()` — `SET ... NX` returns
the string `"OK"` on success or `null` on contention, NOT the
stored value, so the JS-level comparison is always false; closes
guard R3 B6).

The release script (`QUEEN_TICK_LOCK_RELEASE_SCRIPT`):

```lua
-- KEYS: [lockKey]
-- ARGV: [runnerId]
-- Returns: 1 if released by this runner, 0 if lock held by someone
--          else (TTL expired and another runner re-acquired it)
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
```

Sequencing in the route:

```typescript
const lockKey = `hive:v1:lock:queen-tick:${installationId}`;
const acquired = await redis.set(lockKey, runnerId, "NX", { EX: 290 });
if (acquired === null) {
  // Contention — another tick is running. Skip cleanly.
  log.info("queen_tick_overlap_skipped", { installationId, runnerId });
  return new Response(null, { status: 200 });
}
try {
  await queenTick(installationId);
} finally {
  // Compare-and-DEL via the Lua script above. Atomic; a racing
  // fast-finishing tick can't accidentally release another
  // runner's lock.
  await callQueenTickLockReleaseScript(lockKey, runnerId);
}
```

290 s TTL is sized to leave a 10 s margin under Vercel's
`maxDuration: 300` for the function — the lock auto-releases via
TTL before the function's hard timeout, so a crashed runner can't
hold the lock past one fire. With the cron at 2-minute intervals,
the next fire happens BEFORE TTL expiry, so a still-running
predecessor produces clean contention (the next runner skips with
an info-level log line; no double LLM calls, no double GitHub
posts).

**The manager loop body:**

```typescript
async function queenTick(installationId: string) {
  // 1. Recovery branch (closes builder R2): scan deciding rooms,
  //    revert any whose claim has expired
  for (const room of await listRoomsByStatus(installationId, "deciding")) {
    const result = await callRecoverDecidingScript(room.id);
    if (result[0] === 1) {
      log.warn("recovered_stranded_deciding_room", {
        installationId, roomId: room.id, sequence: result[1],
      });
    }
    // result[0] === 0: claim still active, skip
    // result[0] === -1: status changed, skip
  }

  for (const room of await listOpenRooms(installationId)) {
    // 2. Expire rooms past max_age_secs (closes Queen R3 #1)
    if (room.age > room.max_age_secs) {
      await callTerminateRoomScript(room.id, "expired");
      continue;
    }

    // 3. RSVP quiet-period transition
    if (room.status === "awaiting_rsvp") {
      const lastRsvpAt = max(room.participants.map(p => p.rsvp_at))
                       ?? room.opened_at;
      if (now() - lastRsvpAt >= room.rsvp_quiet_period_secs * 1000) {
        await transitionToAwaitingContributions(room);
      }
      continue;
    }

    // 4. Synthesis when all RSVPs resolved
    if (room.status === "awaiting_contributions") {
      const unresolved = room.participants.filter(p => p.status === "pending");
      if (unresolved.length > 0) continue;

      // Per-room consecutive-failure backoff (closes guard M4)
      if (room.consecutive_synthesis_failures >= 3) {
        await callTerminateRoomScript(room.id, "failed_synthesis");
        log.error("room_marked_failed_synthesis", {
          installationId, roomId: room.id,
          failures: room.consecutive_synthesis_failures,
        });
        continue;
      }

      const claim = await tryDecideClaim(room.id);
      if (!claim.ok) continue;

      try {
        const synthesis = await synthesizeWithLLM(room, claim.throughSequence);
        await postOneGitHubAction(room, synthesis);
        const closeResult = await closeRoom(
          room.id, claim.throughSequence, synthesis,
        );
        if (closeResult[0] === -2) {
          // Sequence drift — new events arrived; re-enter on next tick.
          // ROOM_CLOSE_SCRIPT has already reverted status atomically
          // and SREM/SADD'd the status sets (closes guard B2).
          log.info("synthesis_drift_will_retry", {
            installationId, roomId: room.id, latestSeq: closeResult[1],
          });
        }
        // Reset failure counter on success or clean drift
        await resetFailureCounter(room.id);
      } catch (err) {
        await incrementFailureCounter(room.id);
        await unclaim(room.id);
        log.error("synthesis_attempt_failed", {
          installationId, roomId: room.id, err,
          consecutive: room.consecutive_synthesis_failures + 1,
        });
        // Don't rethrow — keep processing other rooms in the tick
      }
    }
  }
}
```

Per-room failure counter is stored on the room hash at field
`consecutive_synthesis_failures`. After 3 consecutive failures the
room is closed as `failed_synthesis` (the new closed-reason joins
`decided` / `expired` / `manual` / `force_close`). This bounds the
"persistent failure burns LLM credits forever" failure mode (closes
guard M4).

**Single-tick LLM-synthesis loop is bounded by the 5-minute Vercel
Pro `maxDuration` ceiling** (closes guard A3). At V1 scale (one Hive,
≤10 workers, ≤20 rooms-per-tick observed) this is fine. V1.1 fans
out: each ready-to-synthesize room becomes an enqueued task on a
serverless queue (Vercel Functions queue, Upstash Q, or similar);
each consumer handles one synthesis with its own 5-minute budget.
Documented as a known scaling inflection point, not blocking V1.

### Synthesis safety model (S2)

External PR text reaches queen synthesis through the worker
contributions. The synthesis prompt MUST treat worker-supplied content
as untrusted, and the verdict logic enforces a **structural
DOWNGRADE-only invariant** — not an LLM-policed one:

```typescript
type WorkerVerdict = "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES";

function aggregateWorkerVerdicts(contributions: Contribution[]): WorkerVerdict {
  const verdicts = contributions.map(c => c.body.verdict);
  // Verdicts are validated at /contribute write time (see §Worker
  // contribution body schema below); aggregation can rely on the
  // enum being well-formed.
  if (verdicts.includes("REQUEST_CHANGES")) return "REQUEST_CHANGES";
  if (verdicts.includes("CONCERNS"))        return "CONCERNS";
  if (verdicts.every(v => v === "APPROVE")) return "APPROVE";
  return "COMMENT";
}
```

The LLM synthesis writes the prose; the verdict it submits is **not
read** as a final decision. The structural rule above is the floor:
queen MAY downgrade APPROVE → COMMENT or COMMENT → REQUEST_CHANGES,
NEVER raise. This survives prompt-injection from PR content because
no PR content can talk one of the workers' verdicts upward — at
worst, a manipulated worker outputs APPROVE, and the structural
floor is set by the most-conservative actually-emitted verdict.

The synthesis prompt itself isolates worker content with delimiters
and the same untrusted-content posture documented in
`agent/cli/hivemoot_agent/plugins_builtin/github/prompts.py`. See
`bot/api/lib/queen/synthesis.ts` (Phase G' file) for the live prompt.

**State-bearing reviews are OFF in V1 as an architectural invariant,
not a config knob.** The first repo to opt into state-bearing must
land an explicit `bot/api/handlers/war-room/repo-trust-config.ts`
allow-list change and pass an independent reviewer canary period
(min 100 closed rooms in COMMENT mode with no operator override
recorded). This is documented for §17.G as part of the V1 floor.

### Worker contribution body schema (closes guard M2 + Queen R3 #4)

`POST /api/rooms/{id}/contribute` rejects unknown verdicts AND
unknown body shapes at write time, before queen synthesis ever runs.
The contract:

```typescript
interface ContributionBody {
  verdict: "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES";  // REQUIRED
  summary: string;                  // REQUIRED, 1–500 chars
  findings?: Finding[];             // OPTIONAL, ≤20 items
  severity_counts?: {
    blocker?: number;
    warning?: number;
    info?: number;
  };
}
interface Finding {
  area: string;                     // 1–80 chars
  severity: "blocker" | "warning" | "info";
  detail: string;                   // 1–2000 chars (subject to G2 raw_text cap)
  code_ref?: string;                // optional file:line reference
}
```

`POST /api/rooms/{id}/contribute` validates against this schema (Zod
or equivalent). Violations → 400 with explicit error code per field
(`MISSING_VERDICT`, `INVALID_VERDICT`, `SUMMARY_TOO_LONG`, etc.).
Queen synthesis can rely on the body being well-formed.

This closes the silent-downgrade trap where a missing/typo'd verdict
field would default to COMMENT inside `aggregateWorkerVerdicts`
without any operator-visible signal.

---

## Capability mapping (consistent with CAPABILITIES_DESIGN.md)

Capability vocabulary additions on top of the Phase B doc:

| Capability | Endpoints |
|---|---|
| `rooms.read` | `GET /api/rooms/{id}`, `GET /api/rooms/{id}/events` |
| `rooms.watch` | `GET /api/rooms/watching` |
| `rooms.contribute` | `POST /api/rooms/{id}/{present,withdraw,contribute}` |
| `rooms.create` | `POST /api/rooms` |
| `rooms.update` | `POST /api/rooms/{id}/event` (subject_updated, queen_question) |
| `rooms.decide` | `POST /api/rooms/{id}/decide`, `DELETE /api/rooms/{id}/claim` |
| `rooms.close` | `POST /api/rooms/{id}/close` |
| `rooms.force_close` | `POST /api/rooms/{id}/force-close`, `POST /api/rooms/{id}/replay` |

Preset wiring:

| Token role / preset | Capabilities (delta from Phase B presets) |
|---|---|
| `worker` (drone, builder, guard, etc.) | + `rooms.watch`, `rooms.read`, `rooms.contribute` |
| `queen` (bot's room-management token) | + `rooms.read`, `rooms.create`, `rooms.update`, `rooms.decide`, `rooms.close` |
| `monitoring` (operator read-only) | + `rooms.read` |
| `admin` (operator) | + `rooms.read`, `rooms.force_close` |

Note: `worker` does **not** include `rooms.create`. Only the queen
(bot) creates rooms. This holds even after Phase C `allowed_permissions`
ships; `worker` tokens cannot mint room creation.

---

## Stuck-room watchdog and observability (G4)

The 2-minute background watchdog is the only thing that moves
rooms out of `awaiting_contributions` when a worker doesn't
contribute. Failure of the watchdog → rooms accumulate silently.
V1 ships:

### Health metrics (Vercel Cron + observability)

| Metric | Source | Alert threshold |
|---|---|---|
| `rooms_past_max_age_count` | scan `hive:v1:idx:room:status:*` filtered by `opened_at` | > 0 for > 5 min |
| `time_since_last_timeout_emit` | bot-side counter, reset on each emit | > 10 min when there are pending RSVPs |
| `queen_tick_lag` | wall-clock drift between scheduled and actual tick | > 360s (3× 2-minute tick interval) |
| `claim_held_too_long` | scan `hive:v1:room:*:claim` ages | any claim > 6 min (= TTL) |

Alerts wire into the same channel the dashboard's existing
Vercel/Upstash health observability uses. Non-blocking V1 — V1.1
adds them to a Vercel Analytics sink.

### Dashboard "Active rooms" view (default sort)

`/dashboard/rooms` defaults to "Active rooms by stuck-ness" — sort
by `(now - last_event_at) DESC`, color rows red if past
`rsvp_contribution_timeout_secs * 0.8`. Operators see stuck rooms
without applying filters. Same view as the original draft, default
sort changed.

---

## Force-close vs queen mid-decide race (S5)

Force-close on a `deciding` room MUST NOT silently let queen finish
and post the GitHub action.

`POST /api/rooms/{id}/force-close` calls
`ROOM_TERMINATE_SCRIPT(roomId, terminalEventJson, closedAt,
retentionSecs, "force_close")` — the unified terminate path
(builder R3 #2). The script:

- Atomically `DEL`s `hive:v1:room:{roomId}:claim` if held (covers
  the `status == deciding` case naturally — queen's mid-flight
  `/close` returns `{-3, "claim_lost"}` and aborts).
- Sets `status → closed`, `closed_reason → "force_close"`.
- Releases subject index, removes from per-installation /
  per-status / per-repo indexes.
- Sets retention TTLs on all sibling keys.
- Returns `{-1, "closed"}` if already closed (operator double-tap)
  → caller surfaces 409 `ROOM_ALREADY_CLOSED`.

Queen's `/close` script (`ROOM_CLOSE_SCRIPT`) checks the claim still
exists before posting. If the claim was deleted by force-close, queen's
`/close` returns `{-3, "claim_lost"}`, queen logs and ABORTS the
GitHub-post (catches the race window where queen has already posted to
GitHub but hasn't recorded it). For V1 this is acceptable: a small
window where queen's GitHub post goes out and force-close still wins
the room state. Mitigation: queen MUST check claim validity
immediately before the GitHub POST and short-circuit if invalid.

```typescript
async function postSynthesis(room, claim) {
  if (!await claimStillValid(room.id, claim)) {
    log("claim_lost_pre_post"); return;
  }
  await octokit.pulls.createReview({...});
  // close attempt may still race; that's OK — at most we double-close,
  // not double-post
  await closeRoom(...);
}
```

Operators using force-close on a `deciding` room get a UI warning:
*"Queen may already have posted to GitHub; check the PR for a recent
review before treating this as cancelled."*

---

## Worker read-only is a Phase C postcondition (S3)

The "workers physically cannot write to GitHub even if compromised"
property is **only true after apiarist V1.6** (`allowed_permissions`)
is in production for every worker installation. Until then, war-room
workers still mint full-permission installation tokens via
`installation_token.mint`.

**War-room V1 does not roll out to production until apiarist V1.6 has
shipped to every fleet running war-room workers.** This is an
architectural invariant of V1, not a config knob:

- The first repo to opt into war-room rollout MUST have apiarist V1.6
  enabled on its installation.
- The deploy-time check in `apiary/deploy-apiary.sh` rejects
  enabling `war_room: true` on a service whose `apiary.secrets.yaml`
  doesn't carry an `agent_token_name` resolving to a token with
  `allowed_permissions` set.

During the rollout window (apiarist V1.6 partially shipped), the
threat model is materially different: a compromised worker still has
write access to the full installation. The doc names this honestly so
the security posture isn't overclaimed.

---

## Future variants

### Standalone queen agent (post-V1 follow-up — see task #123)

Bot-as-queen wins on V1 simplicity but trades on a few axes that may
become load-bearing later. The standalone variant moves queen logic
out of the bot into a dedicated container running alongside
drone/builder/guard, reusing the agent runtime infrastructure. Worth
revisiting when:

- BYOK cost attribution surfaces problems (e.g. one installation's
  queen LLM bill drowns out the bot's own webhook handling cost in
  the same accounting bucket; a separate token + separate accounting
  fixes this).
- Bot deploy cadence collides with queen iteration speed (the
  synthesis prompt needs frequent tuning; bot deploys are tied to
  Vercel cycles).
- Provider lock-in pain (bot uses one LLM provider per installation;
  standalone queen could run a different model per repo or per
  installation under one queen image).
- Blast-radius incidents where bot crash takes down both webhook
  handling AND synthesis simultaneously prove costly.

The standalone variant would reuse: war-room API surface (unchanged),
capability vocabulary (`queen` preset already maps), `agent_role` =
`"queen"` envelope binding (already enforced server-side, so workers
can't suddenly become queen). What changes: `queen_tick` moves from
Vercel Cron to a dispatch-task-watcher-like loop in the agent
runtime; webhook reception moves from native Probot to a polling
adapter on hivemoot.dev's webhook event log. Roughly 3-5 days of
refactor work if/when it's needed; the API contract is stable.

### V1.1 follow-ups (already in the ultra plan)

- Bot-pushed fast-path on top of webhooks (current V1 IS bot-pushed)
- M-of-N quorum policies
- Queen-question (queen asks specific worker for clarification)
- Cross-installation rooms (deferred indefinitely)
- Sharded queen (deferred until single-queen capacity strain)

---

## V1 minimum scope

To ship FAST, V1 cuts:

1. **Backend** — Redis storage + Lua scripts + API endpoints (CRUD +
   present/withdraw/contribute/decide/close + watching) + watchdog
   driver. ~3-4 days.
2. **Apiarist V1.6** (allowed_permissions) — read-only worker tokens.
   Phase C. **Hard-gates V1 prod rollout per §16.**
3. **Agent runtime** — `war-room-watcher` plugin parallel to
   dispatch-task-watcher. Two-job triage + heavy. ~2-3 days.
4. **Bot queen module** — `bot/api/lib/queen/` synthesis prompt +
   manager loop + webhook handler entry. ~2-3 days. (Replaces the
   original "queen agent" line item.)
5. **CLI** — `hivemoot rooms list/get/contribute/events/watch`
   minimum. ~1 day.

Cuts: dashboard UI (use CLI for V1), replay, queen_question
events, complex quorum policies, intent_hint requirement. All
deferrable.

Force-close is **kept in V1** because `ROOM_TERMINATE_SCRIPT`
covers it as a single code path alongside the
expired/failed_synthesis paths the watchdog already needs (closes
builder R3 #2 — the original "cut force-close" line was leftover
from R3, but R4's unified terminate script makes it a free
addition). Operator surface: CLI `hivemoot rooms force-close <id>`
+ dashboard button (Phase I).

V1 total: 1.5-2 weeks of focused work, parallelizable across surfaces.
Bot-as-queen saves ~1-2 days vs the standalone-agent variant
(no new container, no new systemd unit, no new image build pipeline).

---

## Open design questions

These need a decision before code lands. Recommended answers in
parentheses (most carry over from the original draft; deltas marked
with **CHANGED**).

### A. Subject-updated → new room or update existing?

Update existing if open, new room if previous closed. Replay (§14)
gets its own explicit endpoint; not the same as subject-update.

### B. Re-contribution — append or replace contribution body?

Replace in `hive:v1:room:{roomId}:contributions` materialized hash; events
sorted set preserves audit history regardless.

### C. Bot-pushed vs queen-polled? **CHANGED**

Bot-pushed only in V1. Queen polling is removed from scope — the bot
already has webhook reception, polling adds a credential-exposure
surface (broad PR/issue/comment read scope across all installations)
and breaks the "single visible identity" simplicity. Polling is
documented as the standalone-queen-variant future fallback (§17).

### D. Triage as separate LLM call or single-call early-exit?

Separate triage call. Cheap model, short prompt; cleanly-separated
RSVP improves observability.

### E. Quorum policy when not all participants contribute?

V1 — strict "all RSVPs resolved" + `max_age_secs` ceiling. M-of-N
quorum can land V1.1.

### F. Naming — "war room" / "moot" / something else?

Keep "war room" — clear, distinct from task, evocative of multi-
perspective coordination. `moot` is on-brand but ambiguous (could
mean "irrelevant"). Decide before merging this design doc.

### G. Queen's review state default — comment vs state-bearing?

V1 hard architectural invariant: COMMENT mode only. Per-repo opt-in
to state-bearing requires explicit allow-list change + canary
(§Synthesis safety model). NOT a config knob.

### H. RSVP quiet period default?

60s. Configurable per room.

### I. RSVP-to-contribution timeout default?

`pr_review`: 30 min. `mention_response`: **10 min** (raised from
draft's 5 min — heavy review jobs can take 2-3min just to spin up
the agent stack; 5 min created false timeouts in dry-run thinking).
`issue_triage`: 30 min.

**Interaction with `max_age_secs` (closes Queen R3 I)**: when both
deadlines apply to a single participant, **whichever fires first
wins**. `max_age_secs` is room-scoped (set at open) and
`rsvp_contribution_timeout_secs` is per-participant (counted from
that participant's RSVP timestamp). A worker that RSVPs at T+25min
in a 30-min room has 5 min until `max_age_secs` and a full 30 min of
`rsvp_contribution_timeout_secs` — the room expires at T+30min,
which terminates ALL pending participants regardless of their
individual contribution-timer state. The watchdog and the manager
loop both check `max_age_secs` first; participant timeouts only
fire on rooms still within the age ceiling.

### J. Single queen instance vs sharded?

Single queen for V1. The bot is single-instance per Vercel deploy
already. Queen-restart safety is a **two-step** sequence (closes
guard R4 #2 + builder R4 #2): the 6-minute claim TTL on
`hive:v1:room:*:claim` deletes the claim KEY when queen crashes
mid-synthesis, but the room hash + status set remain in `deciding`
state. The actual revert happens on the next manager-loop tick: the
recovery branch scans `hive:v1:idx:room:status:{installationId}:deciding`,
calls `ROOM_RECOVER_DECIDING_SCRIPT` per stranded room (which
returns `{0, "claim_active"}` for rooms whose claim still exists,
or `{1, sequence}` for rooms with expired claims — atomically
reverts hash + status sets to `awaiting_contributions` and emits a
recovery event). See §Atomic operations / `ROOM_RECOVER_DECIDING_SCRIPT`
+ §Manager loop / "Recovery branch."

No `/unclaim` endpoint exposed publicly; queen's own abort path uses
`DELETE /api/rooms/{id}/claim` (queen-only capability).

---

## What this unlocks

- **Drone, builder, guard collapse** to a clean architectural shape — workers
  contribute, bot synthesizes, single visible identity, no review-state
  conflict
- **Adding new agents is additive** — new role, new participant in rooms,
  no GitHub identity to register, no queen logic to update
- **Mention routing solved** — bot dispatches mention events as
  `mention_response` rooms; bot translates the mention into worker
  triage prompts; specific agents RSVP based on what the mention asks
- **Read-only worker tokens** — combined with Phase C (apiarist V1.6),
  workers physically cannot write to GitHub even if compromised; only
  the bot has write. *Note: this property holds only AFTER V1.6 ships
  fleet-wide; see §16.*
- **Operator visibility** — full event log per room, replay,
  force-close, dashboard view; no more "is drone working?" mystery
- **Foundation for future coordination** — incident response rooms,
  multi-PR refactor coordination rooms, etc. all build on the same
  primitive
- **No new infrastructure** — bot-as-queen reuses existing Probot +
  BYOK + Vercel Cron stack; war-room state lives in existing Upstash
  Redis. Zero new services, zero new credentials, zero new deploy
  pipelines for V1.
