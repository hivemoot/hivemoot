# War Room — Design

> Status: design proposal (Phase D of the post-apiarist-V1 ultra plan).
> Scope: chat-style, RSVP-driven multi-agent coordination space, **bot-managed**.
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
create-or-update the room, (3) collect contributions over RSVP +
contribution windows, (4) synthesize via LLM, (5) post one GitHub
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
| Failure blast radius | Queen down → no synthesis (workers still RSVP) | Bot down → no webhooks AND no synthesis |
| Operational surface | One more systemd service, one more container | Zero new services |

The trade we make by going bot-as-queen: **bot crashes take down
synthesis along with webhook handling** (vs standalone queen which
fails independently). For a single-Hive single-bot V1 this is
acceptable; both share the same Vercel deploy lifecycle anyway.

### Decision

**V1 ships bot-as-queen.** Queen logic lives in
`bot/api/lib/queen/` — synthesis prompt, manager loop, and HTTP
clients to the war-room API on hivemoot.dev. The bot's existing
webhook handler dispatches `pull_request.opened` etc. to a queen
"create-room" routine. A scheduled background job (Vercel Cron or
similar) drives the manager loop on a 30s tick to advance rooms past
their RSVP/contribution windows.

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
- **RSVP-driven** — agents self-select participation; queen doesn't need
  a fleet roster
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
- **Participants**: agents that RSVP'd to contribute
- **Contributions**: per-role analyses (latest-per-role-per-room)
- **Status state machine**: `awaiting_rsvp` → `awaiting_contributions`
  → `deciding` → `closed` (or `expired`)
- **Decision**: bot's final synthesis + the GitHub action taken
  (with metadata for audit)

Workers don't watch GitHub directly; they watch war rooms via a new
agent runtime trigger (`war-room-watcher`). The bot watches GitHub
events (via Probot webhook) and translates them into war room
creation or update events.

---

## RSVP-driven lifecycle (canonical)

Per the architectural decision: queen does NOT pre-declare expected
roles. Workers self-select via RSVP, queen waits for whoever showed up.

```
T+00:00  Bot webhook: pull_request.opened on hivemoot/colony#456
         Bot calls POST /api/rooms (queen module, bot-side)
         Event #1: room_opened (actor=bot)
         Room status: awaiting_rsvp

T+00:01  Workers' war-room-watchers poll /api/rooms/watching
         Each worker dispatches a TRIAGE job (cheap/fast LLM):
           input  = subject + room event log + role description
           output = JSON {decision: present|withdraw, reason, intent_hint?}

T+00:05  Drone triage → present
         POST /api/rooms/{id}/present  (intent_hint: "architecture impact")
         Event #2: participant_present (role=drone, agent_id=drone-runner-1)
         Per-(room, role) exclusivity: only one runner per role

T+00:08  Builder triage → present
         POST /api/rooms/{id}/present
         Event #3: participant_present (role=builder)

T+00:10  Guard triage → present
         POST /api/rooms/{id}/present
         Event #4: participant_present (role=guard)

T+00:15  Heater triage → withdraw (subject is architectural, not test-related)
         POST /api/rooms/{id}/withdraw  (reason: "not in scope")
         Event #5: participant_withdrew (role=heater)

T+00:30  Drone heavy review completes (RSVP'd workers may contribute
         during awaiting_rsvp — see §3 for state-machine note):
         POST /api/rooms/{id}/contribute
         Event #6: contribution (role=drone, body=structured, raw_md=full)

T+01:00  Builder contributes
         Event #7: contribution (role=builder)

T+01:15  Quiet period elapses (60s past last RSVP at T+00:15)
         Bot manager loop transitions room: awaiting_contributions
         Active RSVPs: drone, builder, guard
         Resolved (already contributed): drone, builder
         Pending: guard

T+31:15  Guard still hasn't contributed
         RSVP-to-contribution timeout (default 30 min) elapsed for guard
         Bot watchdog emits Event #8: participant_timed_out (role=guard)

T+31:16  Bot manager loop sees: all RSVPs resolved
         POST /api/rooms/{id}/decide  (claims synthesis atomically)
         Bot reads contributions, runs LLM synthesis with isolation
           prompt (see §11), posts ONE PR review on hivemoot/colony#456
           in COMMENT mode (V1 default — see §11 / §17.G)
         POST /api/rooms/{id}/close
         Event #9: queen_decision + Event #10: room_closed
```

Two state-machine notes the original draft was loose about:

- **Workers MAY contribute during `awaiting_rsvp`** as long as they
  have RSVP'd. The room status governs which transitions queen can
  make, not whether workers can contribute. Backend accepts
  `/contribute` for any RSVP'd role in `awaiting_rsvp` or
  `awaiting_contributions`. This matches the canonical timeline
  (drone contributing at T+00:30, before quiet period elapses at
  T+01:15).
- **Quiet-elapse timestamp** is computed from the last RSVP event,
  not the room open time. Last RSVP at T+00:15 + 60s quiet =
  T+01:15.

The key shift from a pre-expected-roles model: queen's "ready to
synthesize" is **data-driven from RSVPs**, not config-driven from a
roster. Adding a new agent role doesn't require updating queen.

---

## Storage layout (Redis / Upstash)

The project's storage backend is Upstash Redis with `@upstash/redis`
client; see `web/src/server/redis.ts`, `web/src/server/agent-token.ts`,
`web/src/server/task-store.ts`. There is no SQL database, no ORM, no
`DATABASE_URL`. War rooms reuse this stack — no new infrastructure
dependency.

The earlier draft of this doc presented PostgreSQL schemas. Those have
been re-expressed below as Redis structures. Multi-key atomicity is
preserved via Lua scripts (same pattern as `ROTATE_TOKEN_SCRIPT` /
`REVOKE_TOKEN_SCRIPT` in `agent-token.ts`).

### Key shape

| Key | Type | Purpose |
|---|---|---|
| `hive:room:{installationId}:{roomId}` | hash | Room core record (status, manager, subject_ref, timing config, decision once closed) |
| `hive:room-events:{roomId}` | sorted set | Event log; member = event JSON, score = sequence number |
| `hive:room-event-by-key:{roomId}:{idempotencyKey}` | string | Idempotency reverse index → sequence number (TTL = `max_age_secs * 2`) |
| `hive:room-participants:{roomId}` | hash | Materialized RSVP per role: `{role → JSON {agent_id, status, rsvp_at, resolved_at}}` |
| `hive:room-contributions:{roomId}` | hash | Materialized latest-per-role contributions: `{role → JSON {body, raw_md, contributed_at}}` |
| `hive:room-seq:{roomId}` | counter | Monotonic event sequence (`INCR` per event) |
| `hive:room-by-subject:{installationId}:{subjectType}:{subjectRef}` | string | Open-room idempotency: → `{roomId}` while room is in `awaiting_rsvp \| awaiting_contributions \| deciding`; deleted on close |
| `hive:rooms-by-installation:{installationId}` | sorted set | Room IDs by `opened_at`; for `GET /api/rooms` filtering |
| `hive:rooms-by-status:{installationId}:{status}` | set | Room IDs at this status; rebuilt on every transition. Used by manager loop's "rooms to advance" scan |
| `hive:room-claim:{roomId}` | string | Synthesis claim: → `{queenRunner, claimedThroughSequence}`. TTL = 5 min (auto-revert on queen crash — see §15) |

All keys live behind the `hive:` namespace already in use. Eviction:
rooms set explicit TTL on close = 30 days for audit retention; events,
participants, contributions inherit room TTL via paired `EXPIRE` calls
in the close Lua script. The `hive:room-seq:{roomId}` counter and
`hive:room-event-by-key:*` indexes get the same TTL treatment so
nothing leaks.

### Atomic operations (Lua)

**`ROOM_OPEN_SCRIPT`** — opens a room IF no open room exists for the
subject. Prevents duplicate-open race for the same `(installationId,
subjectType, subjectRef)`.

```lua
-- KEYS: [subjectIndexKey, roomKey, eventsKey, statusSetKey, allRoomsKey]
-- ARGV: [installationId, roomId, subjectType, subjectRef, roomJson,
--        roomOpenedEventJson, openedAt]
local existing = redis.call("get", KEYS[1])
if existing then return {0, existing} end
redis.call("set", KEYS[1], ARGV[2])
redis.call("hset", KEYS[2], "data", ARGV[5])
redis.call("zadd", KEYS[3], 1, ARGV[6])
redis.call("sadd", KEYS[4], ARGV[2])
redis.call("zadd", KEYS[5], ARGV[7], ARGV[2])
return {1, ARGV[2]}
```

Returns `{1, roomId}` on success, `{0, existingRoomId}` on conflict.
Caller maps `{0, ...}` to a 409 with `existingRoomId` in the body.

**`ROOM_APPEND_EVENT_SCRIPT`** — append event idempotently with
monotonic sequence. Updates participant or contribution materialized
view depending on event_type. Closes G7 (background-job + status-
transition concurrency).

```lua
-- KEYS: [seqKey, eventsKey, idemKey, roomKey, materializedKey, statusFromSetKey, statusToSetKey]
-- ARGV: [eventJsonTemplate, idempotencyKey, eventType,
--        materializedFieldName, materializedFieldJson,
--        roomStatusFrom, roomStatusTo, roomId]
-- Returns: {newSequence} on success; {-1, existingSequence} on idempotency
--          replay; {-2, currentRoomStatus} on status precondition fail.
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
  redis.call("set", KEYS[3], tostring(seq), "EX", 7776000)  -- 90d
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

**`ROOM_DECIDE_CLAIM_SCRIPT`** — atomically claim synthesis.

```lua
-- KEYS: [roomKey, claimKey, statusSetAwaitingKey, statusSetDecidingKey, lastSeqKey]
-- ARGV: [roomId, queenRunner, claimTtlSecs]
-- Returns: {1, currentSeq} on claim; {0, claimingRunner} if already claimed;
--          {-1, currentStatus} if status is not awaiting_contributions.
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

Closes S4 (`/decide` atomicity). The claim has a 5-minute TTL so a
queen crash mid-synthesis auto-reverts.

**`ROOM_CLOSE_SCRIPT`** — close with sequence-consistency check.

```lua
-- KEYS: [roomKey, claimKey, lastSeqKey, statusSetDecidingKey, subjectIndexKey, eventsKey,
--        participantsKey, contributionsKey, idemKey]
-- ARGV: [roomId, expectedThroughSequence, decisionJson, closedEventJson, closedAt,
--        retentionSecs]
local claim = redis.call("get", KEYS[2])
if not claim then return {-3, "claim_lost"} end
local parsed = cjson.decode(claim)
if tonumber(parsed.throughSequence) ~= tonumber(ARGV[2]) then
  return {-3, "claim_throughSeq_mismatch"}
end
local lastSeq = tonumber(redis.call("get", KEYS[3])) or 0
if lastSeq ~= tonumber(ARGV[2]) then
  -- New events arrived during synthesis → unclaim, re-enter awaiting_contributions
  redis.call("del", KEYS[2])
  redis.call("hset", KEYS[1], "status", "awaiting_contributions")
  return {-2, lastSeq}
end
redis.call("hset", KEYS[1], "status", "closed",
                          "decision", ARGV[3], "closed_at", ARGV[5])
redis.call("zadd", KEYS[6], lastSeq + 1, ARGV[4])
redis.call("incr", KEYS[3])
redis.call("del", KEYS[2])
redis.call("del", KEYS[5])
redis.call("srem", KEYS[4], ARGV[1])
redis.call("expire", KEYS[1], tonumber(ARGV[6]))
redis.call("expire", KEYS[6], tonumber(ARGV[6]))
redis.call("expire", KEYS[7], tonumber(ARGV[6]))
redis.call("expire", KEYS[8], tonumber(ARGV[6]))
return {1, lastSeq + 1}
```

Closes S4 (sequence-consistency on `/close`). Returns `-2` on
sequence drift → caller (queen) re-enters synthesis.

### Why Redis is sufficient for V1

The relational queries the original SQL design relied on (list by
status, filter by repo, join events + participants) decompose into
narrow Redis lookups:

- "List open rooms in installation X" → `SMEMBERS
  hive:rooms-by-status:{X}:awaiting_rsvp ∪ awaiting_contributions ∪
  deciding`, then `HMGET` per room key.
- "List rooms by repo" → fetched set intersected against a per-repo
  index `hive:rooms-by-repo:{installationId}:{owner}/{repo}` (added
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

Where `sequenceObservedByClient` is either the most recent sequence
the client has acknowledged (sent in a `If-Room-Sequence-At-Or-After`
header) OR a server-fresh `INCR`-derived counter when the client
omits the header. Clients MAY send their own idempotency key in
`Idempotency-Key` header for local retry safety, but the **server
verifies it equals the canonical key** and rejects mismatches with
`400 INVALID_IDEMPOTENCY_KEY`.

Why this matters: a buggy or hostile client supplying static keys
causes 409 retry storms; supplying unique-per-attempt keys defeats
idempotency and double-writes contributions. Server-canonical keys
make both impossible.

### Sequence ordering with concurrent writers (Queen #3)

`hive:room-seq:{roomId}` is a Redis counter. Every event acquires its
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

All endpoints live on hivemoot.dev. The bot (queen) reaches them via
HTTP from the Vercel deployment; workers reach them via the agent
runtime's existing HTTP plumbing.

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

Background watchdog (V1): bot-side cron-driven scan every 60s of
`hive:rooms-by-status:{installationId}:awaiting_contributions`. For
each room, check participants past their RSVP-to-contribution timeout
→ emit `participant_timed_out` (transitionless event); also check
rooms past `max_age_secs` → close with `expired` reason.

The `GET /api/rooms/watching` endpoint **uses the token's bound
`agent_role` server-side**, no `role` query parameter needed. The
old `?role={role}` query parameter is removed (closes the original
draft's `role={role}` vs `role=$AGENT_ID` typo + the server-side
role-spoofing risk). Returns: open rooms in `awaiting_rsvp` or
`awaiting_contributions` for the token's installation, EXCLUDING
rooms where this role has already RSVP'd at the current sequence.

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
the partial uniqueness invariant (`hive:room-by-subject:*` is held
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
":" + processStartTime)`. In subscriber-mode fleets where multiple
runners share one token: each runner still gets a distinct
`agent_id`, but the per-(room, role) backend exclusivity gate ensures
**only one of them wins the RSVP** (first POST `/present` succeeds,
others get 409 + log + skip).

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
update vs. ignore), and POSTs to the war-room API on hivemoot.dev
using a **bot-scoped agent token** (capability set:
`{rooms.create, rooms.read, rooms.update, rooms.decide, rooms.close,
agent_role: "queen"}`). The token is stored in Vercel env per the
existing pattern.

### 3. Manager loop — `is_room_ready()`

Driven by Vercel Cron (or equivalent scheduler) at 30s interval.
Calls a single bot endpoint `POST /api/internal/queen/tick` that
runs the manager loop:

```typescript
async function queenTick() {
  for (const room of await listOpenRooms(installationId)) {
    if (room.age > room.max_age_secs) {
      await closeAsExpired(room);
      continue;
    }

    if (room.status === "awaiting_rsvp") {
      const lastRsvpAt = max(room.participants.map(p => p.rsvp_at)) ?? room.opened_at;
      if (now() - lastRsvpAt >= room.rsvp_quiet_period_secs * 1000) {
        await transitionToAwaitingContributions(room);
      }
      continue;
    }

    if (room.status === "awaiting_contributions") {
      const unresolved = room.participants.filter(p => p.status === "pending");
      if (unresolved.length > 0) continue;

      const claim = await tryDecideClaim(room.id);
      if (!claim.ok) continue;  // someone else claimed (shouldn't happen V1)

      try {
        const synthesis = await synthesizeWithLLM(room, claim.throughSequence);
        await postOneGitHubAction(room, synthesis);
        await closeRoom(room.id, claim.throughSequence, synthesis);
      } catch (err) {
        await unclaim(room.id);  // free the room for the next tick
        throw err;
      }
    }
  }
}
```

### Synthesis safety model (S2)

External PR text reaches queen synthesis through the worker
contributions. The synthesis prompt MUST treat worker-supplied content
as untrusted, and the verdict logic enforces a **structural
DOWNGRADE-only invariant** — not an LLM-policed one:

```typescript
function aggregateWorkerVerdicts(contributions: Contribution[]): Verdict {
  const verdicts = contributions.map(c => c.body.verdict);
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

The 60s background watchdog is the only thing that moves rooms out of
`awaiting_contributions` when a worker doesn't contribute. Failure of
the watchdog → rooms accumulate silently. V1 ships:

### Health metrics (Vercel Cron + observability)

| Metric | Source | Alert threshold |
|---|---|---|
| `rooms_past_max_age_count` | scan `hive:rooms-by-status` filtered by `opened_at` | > 0 for > 5 min |
| `time_since_last_timeout_emit` | bot-side counter, reset on each emit | > 10 min when there are pending RSVPs |
| `queen_tick_lag` | wall-clock drift between scheduled and actual tick | > 90s (3× tick interval) |
| `claim_held_too_long` | scan `hive:room-claim:*` ages | any claim > 5 min (= TTL) |

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

`POST /api/rooms/{id}/force-close` semantics:

```
if status in {awaiting_rsvp, awaiting_contributions}:
  emit room_closed{reason: 'force_close', actor: operator}
  status → closed; release subject index; close
elif status == deciding:
  DEL hive:room-claim:{roomId}  # invalidate queen's claim
  emit room_closed{reason: 'force_close_during_decide', actor: operator}
  status → closed; release subject index; close
elif status in {closed, expired}:
  return 409 ROOM_ALREADY_CLOSED
```

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

Cuts: dashboard UI (use CLI for V1), replay, force-close,
queen_question events, complex quorum policies, intent_hint
requirement. All deferrable.

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

Replace in `hive:room-contributions:*` materialized hash; events
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

### J. Single queen instance vs sharded?

Single queen for V1. The bot is single-instance per Vercel deploy
already. Queen-restart safety: the 5-minute claim TTL on
`hive:room-claim:*` auto-reverts a `deciding` room to
`awaiting_contributions` if queen crashes mid-synthesis
(§Storage layout / `ROOM_DECIDE_CLAIM_SCRIPT`). No `/unclaim`
endpoint exposed publicly; queen's own abort path uses
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
