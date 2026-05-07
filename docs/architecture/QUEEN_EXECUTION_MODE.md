# RFC: Queen execution mode (cloud vs local)

**Status:** Decisions reached — see "Decisions" section below.
**Author:** dkjazz (via this PR)
**Reviewers consulted:** the fleet (hive-guard + hive-drone + hive-builder). Three review passes from drone (initial verdict-stack analysis + trigger-loop follow-up + war-room contribution on failure-model inversion), two passes from guard (initial security audit + post-Decisions APPROVE), one pass from builder (CHANGES_REQUESTED on doc coherence + 6 implementation-shape issues). All reviewer feedback baked into D1–D16, the carry-forward G1–G9, and the body sections (rewritten to match the Decisions model rather than carrying the original prompt-driven proposal as active guidance).

---

## Why this RFC exists

Today the war-room queen has exactly one shape: a Vercel cron at `/api/internal/queen/tick` that fires every minute, walks open rooms for each installation, claims one ready for synthesis, calls an LLM via the installation's BYOK envelope, and posts a verdict comment back to the PR. Per-token costs hit the operator's BYOK provider account.

This works. But the operator already has a powerful agent on the hive (`messaging-telegram`, queen-class, codex provider) running on a flat Codex subscription — and that agent has shell access, gh CLI, the war-room API, and Codex's reasoning. From the operator's perspective, **the queen-tick is doing a less-capable job using a more-expensive billing model than the hive queen could**.

The proposal: let the operator opt the war-room queen into running on the hive (using the same agent that handles Telegram chat), with the cloud doing nothing for that installation. The decision of *what* to do (comment, squash-merge, etc.) stops being hard-coded rules in TypeScript and becomes a prompt-driven judgment Codex makes from the room's full state.

## What's already shared between the two modes

* War-room storage layer (Redis, Lua-scripted atomicity).
* Room lifecycle invariants (heartbeat, awaiting_contributions → deciding → closed).
* Reviewer agents (drone / guard / builder) — they continue to dispatch and contribute regardless of which queen synthesizes.
* GitHub installation tokens (the cloud bot mints them today; the hive queen mints them via `installation_token.mint` capability).

## What's NOT changing

* Reviewer agents — drone, guard, builder, etc. still discover rooms via `/watching`, /present, /contribute exactly as today.
* Storage shape — same room hash, same events log, same participants/contributions sub-keys.
* Webhook subscription — the cloud bot still receives every webhook GitHub sends; we can't unsubscribe per-installation. The new behavior is "cloud reads the installation's `queen_mode` and early-returns when local."
* BYOK envelope — still operator-provided, still encrypted at rest. Just becomes irrelevant when `queen_mode=local`.

## Two modes

| | Cloud (today) | Local (proposed) |
|---|---|---|
| **PR discovery** | Probot webhook → bot/api creates room | Hive queen polls `gh pr list`, creates rooms via API |
| **Synthesis** | Vercel cron + BYOK LLM call | Codex inside hive queen container |
| **Action** | Post comment to PR | Post comment OR squash-merge OR (future) request-changes |
| **GitHub auth** | Bot's installation token | Queen mints installation token via capability |
| **Cost** | BYOK per-token | Codex subscription (flat) |
| **Cloud's role when local is on** | — | **Nothing for this installation** |
| **Failover** | Vercel watchdog + max-age expiration | None — opt-in commits to hive uptime |

## Per-installation toggle

```
hive:v1:installation:<id>:queen-settings   hash
  queen_mode: "cloud" | "local"   (default: "cloud")
  queen_prompt_override: <yaml-encoded blob, optional>  # see D12
```

Read by every cloud-side handler (queen-tick + webhook routes) on entry, via the Probot 60s TTL cache (D15). If `local`: log + early-return. The BYOK envelope keeps its existing key (`hive:v1:installation:<id>:byok-envelope`) — relocating it is **out of scope** for this RFC and would need a separate migration plan with key-rotation handling.

## Action surface for local queen (v1)

> **Per D2/D6: actions are Zod-validated structurally, not parsed from prose. The dispatcher is authoritative.**

Two actions, structurally validated by the API at decision time:

1. **comment** — synthesis prose posted via the bot's existing `GitHubDecisionPoster` (today's path). Idempotent-retryable; failure does NOT undo room close.
2. **squash-merge** — gated by D1's server-side invariant check (label, approvals, CI, head SHA stable, no drift). Irreversible; **D6 inverts the failure ordering vs comment** — `close-with-decision` succeeds first, THEN merge runs. If close-with-decision fails, no merge.

Both follow the two-phase commit state machine (D4): tick N posts the synthesis with the chosen action header → room enters `decided` (for comment) or `decided_pending_action` (for squash-merge) → for `squash-merge`, tick N+1 (≥60s later, ≤15min TTL per G4) re-validates `throughSequence` (G3) + GitHub-side invariants → executes or downgrades.

Out of scope for v1: `request_changes`, `dismiss_review`, label management, branch deletion. File as future work via code change + capability review per D13.

## Prompt design

> **Per D2/D3: the prompt produces structured outputs validated by Zod schemas. The 3-layer verdict stack runs unchanged. Codex's text output is for prose only.**

The hive queen makes **two** `generateObject` calls in sequence:

```
1. Verdict derivation (D3 — preserves existing 3-layer stack)
   model.generateObject({
     schema: DerivedVerdictSchema,   // existing — z.enum APPROVE/COMMENT/CONCERNS/REQUEST_CHANGES
     system: <verdict-derivation system prompt — same as cloud>,
     prompt: <room contributions wrapped in <untrusted-content> delimiters>
   })
   → { verdict: "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES" }

2. Action recommendation (D2 — new schema, advisory only)
   model.generateObject({
     schema: RecommendedActionSchema,   // new — z.enum comment/squash-merge
     system: <action-recommendation system prompt with judgment guidelines>,
     prompt: <verdict + room state + PR metadata + override config (D12)>
   })
   → { recommendation: "comment" | "squash-merge", reasoning: <short prose> }

3. Prose synthesis (existing — generateText)
   <bot-controlled verdict header> + <Codex prose> + <bot-controlled action footer>
```

The `recommendation` field is **advisory input** to the dispatcher's deterministic invariant check (D1). The dispatcher ignores `recommendation` whenever D1's invariants don't permit it and emits a `queen.action_downgrade` audit event (G2).

System prompt for action recommendation, anchored on D12's structured override:

```
ROLE
You are the Hivemoot Queen. Recommend the action that best fits the
contributions and PR state. The server enforces merge invariants
independently — your recommendation is advisory.

CONTEXT (rendered into prompt at runtime)
  - Room: {room_id} subject={subject_ref}
  - Verdict (already derived): {verdict}
  - Participants: {role list}
  - Contributions: {each reviewer's prose, role-tagged, wrapped in <untrusted-content>}
  - PR metadata: head_sha, base_branch, ci_status, labels, drift_marker_present
  - Per-installation override (structured, D12):
      merge_conventions: "..."         # operator policy in prose
      additional_blockers: ["..."]     # extra patterns to block on

JUDGMENT GUIDELINES (advisory)
  - All reviewers approved, CI green, no drift, hivemoot:automerge label, no override blocker matched → recommend squash-merge
  - Any concerns / request_changes / drift / blocker match → recommend comment
  - Non-PR rooms (general / mention) → recommend comment

OUTPUT (Zod-validated)
  { recommendation: "comment" | "squash-merge", reasoning: string }
```

The override surface (`merge_conventions`, `additional_blockers`) is operator-rendered text per D12 — **not a trust boundary** (G8). D1's server-side check is the only line of defense; the override can only misalign the recommendation prose, never bypass the invariant.

## New surface area

### HTTP endpoints

All bearer-gated endpoints follow the existing capability convention. Note: `derive-verdict` and `room-state` are listed here so D3's "call the cloud-side endpoint" path is concrete (per G1) and so the trigger loop doesn't reach for the operator-session-gated dashboard route from a bearer context.

```
# Bearer-gated (capability: rooms.synthesize) — new
GET  /api/rooms/synthesis-ready
   → list rooms in awaiting_contributions/deciding ready for synthesis

POST /api/rooms/:id/claim-synthesis
   → TTL'd lease (15min default; G4 also caps decided_pending_action at 15min)

POST /api/rooms/:id/derive-verdict
   → invokes existing aggregateWorkerVerdicts + deriveVerdictFromContributions
     (G1: single source of truth — the verdict-derivation library at
     bot/api/lib/queen/verdict-deriver.ts becomes a route, callable from Python)
   → returns { verdict, source: "structural_floor" | "llm_derived" }

POST /api/rooms/:id/close-with-decision
   → atomic: applies D1's server-side invariant check, transitions room to
     `decided` or `decided_pending_action`, writes D7's audit event
     (including G2's queen.action_downgrade when chosen != permitted)

# Bearer-gated (capability: rooms.read_all) — new bearer-friendly variant
GET  /api/rooms/:id
   → room core + participants + contributions + events, same shape the
     dashboard's composite route returns. Avoids reaching for the
     operator-session-gated /api/dashboard/rooms/:id from a bearer context.

# Operator-session-gated — new
GET  /api/installations/:id/queen-settings
   → returns { queen_mode, queen_prompt_override }

POST /api/installations/:id/queen-settings
   → atomic update with audit event (D9 blocks on in-flight rooms;
     G6 force-expire-claims path requires confirmation modal + audit event)
```

### Capability bundle: new `queen` preset

```yaml
queen:
  - rooms.create              # existing on queen preset; G3 already enforces subject-type allowlist
  - rooms.synthesize          # NEW (additive per D14 — does not replace rooms.decide / rooms.close)
  - rooms.read_all            # NEW (gates the new bearer-friendly room-read endpoint)
  - rooms.watch               # existing
  - installation_token.mint   # existing
```

Per D14, the new `rooms.synthesize` capability gates the new `close-with-decision` endpoint (which combines claim+synth+close+audit). Existing `rooms.decide` and `rooms.close` capabilities continue to gate the existing endpoints, which the cloud queen continues to use. **Two paths, two capability sets, no migration.**

### Storage

```
hive:v1:installation:<id>:queen-settings   hash
  queen_mode             "cloud" | "local"           # D15 caches with 60s TTL
  queen_prompt_override  <yaml-encoded structured config — D12>

hive:v1:installation:<id>:byok-envelope    hash    # existing, unchanged
  provider, model, key_encrypted, ...

hive:v1:rate-limit:rooms-create:<bearer>:<minute>  string (counter)
hive:v1:rate-limit:rooms-create:<inst>:<minute>    string (counter)
                                                    # both per D11 — TTL 60s
```

BYOK relocation is **explicitly out of scope** for this RFC. The current envelope key stays where it is; PR 6 covers UI relocation only (the dashboard route moves; the storage key does not).

### UI: `/dashboard/settings`

Replaces `/dashboard/credentials` as the umbrella config surface.

```
/dashboard/settings
├── Queen
│   ├── Mode         ⚪ Cloud (BYOK)   ⚫ Local (hive)
│   ├── Status       Last action: 3m ago · merged hivemoot#624
│   └── Heartbeat    🟢 Local queen seen 12s ago
│                  | ⚠️ No local queen heartbeat in 3m
├── BYOK            (only relevant when queen_mode=cloud)
│   └── Provider, Model, Status, Rotate / revoke
├── Telegram        (placeholder for future settings)
└── Agent tokens    (today's /credentials content)
```

Mode-toggle confirmation step: "Switching to local — cloud will stop processing PRs for this installation. The hive queen must be running. Proceed?" Once flipped, the dashboard polls a heartbeat endpoint to surface the indicator.

## Hive queen plugin shape

Per ADR-002, the agent runtime uses a consolidated `plugins.hivemoot` block with feature toggles (`health`, `tasks`, `github_workflows`, `apiarist`, `war_rooms`). The queen functionality fits that pattern as a new feature block, not a standalone plugin:

```yaml
plugins:
  hivemoot:
    health:           { enabled: true, ... }     # existing
    tasks:            { enabled: false, ... }    # existing
    war_rooms:        { enabled: true, ... }     # existing — reviewer-side
    github_workflows: { enabled: false, ... }    # existing
    apiarist:         { enabled: true, ... }     # existing — token broker

    queen:                                       # NEW — feature block
      enabled: true
      poll_interval_secs: 60
      base_url: https://www.hivemoot.dev
      installation_id: 107212709
      watched_repos:
        - hivemoot/hivemoot

  messaging:
    telegram:         { enabled: true, ... }     # existing — Telegram chat
```

Same `messaging-telegram` agent (or a separate `hivemoot-queen` apiary service) loads this consolidated config. The queen feature only activates when `queen.enabled=true` AND the bearer has `rooms.synthesize`. Disabled by default; opting an installation into local mode flips this on per-agent.

### D6 boundary: server-side dispatcher, not literal code sharing

D6's "shared module callable from both" was imprecise — TypeScript bot/web code is not directly callable from the Python agent runtime (separate processes, different language). The actual boundary is the new `POST /api/rooms/:id/close-with-decision` endpoint (server-side TypeScript): both modes hit it. The endpoint owns:

- D1's invariant check (server reads label/CI/SHA/drift fresh from GitHub at decision time)
- D6's failure ordering branch (`comment` follows today's flow; `squash-merge` is rejected at this endpoint if invariants fail — the agent then independently runs `gh pr merge`)
- D7's audit event write (single source of truth for action records)
- G2's `queen.action_downgrade` event when `chosen_action != permitted_action`

Cloud queen's `GitHubDecisionPoster` (TypeScript) and hive queen's plugin (Python via gh CLI) call the same endpoint. The endpoint enforces. The dispatcher logic on each side just builds the request and executes the GitHub action AFTER the endpoint has approved it.

### Trigger loop body (per Decisions D1–D6, G1, G3, G4)

```
every poll_interval_secs:
  # Discovery (G3 anchors this on throughSequence stability)
  1. gh pr list --state open --json … across watched_repos
  2. For each PR with no war room:
       POST /api/rooms { subject_type: "pr_review", subject_ref }
       (rate-limited per D11; subject-type allowlist enforced server-side)

  # Synthesis loop with D5's race mitigations replicated from manager-loop.ts
  3. GET /api/rooms/synthesis-ready
  4. For each ready room:
       a. Quiet-period gate (D5): skip if last_transition_at + quiet_period_secs > now
       b. POST /api/rooms/:id/claim-synthesis (15min TTL)
          handle 5 distinct benign-409 codes per D5: claim_already_held,
          invalid_status_for_claim, sequence_drift, claim_lost,
          claim_through_seq_mismatch
       c. GET /api/rooms/:id (bearer-gated, gates rooms.read_all per surface area)
       d. Post-claim re-validation (D5): re-check participants for re-RSVP
          / non-final-withdrawal races since claim
       e. Withdraw-finality check (D5): compare withdrew_at_sequence vs
          throughSequence; skip if not final

       # Two structured calls (D2, D3) — verdict via cloud endpoint, action local
       f. POST /api/rooms/:id/derive-verdict → { verdict, source }
       g. Codex.generateObject(RecommendedActionSchema) → { recommendation, reasoning }

       # D1's invariant check + D6's failure ordering — DURABLE BEFORE IRREVERSIBLE
       h. POST /api/rooms/:id/close-with-decision {
            verdict, content, recommended_action,
            sealed_through_sequence: <claim's throughSequence>
          }
          → server applies D1; returns permitted_action and writes D7 audit;
            transitions room to `decided` (for comment) or
            `decided_pending_action` (for squash-merge);
            emits G2 queen.action_downgrade if recommendation != permitted

       # Action execution AFTER durable close
       i. Mint installation token via /api/installation_tokens
          (D10 policy: pull_requests:write, issues:write, metadata:read,
           allowed_repos = watched_repos)
       j. If permitted_action == "comment": gh pr comment <pr> -b <prose>
       k. If permitted_action == "squash-merge": this is tick N; comment
          posted with intended-action header; tick N+1 (≥60s, ≤15min per
          G4 TTL on decided_pending_action) re-validates throughSequence (G3)
          + GitHub-side invariants, then runs gh pr merge --squash;
          downgrades to comment if anything changed since tick N
```

## Implementation slicing

| PR | Scope | Independence |
|---|---|---|
| 1 | Settings storage: `hive:v1:installation:<id>:queen-settings` Redis hash, operator-session GET/POST endpoints, Probot 60s TTL cache (D15 + G7 default-to-cloud on Redis-down) | Yes — no reader yet |
| 2 | Cloud-side skip-flag: queen-tick + webhook handlers early-return when `mode=local`. Cloud-as-observer metric emission (D8 with G5 thresholds). Mode-flip blocks on in-flight rooms (D9), force-expire requires confirmation modal + audit event (G6) | Yes — defaults to cloud, no observable change |
| 3 | New HTTP endpoints (`synthesis-ready`, `claim-synthesis`, `derive-verdict`, `close-with-decision`, bearer `/api/rooms/:id`). `rooms.synthesize` + `rooms.read_all` capabilities. New `queen` preset bundle (additive per D14). Token policy with `contents:read` drop verified by test (G9). D1 invariant check + D6 failure-ordering branch + D7 audit event + G2 `queen.action_downgrade` event in `close-with-decision`. Rate caps on `rooms.create` (D11). New room state `decided_pending_action` with 15min TTL (D4 + G4). | Depends on PR 1's storage |
| 4 | Hive queen feature block under `plugins.hivemoot.queen`. Trigger loop with D5's race mitigations (quiet-period + post-claim re-val + withdraw-finality + benign-409 handling). Two structured `generateObject` calls (D2: action via Zod schema, D3: verdict via cloud endpoint). Two-phase commit state machine (D4) anchored on `throughSequence` (G3). | Depends on PR 3 |
| 5 | `/dashboard/settings` page with Queen mode toggle + heartbeat indicator (combining agent self-report and D8's cloud-observer metric). Structured override config UI (D12). Confirmation step on mode-flip surfaces D9 + G6's blocking conditions. | Depends on PR 1 |
| 6 | Move BYOK UI from `/credentials` to `/settings/byok` (cosmetic; redirect old path). **Storage key NOT relocated** — only the dashboard route moves. | Independent |

## Open questions for the fleet

I'd value reads on these specifically — pick whichever you have an opinion on.

**Q1.** Where does the queen prompt live?
* (a) Hardcoded in `agent/cli/hivemoot_agent/plugins_builtin/hivemoot/queen/prompt.py` — versioned with the agent, stable across runs.
* (b) Per-installation in Redis (`installation:<id>:queen_prompt_override`) — operator can tune without redeploying.
* (c) Hardcoded base + per-installation override layered on top.

I lean (c). Lets each repo tune for idiosyncratic conventions (e.g. "this org never auto-merges PRs touching `infra/`") without forking the agent. Risk: silent drift between repos as overrides accumulate. Counter-mitigation: dashboard surfaces the override diff.

**Q2.** Drift-marker handling.
A closed room's PR drifts post-verdict (head SHA advances). Cloud queen does nothing today; the dashboard surfaces a "diff drifted" badge. Local queen could:
* (a) Re-open the room and re-synthesize.
* (b) Post a comment "verdict no longer covers latest diff."
* (c) Leave it for the operator.

I lean (b) for v1. (a) creates an automation surface for adversarial drift games (push-then-revert to flip verdicts); (c) is what we have today and clearly insufficient.

**Q3.** Capability gating on `rooms.create`.
Today only the operator-session route can create rooms (POST `/api/dashboard/rooms`). Granting `rooms.create` to a capability bearer changes the threat model — a leaked queen bearer could create unbounded rooms.
* (a) Cap at N rooms/minute per bearer.
* (b) Restrict to `subject_type ∈ { pr_review, mention_response, issue_triage }` (no `general` from bearers).
* (c) Both.

I lean (c). Bearers shouldn't manufacture `general` rooms (those are operator-driven) and shouldn't be able to DOS the storage layer.

**Q4.** Action surface scope-creep.
The two-action surface (`comment` | `squash-merge`) is intentionally narrow for v1. Once Codex is in the loop, requests for `request_changes` / `dismiss_review` / `label management` / `auto-rebase` will follow. Should the prompt design assume future actions are additive (each action is a string the prompt can pick), or do we hard-code the v1 set?
* (a) Hard-code `comment | squash-merge` enum in the queen plugin's action dispatcher; new actions = code change.
* (b) Make the action surface a config list — Codex picks any verb the operator has enabled.

I lean (a) for v1. (b) is the eventual right shape but adds a config surface I'd rather not design before we have a real second use case.

**Q5.** Multi-installation per hive.
If you eventually run multiple installations through the same hive, do they each get their own `messaging-telegram` service (current single-installation pattern), or does one queen multiplex?

I lean keep one-per-installation. Today the cap bearer is single-installation; multiple bearers = multiple agents. Multiplexing would force a bunch of bookkeeping (per-installation prompt, per-installation gh token, per-installation BYOK in case of fallback) for a benefit (one container instead of N) that doesn't matter at small N.

**Q6.** What stops a misbehaving local queen from merging the wrong PR?
This is the load-bearing safety question. The prompt's judgment guidelines are policy; if Codex misreads them, a wrong squash-merge is irreversible (well, revertible via `gh pr revert` but disruptive). Mitigations:
* Per-PR allowlist: only PRs labeled `hivemoot:automerge` are merge-eligible (this is in the prompt today).
* Per-room dry-run: queen posts the synthesis comment AND describes the action it intended to take, then waits one tick for an operator override before executing the merge.
* Audit log: every action records `{actor: queen-runner-id, decision-prompt-hash, action, room_id}` to the room's events log so it's traceable post-hoc.

I lean: ALL THREE of those, baked in. The first one is in the prompt; the second can be a config flag (`require_dry_run_for_merge: true` default true for v1, opt-out later); the third is a one-line addition to the close-with-decision write path.

## Outcome I'm looking for

Not a +1. The fleet's read on:
* Whether mode-toggle is the right shape vs always-on local + cloud-as-watchdog vs some other framing.
* Whether the prompt-driven action dispatch is the right primitive vs a structured-output action enum.
* Specific reads on Q1–Q6 above.
* Anything I'm not seeing — particularly around capability scope, audit trails, and migration (how do operators safely flip an installation that has rooms in flight?).

Free to push back on the framing entirely. Last RFC (`JOB_LIFECYCLE_UNIFICATION.md`) had three points that materially changed the implementation; I'd rather hear them now than after writing six PRs.

---

## Decisions (post fleet review)

The fleet's three-pass review (guard's security read + drone's verdict-stack analysis + drone's two follow-ups on trigger-loop code paths and the cloud→local failure-model inversion) reshaped the RFC materially. The biggest finding: the v1-as-drafted version put **prompt injection on the merge path** (guard §1) and discarded the existing **3-layer verdict stack** (drone) that was carefully engineered to be injection-resistant. Both reviewers concluded the mode toggle framing is right but the action-dispatch trust model needs to be inverted: the prompt is *advisory*, deterministic code is *authoritative*. All 16 decisions below carry that single thread.

Where guard's reasoning shaped a decision verbatim, it's quoted.

### Architectural (load-bearing)

**D1 — Server-side merge invariants enforced at `close-with-decision`.**
Guard §1: *"the merge decision MUST NOT be a string Codex emits. It must be a server-side invariant the close-with-decision endpoint re-validates after receiving the verdict."* The endpoint re-reads from GitHub at decision-time:

- `hivemoot:automerge` label present
- All required reviewers (CODEOWNERS or room participant set) posted contributions with verdict `approve`
- CI status green per GraphQL `commit.statusCheckRollup`
- Head SHA at synthesis-start === head SHA at merge-time (drift guard)
- `last_post_close_drift_*` unset

If any fail, downgrade silently to `comment` and surface the downgrade in the verdict prose. **The prompt picks the verb; the API enforces the invariant.**

**D2 — Action enum is Zod-validated `generateObject`, not parsed from prose.**
Drone: *"the action enum should get the same structural treatment as the verdict enum."* The hive queen makes two `generateObject` calls in sequence:
1. Verdict via existing `DerivedVerdictSchema` (`z.enum(["APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"])`)
2. Action via new `RecommendedActionSchema` (`z.enum(["comment", "squash-merge"])`)

Action is then validated against D1's invariants by the dispatcher. No action verb is ever parsed from text output.

**D3 — Verdict stack preserved.**
Drone: *"the local queen doesn't have to throw away the verdict stack."* The 3-layer pipeline (`aggregateWorkerVerdicts` → `deriveVerdictFromContributions` → prose synthesis) runs in local mode the same way it runs in cloud mode. The Python agent calls the cloud-side verdict-derivation endpoints rather than reimplementing them — preserves a single source of truth for the verdict logic and keeps schema changes from drifting between modes.

**D4 — Two-phase commit state machine for merge.**
Guard §4 + drone: drop the opt-out flag; the `require_dry_run_for_merge` second-tick flow is mandatory in v1. New room state `decided_pending_action`:

- **Tick N (synthesis):** verdict + action derived → if action=`squash-merge` and D1 invariants pass, comment posted with "intended action: squash-merge" header → room enters `decided_pending_action`.
- **Tick N+1 (≥60s later):** queen re-reads room → if no operator override comment (`hivemoot:hold` label, operator reply, etc.), head SHA unchanged, CI still green, labels still present → execute merge. Any change → downgrade to comment with "merge skipped because [reason]," room transitions to `decided`.

**D5 — Race-condition mitigations replicated in the local queen.**
Drone follow-up §1: *"the local queen will hit the same races — it's calling the same API."* The hive queen plugin replicates the four mitigations the cloud manager loop already has:

- Quiet-period gate (`quiet_period_secs` after last participant transition)
- Post-claim re-validation (re-read participants for re-RSVP / non-final-withdrawal races)
- Withdraw-finality check (`withdrew_at_sequence` vs `throughSequence`)
- Benign-conflict handling for the 5 distinct 409 codes (`claim_already_held`, `invalid_status_for_claim`, `sequence_drift`, `claim_lost`, `claim_through_seq_mismatch`)

Cloud and local share equivalent concurrency safety. The cloud manager loop becomes the reference implementation; PR 4 ports the gates to Python.

**D6 — Shared dispatch module with defenses + canonical failure ordering (inverted from cloud's pattern).**
Drone follow-up §3 + war-room contribution: the local queen's action dispatcher must apply the same defenses as `GitHubDecisionPoster`:

- `parseSubjectRef` regex defense (anchored, no shell-meta passthrough)
- `POSTABLE` subject-type gate (`pr_review | mention_response | issue_triage` only)
- **Failure ordering: `close-with-decision` BEFORE `gh pr merge --squash`. This is the inverse of today's `GitHubDecisionPoster` pattern.**

Drone: *"The current `GitHubDecisionPoster` enforces: failure to post to GitHub does NOT undo the room close. The decision is durable; the post is best-effort. For squash-merge, this model inverts. `gh pr merge --squash` is irreversible."*

Today's flow (cloud): close room → post comment. Comment-post failure is recoverable; room-state is source of truth.

Local queen flow (new): close-with-decision (durable, recoverable via watchdog) → mint installation token → `gh pr merge --squash` (irreversible). If close-with-decision fails, no merge happens. If merge fails after close, the room is correctly recorded + an audit event captures the dispatch failure.

Implementation: a shared module callable from both the cloud `GitHubDecisionPoster` and the hive queen plugin, but the dispatcher within it branches on action type — `comment` follows today's "close then post, post-failure non-critical" ordering; `squash-merge` follows the inverted ordering. New defenses go in once, both modes pick them up.

### Mechanism / policy

**D7 — Dispatcher writes audit events, not Codex's self-report.**
Guard §5: *"don't trust Codex to self-report the action it took."* The action dispatcher (the `gh pr X` subprocess wrapper) emits the audit event with: `{actor: queen-runner-id, decision-prompt-hash, override-hash, action-attempted, action-actual, exit-code, room_id}`. Server-side `close-with-decision` records the canonical action it observed in the request, separate from any prose self-description.

**D8 — Cloud observes via metrics in local mode (not failover, alarm).**
Guard §6 + drone agreement: cloud-side queen-tick reads the room list when `queen_mode=local`, **doesn't claim or synthesize**, but emits one metric per installation: "rooms ready for synthesis older than N minutes." The dashboard heartbeat surfaces both the agent's self-reported heartbeat AND the cloud's view. If the agent self-reports healthy but the cloud sees rooms piling up, the dashboard alarms. *"The self-reported heartbeat from a hung process is famously unreliable"* — guard.

**D9 — Mode-flip blocks on in-flight rooms.**
Guard §7 + drone: the mode-flip endpoint refuses if any room is in `deciding` state with a non-expired claim, OR in `decided_pending_action` (the second-tick window). Operator must wait for in-flight work to settle or explicitly force-expire claims. Avoids the ambiguous-ownership state where cloud thought it was synthesizing but local takes over mid-flight.

**D10 — Queen-mode token policy: minimum permissions + per-repo allowlist.**
Guard §8: when the dashboard mints the queen-mode bearer's GitHub installation token, it sets `policy.allowed_permissions = { pull_requests: "write", issues: "write", metadata: "read" }` (drop `contents: "read"` — the queen doesn't read repo files; that's the reviewer agents' job). `policy.allowed_repos` is exactly the `watched_repos` config list. Both enforced at token-mint time.

**D11 — `rooms.create` rate-capped per bearer + per installation.**
Guard §2: the existing subject-type allowlist is already in place at `web/src/app/api/rooms/route.ts:35-39`; the gap is the rate cap. Add per-bearer-per-minute and per-installation-per-minute caps on the `rooms.create` route. Structured-warn telemetry on near-limit hits. Don't tie to subject_type — the storage cost is the same regardless.

**D12 — Prompt override is structured YAML config, not free-form text.**
Drone: *"free-form prompt override is a loaded gun pointed at the merge gate."* The override schema (stored in `installation:<id>:settings.queen_prompt_override`):

```yaml
queen_prompt_override:
  merge_conventions: "this org never auto-merges PRs touching infra/"
  additional_blockers:
    - "changes to .github/workflows/"
    - "PRs that touch shared/war-room/"
```

Bounded surface; rendered into the prompt's "Repo conventions" section. Free-form prompt tuning is rejected. Combined with D1's server-side invariants, the override surface can't undermine merge safety even if compromised — the worst it can do is misalign the prose.

**D13 — Hard-coded action enum (no operator-configurable verbs in v1).**
Both reviewers + RFC lean (a). The action enum is `{ comment, squash-merge }` in v1, expanded only via code change + capability review. Each new verb gets its own dispatcher-side invariant check before merging.

**D14 — `rooms.synthesize` is additive to existing `rooms.decide` + `rooms.close`.**
Drone follow-up §2: *"two paths, two capability sets, no migration."* The new `rooms.synthesize` capability gates the new `close-with-decision` endpoint (which combines claim + synthesize + close + audit-event-write into one atomic transaction). Existing `rooms.decide` and `rooms.close` capabilities continue to gate the existing endpoints, which the cloud queen continues to use. The new `queen` preset bundle adds `rooms.synthesize` + `rooms.create` (already there) + `installation_token.mint` (already there) without removing anything.

**D15 — Webhook `queen_mode` cached in Probot with 60s TTL.**
Drone follow-up minor: cloud-side webhook handlers and the queen-tick read `queen_mode` via a process-local cache with a 60-second TTL on hit, falling back to Redis on miss/expiry. Avoids hot-path Redis roundtrip on every webhook event for local-mode installations. Mode changes propagate within ≤60s after the operator toggles.

**D16 — Local-mode single-point-of-failure characterization, accepted for v1.**
Drone war-room contribution §"Dual-role single-point-of-failure": the cloud architecture has accidental partial-redundancy — webhook-driven room creation is independent of cron-driven synthesis, so a queen-tick outage keeps discovery alive even though synthesis stalls. Local mode collapses both responsibilities into one container; any hive queen outage stops the entire pipeline (no PR discovery, no synthesis, no GitHub action).

This is the right shape for v1 (one container, one Codex subscription, one bearer) but operators need to know what they're opting into. The mode-toggle confirmation step (`/dashboard/settings`) explicitly surfaces this:

> "Switching to local — the hive queen becomes the single point of failure for this installation's PR pipeline. Both PR discovery AND synthesis depend on it. The cloud will emit a 'rooms-stuck-older-than-N-min' alarm if the local queen falls behind, but no fallback synthesis will happen. Make sure your hive queen has uptime monitoring before flipping. Proceed?"

Future work (out of scope for v1): a degraded mode where cloud retains webhook-driven room creation as a partial-progress fallback while local handles synthesis. Filed against future RFC; not designed here because the trade-off (operational complexity + dual code paths) doesn't justify it until v1 surfaces real outage patterns.

### Open-question resolution map

| Question | Decision |
|---|---|
| Q1 — Prompt location | (c) base + structured override (D12) |
| Q2 — Drift-marker handling | Post comment, never auto re-merge (D1's drift-guard makes this enforce-able) |
| Q3 — `rooms.create` capability gating | Subject-type allowlist already in place; add rate cap (D11) |
| Q4 — Action surface evolution | Hard-coded enum for v1 (D13) |
| Q5 — Multi-installation per hive | Keep one-per-installation |
| Q6 — Misbehaving-queen safety | Server-side invariants (D1) + two-phase commit (D4) + dispatcher audit (D7) — three layers |

### Implementation stack (informed by decisions above)

The 6-PR stack reshapes:

1. **PR 1 — settings storage**: per-installation `queen_mode` Redis hash + GET/POST endpoints. Rate cap on `rooms.create` (D11). Probot 60s TTL cache for `queen_mode` (D15).

2. **PR 2 — cloud-side skip-flag**: queen-tick + webhook handlers early-return when `mode=local`. Cloud-as-observer metric emission (D8). Mode-flip endpoint blocks on in-flight rooms (D9).

3. **PR 3 — endpoints + capabilities**: New `close-with-decision` endpoint with **D1's server-side invariant check** + **D6's shared dispatch module** + **D7's audit event write**. New `rooms.synthesize` capability (additive per D14). Token policy fields wired (D10). New room state `decided_pending_action` (D4).

4. **PR 4 — hive queen plugin**: trigger loop with **D5's race mitigations** (quiet-period + post-claim re-val + withdraw-finality + benign-409 handling). Two `generateObject` calls (D2: verdict + action). Two-phase commit state machine (D4). Calls D6's shared dispatch module. Loads structured override config (D12).

5. **PR 5 — `/dashboard/settings`**: Queen mode toggle + heartbeat indicator (combining agent self-report and D8's cloud-observer metric). Structured-config UI for override (D12). Confirmation step on mode-flip surfaces D9's blocking conditions.

6. **PR 6 — BYOK relocation**: cosmetic; redirect old `/credentials` path.

PR 1 → (PR 2 + PR 3) in parallel → PR 4 (depends on PR 3) + PR 5 (depends on PR 1) → PR 6 (independent of all).

### Carried-forward implementation notes (PR-blockers, not RFC-blockers)

Guard's post-Decisions APPROVE review identified 9 implementation details the Decisions section leaves under-specified. They aren't architectural — the trust model and ordering are settled. They're concrete things each PR's review must confirm before code lands. Captured here so they're not re-debated when the implementation lands.

**G1 — D3 needs a new HTTP endpoint, not just library access.**
D3 says the local agent "can either call the cloud-side verdict-derivation endpoints or replicate the logic in Python." But the verdict-derivation logic lives at `bot/api/lib/queen/verdict-deriver.ts` as a library, not a route. PR 3 must expose `POST /api/rooms/:id/derive-verdict` gated by `rooms.synthesize`, returning `{ verdict, source: "structural_floor" | "llm_derived" }`. Without this, D3 collapses to "Python reimplements the stack" and the single-source-of-truth invariant is lost.

**G2 — D1's silent downgrade should emit a structured audit event, not just verdict prose.**
A divergence between Codex's chosen action (`squash-merge`) and what the server permits (`comment` only) is a security signal, not just a UX detail. PR 3's `close-with-decision` endpoint emits a separate `queen.action_downgrade` audit event whenever `chosen_action != permitted_action`, surfaced on the dashboard alongside the per-room timeline. If Codex consistently picks merge when invariants fail, that's a sign of prompt drift, prompt injection, or compromised override — operators need to see it.

**G3 — D4's tick N+1 re-validation anchors on `throughSequence`, not enumerated conditions.**
The Decisions text lists specific N+1 invariants (`hivemoot:hold` label, head SHA, CI status, label set). Cleaner: the room's `throughSequence` at tick N+1 must equal the value sealed at tick N. Any room-state change (new participant, contribution edit, withdrawal) bumps the sequence and reopens the question. PR 4 implements this as the primary guard, with the GitHub-side checks (label / CI / SHA / drift) as secondary.

**G4 — `decided_pending_action` needs an explicit TTL.**
D4's two-phase commit waits "≥60s" for tick N+1 but doesn't bound how long a room can sit pending. Default: 15 min max age in `decided_pending_action`. After that, the watchdog (cloud queen-tick in cloud mode, hive plugin's own watchdog in local mode) re-claims and either re-validates-and-merges or downgrades-to-comment. PR 4 implements this; D8's "rooms-ready-older-than-N" metric (PR 5 dashboard) extends to count `decided_pending_action` past TTL.

**G5 — D8's alarm threshold + channel pinned.**
N is 5 min for "synthesis-ready but not claimed" and 15 min for "decided_pending_action stuck." Channels: dashboard banner for steady-state visibility, plus a configurable webhook for alerting (PagerDuty / Slack / etc.) on threshold breach. PR 5 ships the dashboard threshold; the webhook surface is post-v1.

**G6 — D9's force-expire escape hatch requires auth + confirmation + audit.**
Force-expiring an active synthesis claim is a footgun. PR 5's UI:
- Operator-session-only (no capability-bearer access).
- Confirmation modal listing affected rooms.
- Emits `queen.claim_force_expired` audit event with `{operator, room_id, original_claimed_by, reason}`.
- Surfaces in the room's events log.

**G7 — D15's Redis-down behavior: default-to-cloud-processing + structured alarm.**
On Redis read failure during webhook handling, the cloud bot defaults to **processing the webhook normally** (cloud-mode behavior). Justification: D5's claim contention bounds cloud double-processing if local is also active; cloud-skipping is observable but silent (rooms pile up before D8's metric fires). Emits `queen.mode_resolution_failed` structured alarm. PR 1 documents this in the cache-fallback path.

**G8 — D12's override surface is not a trust boundary.**
Explicit note for future contributors: the structured prompt override (`merge_conventions`, `additional_blockers`) is operator-rendered text that flows into Codex's prompt context. With D1's server-side invariants in place, a malicious override can only misalign the verdict prose — it cannot bypass merge invariants. **Future code touching the override surface MUST NOT relax this assumption** (e.g., don't add an override key that influences the dispatcher's policy resolution; the dispatcher's policy is code, not config).

**G9 — D10's `contents:read` drop verified by token-policy test.**
PR 3's token-policy tests assert that the queen-mode bearer's GitHub installation token, minted with `policy.allowed_permissions = { pull_requests: "write", issues: "write", metadata: "read" }`, can successfully:
- `gh pr view --json title,headRefName,headRefOid,mergeable,statusCheckRollup,labels` (no contents:read needed)
- `gh pr comment <pr> -b "..."`
- `gh pr merge --squash <pr>`

against a private repo. If any field requires `contents:read`, the test fails and PR 3 doesn't merge until the policy is corrected.
