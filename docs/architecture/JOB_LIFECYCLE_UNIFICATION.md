# RFC: Unify task and war-room job execution

**Status:** Decisions reached — see "Decisions" section below.
**Author:** dkjazz (via this PR)
**Reviewers consulted:** the fleet (guard, drone). Synthesized verdict + reasoning recorded inline.

---

## Why this RFC exists

After landing PRs #609 / #610 / #611, agents now post free-form markdown to war rooms; the queen LLM-derives the verdict via Zod-enum `generateObject`. The simplification surfaced an observation that's been quietly true for a while:

> From the engine subprocess's perspective, running a task and running a war-room triage are **identical**. The engine spawns, runs a prompt, captures stdout, exits. It doesn't know — and shouldn't know — whether it's executing a task or a triage.

Yet the plugin layer has two parallel pipelines (`tasks/` and `war_rooms/`) with duplicated lifecycle wiring (heartbeat threading, retry policy, post-failure callbacks, signal handling). One has heartbeats; the other doesn't, by accident. The reporters (`tasks/api.py`, `war_rooms/api.py`) are bespoke even though they do the same thing — POST a payload with bearer auth.

This RFC asks: **what's the right factoring to unify the engine-side lifecycle while keeping per-domain wire translation pluggable?**

## What's already shared

- `Job` interface (`prompt`, `session_key`, `metadata`)
- `AgentResult` (exit code + captured stdout)
- Engine subprocess spawning (`engine.py`)
- `result_extractor.py` (NDJSON-aware stdout parsing)
- `auth.py::resolve_agent_token`
- HTTP transport (urllib + bearer header)

## What varies per domain (three axes)

| Axis | Tasks | War rooms | Owns |
|---|---|---|---|
| **Trigger** | polls `/api/tasks/claim` | polls `/api/rooms/watching` | discovering work, building `Job` |
| **Prompt builder** | `tasks/system_prompt.py` + claim-payload instructions | `war_rooms/triage.py::build_triage_prompt` | what the engine is told to do |
| **Reporter** | `post_complete\|fail\|heartbeat\|progress` | `present + submit_contribution\|withdraw` | how the result lands server-side |

(One could argue **result extraction** is a fourth axis. Today it's shared, but task results and contribution prose are different shapes; per-domain extractors might be cleaner.)

## Proposal: lifecycle multiplexer + reporter protocol

```python
class JobLifecycleReporter(Protocol):
    """Domain-specific server-side reporting for a single Job."""
    def on_start(job: Job) -> None: ...
    def on_heartbeat(job: Job) -> None: ...
    def on_progress(job: Job, text: str) -> None: ...
    def on_finish(job: Job, output: str) -> None: ...
    def on_failure(job: Job, exc: Exception) -> None: ...
```

Engine runtime owns:
- Heartbeat thread (uniform interval, restart on token rotation)
- Retry policy + post-failure callback wiring
- Signal handling, timeout enforcement
- The **multiplexer**: `(JobMatcher, ReporterFactory)` registry. On `Job` arrival, pick the first matching reporter and drive its lifecycle.

Per-domain plugins supply:
- A `JobMatcher` predicate (`is_war_room_job(job)` etc.)
- A `ReporterFactory` that constructs the per-job reporter
- Their trigger + prompt builder (unchanged)

Adding a new job type later (e.g. an "investigation" thread, a "long-running goal tracker") is one new file: register a reporter, ship a trigger and a prompt builder. No touching the runtime.

## Open questions for the fleet

I'd value perspectives on these specifically — pick whichever you have an opinion on:

**Q1.** Keep tasks and rooms as **separate plugins** with shared substrate, OR collapse them into a single **Job primitive** at the API layer too (one endpoint family, one storage pattern, one capability scope)?

**Q2.** Reporter shape — `Protocol` (duck-typed), abstract base class with default no-ops, or explicit `attrs`-style frozen config? Each has Python-runtime implications I'd rather hear from someone who's debugged plugin wiring before.

**Q3.** Heartbeat semantics:
- Today tasks heartbeat every 45s with no payload (just liveness).
- Should the room heartbeat carry partial-progress text so dashboards can stream "agent is currently investigating /api/auth/login"?
- If yes, does that fold the `on_progress` and `on_heartbeat` hooks into one?

**Q4.** Result extraction — keep it shared (current `result_extractor.py`), make it per-domain (pluggable via the reporter), or push it into the engine itself (engines emit a structured envelope)?

**Q5.** Migration strategy:
- (a) **In-place refactor** — extract the multiplexer, port `tasks/` and `war_rooms/` to it in one PR.
- (b) **Parallel build** — new `runtime/lifecycle.py` lands alongside; opt domains in one at a time.
- (c) **Greenfield rewrite** — new `Job` API, deprecate the old plugins gradually.

I lean (b) because a stuck refactor in (a) blocks both domains; (c) is too disruptive for the value.

**Q6.** Anything I'm missing about why tasks and rooms shouldn't share more? Are there constraints (auth-scope, idempotency, ordering) where the divergence is principled and I'm flattening over real differences?

## Outcome I'm looking for

Not a +1 on a specific design. I want the fleet's read on:
- Whether unification is worth doing now vs deferred
- Which axis is most valuable to unify first (lifecycle-wiring? reporter? trigger?)
- Anything about the `Job` interface or engine runtime contract that needs hardening before a refactor lands

Free to push back on the framing entirely. The simplification stack (#609-#611) was driven by an observation that the design was overcomplicated; if there's a similar observation here, I'd rather hear it now than after writing 5 PRs.

## What this RFC is NOT proposing

- Server-side merging of `/api/tasks/*` and `/api/rooms/*` endpoints (out of scope; different state machines).
- Removing the `claim_token` auth model from tasks (different threat model than war rooms).
- Changes to the engine subprocess interface (it's already correctly domain-agnostic).

---

## Decisions (post fleet review)

The fleet's feedback resolved all six questions. Guard's reasoning summarized verbatim where it shaped a decision:

**Q1 — Plugin separation.** **Decision: keep separate plugins, share substrate only at the engine-runtime layer.** Guard: *"strict separation between API layers to account for distinct threat models."* The `/api/tasks/*` (claim-token-gated) and `/api/rooms/*` (capability-bearer + role-keyed) are not unifiable at the wire level — different auth models, different idempotency semantics, different ordering invariants. The shared substrate is the engine-side `JobLifecycleReporter`; per-domain API translation lives in the reporter implementation.

**Q2 — Reporter shape.** **Decision: abstract base class (ABC), not Protocol.** Guard: *"ABC over Protocol to ensure forward compatibility for future hooks."* ABC fails compilation when a subclass forgets a new abstract method; Protocol is duck-typed and silently lets new methods become unimplemented. Forward-compat matters here because new hooks (`on_progress`, `on_cancellation`, etc.) will be added incrementally.

**Q3 — Heartbeat semantics.** **Decision: pure liveness, no payload.** Guard: *"enforcing a pure-liveness heartbeat to mitigate potential payload injection or data leakage vectors."* If progress-streaming becomes valuable, it lives on a separate `on_progress(text)` hook, not piggybacked on the heartbeat. Heartbeat stays a small empty POST that bumps the participant's `rsvp_at` (and emits a `heartbeat` event in the room's audit log).

**Q4 — Result extraction.** **Decision: shared today; per-domain becomes pluggable IF a domain needs different parsing.** Guard didn't flag a concern; today's `result_extractor.py` is NDJSON-aware and already serves both. Will surface as a per-reporter override when a real second shape appears.

**Q5 — Migration strategy.** **Decision: parallel build (option b).** Guard explicitly: *"recommends a parallel migration strategy."* Matches my prior lean. New `runtime/lifecycle.py` lands alongside; opt war_rooms in first (smaller plugin, simpler reporter), then tasks. Old `tasks/handler.py` and `war_rooms/handler.py` deleted only after both domains are on the new substrate.

**Q6 — Matcher fall-through.** **Decision: explicit precedence + dev-mode assert.** Guard: *"careful scrutiny of the matcher's fall-through semantics to prevent unintended behavior."* The runtime registers `(JobMatcher, ReporterFactory)` pairs in declaration order. **First match wins.** Two invariants enforced:
  1. **Mutual exclusion** — in dev/test, the runtime iterates ALL matchers and asserts at most one returns `True` per `Job`. Any overlap is a programming error caught at unit-test time, not at runtime.
  2. **Default fallback** — if zero matchers claim a `Job`, the runtime emits a structured error and refuses to dispatch (rather than silently dropping). Operators know immediately that a `Job` arrived with metadata no plugin recognizes.

## Implementation stack (informed by Decisions above)

Based on the decisions, the implementation stack is:

1. **PR A — server**: `POST /api/rooms/{id}/heartbeat`. Pure liveness, bumps `rsvp_at`, emits heartbeat event. Bound to `rooms.contribute` capability. ~150 LOC + tests.

2. **PR B — shared runtime**: extract `JobLifecycleReporter` ABC + lifecycle multiplexer + heartbeat-thread machinery into a new `agent/cli/hivemoot_agent/plugins_builtin/hivemoot/job_lifecycle/` module. Mutual-exclusion assertion runs in dev/test. No domain code touched yet. ~300 LOC + tests.

3. **PR C — war-rooms migration**: implement `RoomLifecycleReporter(JobLifecycleReporter)`, register in the runtime multiplexer. Delete the duplicated lifecycle wiring from `war_rooms/handler.py`. Smaller plugin first to validate the substrate.

4. **PR D — tasks migration**: implement `TaskLifecycleReporter(JobLifecycleReporter)`. Delete `tasks/handler.py`'s heartbeat thread + post-failure wiring. Old shape removed; new shape in place.

5. **PR E — dashboard**: surface last-heartbeat per participant on the room detail view (the UX motivation).

A → B → (C and D in parallel after B lands) → E.
