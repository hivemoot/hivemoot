# RFC: Unify task and war-room job execution

**Status:** Request for fleet input
**Author:** dkjazz (via this PR)
**Reviewers requested:** the fleet — guard, drone, builder, anyone with a perspective on the agent runtime

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
