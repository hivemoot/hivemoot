# RFC: Queen execution mode (cloud vs local)

**Status:** Decisions reached — see "Decisions" section below.
**Author:** dkjazz (via this PR)
**Reviewers consulted:** the fleet (hive-guard + hive-drone, with drone contributing a follow-up code review). Synthesized verdict + reasoning recorded inline.

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
installation:<id>:settings  hash
  queen_mode: "cloud" | "local"   (default: "cloud")
```

Read by every cloud-side handler (queen-tick + webhook routes) on entry. If `local`: log + early-return.

## Action surface for local queen (v1)

Two actions, picked by the prompt:

1. **comment** — `gh pr comment <pr> -b "<synthesized verdict + prose>"` (default for any non-trivial review or non-PR room)
2. **squash-merge** — `gh pr merge --squash <pr>` (only when judgment guidelines line up, see prompt design below)

Out of scope for v1: `request_changes`, `dismiss_review`, label management, branch deletion. File as future work; v1 ships with the two highest-value actions.

## Prompt design (load-bearing)

The decision logic lives in the prompt, not in code. Branches in TypeScript would force every governance evolution into a code change; a prompt with judgment guidelines lets repos tune their conventions in their own data layer.

```
ROLE
You are the Hivemoot Queen. You synthesize war-room contributions
into a single governance action and execute it.

CONTEXT (rendered at runtime)
  - Room: {room_id} subject={subject_ref}
  - Participants: {role list with provider tags}
  - Contributions: {each reviewer's prose, role-tagged}
  - PR metadata (when subject_type=pr_review):
      - head_sha, base_branch, mergeable, ci_status
      - labels (e.g. hivemoot:automerge)
      - drift_marker_present: bool
  - Repo conventions: <CONTRIBUTING.md excerpt or per-installation override>

JUDGMENT GUIDELINES (what to weigh, not when to fire)
  - All reviewers approve, CI green, no drift, label `hivemoot:automerge` → squash-merge is reasonable
  - Any concerns / request-changes from any reviewer → post a synthesis comment
  - Mixed signal → post synthesis comment with the consensus + open questions
  - Drift marker present → comment, never merge
  - Non-PR rooms (general / mention) → comment-only

TOOLS YOU HAVE
  - gh pr view / pr comment / pr merge --squash
  - mint installation token via /api/installation_tokens
  - close-with-decision via /api/rooms/:id/close-with-decision
  - war-room read/write via standard endpoints

OUTPUT (always)
  - Pick exactly one action: comment | squash-merge
  - Synthesize the verdict + supporting prose
  - Execute the chosen action via gh CLI
  - Call /api/rooms/:id/close-with-decision to seal the verdict
```

## New surface area

### HTTP endpoints

```
GET  /api/rooms/synthesis-ready
   → list rooms ready for synthesis, gated by rooms.synthesize capability

POST /api/rooms/:id/claim-synthesis
   → TTL'd lease (15min default), gated by rooms.synthesize

POST /api/rooms/:id/close-with-decision
   → close + verdict + content, gated by rooms.synthesize

GET  /api/installations/:id/settings
   → operator-session-gated, returns { queen_mode, byok_status, … }

POST /api/installations/:id/settings
   → operator-session-gated, atomic update with audit event
```

### Capability bundle: new `queen` preset

```yaml
queen:
  - rooms.create              # NEW (today only operator-session UI has this)
  - rooms.synthesize          # NEW
  - rooms.watch               # existing
  - installation_token.mint   # existing
```

The hive queen's bearer gets the `queen` preset. Existing reviewer presets (`drone`, `guard`, etc.) don't change.

### Storage

A single per-installation config hash supersedes ad-hoc storage. BYOK envelope already lives in Redis; this folds queen_mode + future settings under one key.

```
installation:<id>:settings
  queen_mode             "cloud" | "local"
  byok_provider          (existing)
  byok_model             (existing)
  byok_key_encrypted     (existing, moved here)
  queen_prompt_override  (new, optional — see Q1 below)
```

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

Same `messaging-telegram` agent gains a new built-in plugin trigger. Same container, same Codex subscription:

```yaml
plugins:
  - messaging       (existing — Telegram chat)
  - hivemoot-queen  (new — PR discovery + war-room creation + synthesis + action)
```

Plugin config:

```yaml
plugins.hivemoot-queen:
  enabled: true
  poll_interval_secs: 60
  base_url: https://www.hivemoot.dev
  installation_id: 107212709    # which installation this queen serves
  watched_repos:
    - hivemoot/hivemoot
```

Trigger loop body:

```
1. gh pr list --state open across watched_repos        # discover
2. For each PR: if no war room exists → POST /api/rooms (create)
3. GET /api/rooms/synthesis-ready
4. For each ready room:
     a. POST /api/rooms/:id/claim-synthesis            # lease
     b. Read room state via /api/dashboard/rooms/:id
     c. Render queen prompt with room state + PR metadata
     d. Invoke Codex (via existing CLI infra) with the prompt
     e. Parse Codex output: { action, verdict, prose }
     f. Mint installation token via /api/installation_tokens
     g. Execute action: gh pr comment OR gh pr merge --squash
     h. POST /api/rooms/:id/close-with-decision { verdict, content }
```

## Implementation slicing

| PR | Scope | Independence |
|---|---|---|
| 1 | Settings storage: per-installation `queen_mode` Redis hash, GET/POST endpoints | Yes — no reader yet |
| 2 | Cloud-side skip-flag: queen-tick + webhook handlers early-return when `mode=local` | Yes — defaults to cloud, no observable change |
| 3 | New HTTP endpoints + `rooms.synthesize` / `rooms.create` capabilities + `queen` preset | Yes — no caller yet |
| 4 | Hive queen plugin: `hivemoot-queen-pull-loop` trigger, prompt scaffolding, action dispatcher | Depends on PR 1, 3 |
| 5 | `/dashboard/settings` page with Queen mode toggle + heartbeat indicator | Depends on PR 1 |
| 6 | Move BYOK from `/credentials` to `/settings/byok` (cosmetic; redirect old path) | Independent |

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

The fleet's two-pass review (guard's security read + drone's verdict-stack analysis + drone's follow-up on the trigger-loop code paths) reshaped the RFC materially. The biggest finding: the v1-as-drafted version put **prompt injection on the merge path** (guard §1) and discarded the existing **3-layer verdict stack** (drone) that was carefully engineered to be injection-resistant. Both reviewers concluded the mode toggle framing is right but the action-dispatch trust model needs to be inverted: the prompt is *advisory*, deterministic code is *authoritative*. All 15 decisions below carry that single thread.

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

**D6 — Shared dispatch module with defenses + canonical failure ordering.**
Drone follow-up §3: the local queen's action dispatcher must apply the same defenses as `GitHubDecisionPoster`:

- `parseSubjectRef` regex defense (anchored, no shell-meta passthrough)
- `POSTABLE` subject-type gate (`pr_review | mention_response | issue_triage` only)
- Failure ordering: **`close-with-decision` before `gh pr merge --squash`**. Merge is irreversible; it's the LAST operation, after the room is sealed. If merge then fails, the room is correctly recorded as decided + an audit event captures the dispatch failure.

Implementation: a shared module callable from both the cloud `GitHubDecisionPoster` and the hive queen plugin. New defenses go in once, both modes pick them up.

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

PR 1 → PR 2 + PR 3 in parallel → PR 4 (depends on PR 3) → PR 5 (depends on PR 1) → PR 6 (independent).
