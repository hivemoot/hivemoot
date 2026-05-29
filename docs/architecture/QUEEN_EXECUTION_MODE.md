# RFC: Queen execution mode (cloud vs local)

**Status:** Decisions reached — see "Decisions" section below.
**Author:** dkjazz (via this PR)
**Reviewers consulted:** the fleet (hive-guard + hive-drone + hive-builder). Forty review passes total: drone × 19 (verdict-stack analysis + trigger-loop code paths + failure-model inversion + capability annotation audit + repeat verification + post-rewrite stale-name audit + four further consistency-and-coverage sweeps + builder pass-6 verification + builder pass-7 verification + APPROVE + four post-approval war-room verifications + builder-pass-8 final verification), guard × 10 (security audit + post-Decisions APPROVE + comprehensive carry-forward audit pinning G11–G18 + NEW-G19 + post-pass-7 honesty audit pinning G19–G21 + post-046c6f2 implementation-contract audit naming `applyDowngradeOnlyFloor` + pinning G22–G24 + APPROVE + post-f8699b6 verification + post-4ca890c verification + pinning G25–G28 for tick-N+1 contract + post-613a9fe pre-merge-close audit pinning G29–G31 + post-acebb2d expansion pinning G32–G37 — server-side reconciler, report-merge-result endpoint, downgrade retry, PR-3-co-location, 409 on already-closed, D9 stranded-merge extension), builder × 12 (doc coherence → dry-run-comment-failure window + capability preset shape → endpoint name collision + Decisions-prose stale references → cloud-does-nothing-vs-observer reconciliation + capability "moved" wording → endpoint path mixing + D4 label-only + route name → verdict ownership unification + D6 preface + slicing dedup → cost/boundary fix (LLM calls fully local) + D1 invariant cleanup + webhook ownership pinned + minimal `local_queen` capabilities → package boundary (move verdict primitives to `@hivemoot/war-room`) + D16 reconciliation + drop `pr.reopened` from RFC scope + close route name + `approvals` term → state-machine pin (`closed` for comment paths, only `decided_pending_action` is new) + `claim-synthesis` returns composite + `reviewed_head_sha` contract → D4/D6 stale `decided` cleanup + merge-outcome moved from `close_reason` enum to audit field). All reviewer feedback baked into D1–D16, the carry-forward G1–G37 (with G14/G15 reserved for future expansion without renumbering), the two-step `resolve-action` → `seal-decision` endpoint split (builder pass-2 §1; renamed from `decide` per builder pass-3 to avoid colliding with the existing `/api/rooms/:id/decide` claim route), the distinct `local_queen` preset (builder pass-2 §2; `installation_token.mint` is SHARED with apiarist per builder pass-4, not "moved"; `rooms.watch` was dropped per builder pass-7 since the local queen polls `synthesis-ready` rather than `/watching`), G17's load-bearing four-check `comment_url` verification at `seal-decision`, G18's pinned invariant ("irreversible actions only through `resolve-action`"), and the body + Decisions sections rewritten to match the chosen model rather than carrying the original prompt-driven proposal as active guidance.

---

## Why this RFC exists

Today the war-room queen has exactly one shape: a Vercel cron at `/api/internal/queen/tick` that fires every minute, walks open rooms for each installation, claims one ready for synthesis, calls an LLM via the installation's BYOK envelope, and posts a verdict comment back to the PR. Per-token costs hit the operator's BYOK provider account.

This works. But the operator already has a powerful agent on the hive (`messaging-telegram`, queen-class, codex provider) running on a flat Codex subscription — and that agent has shell access, gh CLI, the war-room API, and Codex's reasoning. From the operator's perspective, **the queen-tick is doing a less-capable job using a more-expensive billing model than the hive queen could**.

The proposal: let the operator opt the war-room queen into running on the hive (using the same agent that handles Telegram chat), with the cloud no longer claiming/synthesizing/posting/merging for that installation but still running D8's observer pass (read-only `listRooms` per tick, emitting a stuck-room metric so the dashboard heartbeat alarms when the local queen falls behind). The decision of *what* to do (comment, squash-merge, etc.) is split: Codex *recommends* the action via a structured Zod-validated call, and a server-side dispatcher *enforces* deterministic invariants before any irreversible action runs. **The prompt is advisory; deterministic policy code is authoritative.**

## What's already shared between the two modes

* War-room storage layer (Redis, Lua-scripted atomicity).
* Room lifecycle invariants (heartbeat, awaiting_contributions → deciding → closed).
* Reviewer agents (drone / guard / builder) — they continue to dispatch and contribute regardless of which queen synthesizes.
* GitHub installation tokens (the cloud bot mints them today; the hive queen mints them via `installation_token.mint` capability).

## What's NOT changing

* Reviewer agents — drone, guard, builder, etc. still discover rooms via `/watching`, /present, /contribute exactly as today.
* Storage shape — same room hash, same events log, same participants/contributions sub-keys.
* Webhook subscription — the cloud bot still receives every webhook GitHub sends; we can't unsubscribe per-installation. The new behavior is "cloud reads the installation's `queen_mode` and skips PR review-room create/update plus claim/synthesize/post when local." The cloud still emits D8's stuck-room metric on every queen-tick so the dashboard heartbeat works; the hive queen owns PR discovery and room updates from its watched-repo sweep.
* BYOK envelope — still operator-provided, still encrypted at rest. Just becomes irrelevant when `queen_mode=local`.

## Two modes

| | Cloud (today) | Local (proposed) |
|---|---|---|
| **PR discovery (primary)** | Probot webhook → bot/api creates room on `pr.opened` | Hive queen polls `gh api repos/<repo>/pulls` across `watched_repos` and creates missing `pr_review` rooms. Cloud webhook handlers skip PR room creation while `queen_mode=local`. |
| **Subject state bumps** (head SHA, closed) | Cloud webhook handlers bump room `throughSequence` on `pr.synchronize`/`pr.closed` (the registered handlers in `bot/api/github/webhooks/index.ts`; `pr.reopened` is NOT currently registered and is out of scope for this RFC — adding it would be additive in a follow-on) | Hive queen owns this path too: its sweep emits idempotent `subject_updated` events for observed head/state changes on watched PRs. Cloud webhook handlers skip PR room updates while `queen_mode=local`. |
| **Synthesis (claim → LLM → comment)** | Vercel cron + BYOK LLM call | Codex inside hive queen container — **fully suppressed on cloud** in local mode |
| **Action** | Post comment to PR | Post comment OR squash-merge OR (future) request-changes |
| **GitHub auth** | Bot's installation token | Queen mints installation token via capability |
| **Cost (LLM calls)** | BYOK per-token | Codex subscription (flat) — **all generateObject + generateText calls run locally**, see "Prompt design" below |
| **Cloud's role when local is on** | — | **No PR room create/update and no claim/synthesize/post/merge.** Queen-tick still runs for D8's observer pass (`listRooms` → "rooms-stuck-older-than-N-min" metric), but skips the synthesis/LLM/comment legs. |
| **Failover** | Vercel watchdog + max-age expiration | None — opt-in commits to hive uptime |

## Per-installation toggle

```
hive:v1:installation:<id>:queen-settings   hash
  queen_mode: "cloud" | "local"   (default: "cloud")
  queen_prompt_override: <yaml-encoded blob, optional>  # see D12
```

Read by every cloud-side handler (queen-tick + PR webhook routes) on entry, via the Probot 60s TTL cache (D15). If `local`: skip PR review-room create/update and the claim/synthesize/post path **but still run D8's observer pass** (read-only `listRooms` per tick to emit the stuck-room metric — see PR 2 in the implementation slicing). The BYOK envelope keeps its existing key (`hive:byok:{installationId}`) — relocating it is **out of scope** for this RFC and would need a separate migration plan with key-rotation handling.

## Action surface for local queen (v1)

> **Per D2/D6: actions are Zod-validated structurally, not parsed from prose. The dispatcher is authoritative.**

Two actions, structurally validated by the API at decision time:

1. **comment** — in cloud mode, synthesis prose is posted via the bot's existing `GitHubDecisionPoster` against `decide` + `close`; failure to post does NOT undo room close (today's pattern: room state is source of truth, post is best-effort). In local mode, the hive queen posts via `gh pr comment`, then calls `seal-decision` with the verified comment URL → room transitions to existing `closed` status (with the decision recorded in audit). If `gh pr comment` fails, the queen calls `seal-decision` with `downgrade_reason: intended_action_post_failed` → room still transitions to `closed`, just without merge eligibility. **In both modes the room ultimately transitions to the existing `closed` status; the difference is that local mode's transition is a separate `seal-decision` call gated on the comment-post outcome (see D6 + G17).** No new `RoomStatus` value is needed for the comment path — only `decided_pending_action` is added (D4).
2. **squash-merge** — gated by D1's server-side invariant check (room-level derived verdict == `APPROVE`, `hivemoot:automerge` label, CI green, head SHA stable, no drift). Reviewer-requirement enforcement (CODEOWNERS, required reviews) is deferred to GitHub branch protection at `gh pr merge --squash` time — D1 is additive. Irreversible; **D6 inverts the failure ordering vs comment** — `resolve-action` returns the permitted action first, then the agent posts the intended-action comment, then `seal-decision` requires the verified comment URL to enter `decided_pending_action`, then tick N+1 runs the merge. If any step fails, no merge.

Both follow the two-phase commit state machine (D4): tick N posts the synthesis with the chosen action header → room enters existing `closed` (for comment) or new `decided_pending_action` (for squash-merge) → for `squash-merge`, tick N+1 (≥60s later, ≤15min TTL per G4) re-validates `throughSequence` (G3) + GitHub-side invariants → executes (room transitions to `closed`; the queen audit event records `decision_outcome: merge_approved`) or downgrades (room transitions to `closed`; audit records `decision_outcome: merge_downgraded` with the `reason`). The merge-attempt outcome lives in the queen audit event (D7), not in the existing `TerminalReason` enum (`shared/war-room/src/war-room.ts:206-212` — `expired | failed_synthesis | force_close | manual` is unchanged by this RFC).

Out of scope for v1: `request_changes`, `dismiss_review`, label management, branch deletion. File as future work via code change + capability review per D13.

## Prompt design

> **Per D2/D3: the prompt produces structured outputs validated by Zod schemas. Codex's text output is for prose only. All LLM calls run locally on Codex (flat cost); the server preserves single-source-of-truth via the structural-floor check inside `resolve-action`, not via a server-side LLM call.**

The hive queen makes **two** local `generateObject` calls (verdict + action) and **one** local `generateText` call (prose). All three are local Codex work — flat-cost, no BYOK. The server applies the existing structural-floor logic (`aggregateWorkerVerdicts`) inside `resolve-action` against the verdict the local queen submits, and overrides if the floor disagrees.

```
1. Verdict derivation (D3 — local generateObject, structural floor enforced server-side)
   model.generateObject({
     schema: DerivedVerdictSchema,   // existing — z.enum APPROVE/COMMENT/CONCERNS/REQUEST_CHANGES
     system: <verdict-derivation system prompt — mirrored from cloud-side prompt>,
     prompt: <room contributions wrapped in <untrusted-content> delimiters>
   })
   → { verdict: "APPROVE" | "COMMENT" | "CONCERNS" | "REQUEST_CHANGES" }
   (Validated against the server-side structural floor at resolve-action — see D3 + G1.)

2. Action recommendation (D2 — local generateObject, advisory only)
   model.generateObject({
     schema: RecommendedActionSchema,   // new — z.enum comment/squash-merge
     system: <action-recommendation system prompt with judgment guidelines>,
     prompt: <verdict + room state + PR metadata + override config (D12)>
   })
   → { recommendation: "comment" | "squash-merge", reasoning: <short prose> }

3. Prose synthesis (existing — local generateText)
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

```
# NEW — bearer-gated (capability: rooms.synthesize)
GET  /api/rooms/synthesis-ready
   → list rooms in awaiting_contributions/deciding ready for synthesis

GET  /api/rooms/decided-pending-ready
   → list rooms in decided_pending_action ready for merge confirmation
     (≥60s pending, ≤15min G4 TTL). Distinct from synthesis-ready per G27.

POST /api/rooms/:id/claim-synthesis
   → TTL'd lease (15min default; G4 also caps decided_pending_action at 15min)
   → returns a composite the local queen needs for the prompt:
       {
         claim: { claim_id, sealed_through_sequence, ttl_secs },
         room: <RoomCore — subject_ref, opened_at, status, ...>,
         participants: <list of {actor_id, role, state, ...}>,
         contributions: <list of {actor_id, body, raw_md, withdrawn, ...}>
       }
   The composite avoids a 3-roundtrip pattern (claim → /participants →
   /contributions) and removes ambiguity about what the local queen
   sends to the LLM (builder pass-9 §2). All four sub-resources are
   already gated by the bearer's existing capabilities; the composite
   route just bundles them server-side under a single auth check.

# NEW — bearer-gated (capability: rooms.synthesize). Two-step transaction:
POST /api/rooms/:id/resolve-action
   Body: {
     verdict, content, recommended_action,
     sealed_through_sequence,
     reviewed_head_sha    # required (builder pass-9 §3) — captured by
                          # local queen via fresh `gh pr view` after claim,
                          # server re-reads GitHub head SHA and rejects with
                          # permitted_action="comment" + queen.action_downgrade(
                          # reason: head_sha_drift) on mismatch
   }
   → applies D1's invariant check (incl. head-SHA drift guard), returns
     { permitted_action, audit_id }; writes D7 audit event (including
     G2 queen.action_downgrade when recommendation != permitted_action).
     Room state UNCHANGED yet.

POST /api/rooms/:id/seal-decision
   → completes the transaction. Body must include either:
       { comment_url, final_state: "closed" | "decided_pending_action" }
       OR:
       { final_state: "closed", downgrade_reason: "intended_action_post_failed" }

   When `comment_url` is supplied, the server applies FOUR checks before
   accepting the seal (per G17 — "comment_url is the load-bearing precondition,
   not just a logged input"):

   1. URL must point to the same `subject_ref` PR carried on the room
      (e.g. https://github.com/owner/repo/pull/N where owner/repo#N matches
      the room's subject_ref). Mismatch → 400 invalid_seal_precondition.
   2. Comment author must equal the bot identity behind the installation
      token (not just any user with comment access). The server fetches
      the comment via the bot's installation token and rejects if
      author.login != bot.login. → 400 invalid_seal_precondition.
   3. Comment body must contain the canonical header
      `<!-- hivemoot:queen-action:<verb>:<audit_id> -->` where `audit_id`
      matches the `resolve-action` call this seal claims to follow.
      The audit_id binding prevents replay (a static header can't be
      reused across calls). → 400 invalid_seal_precondition.
   4. Comment `created_at` must be later than the `resolve-action` audit
      event's timestamp. → 400 invalid_seal_precondition.

   Without these, a leaked bearer could skip the comment post entirely
   and seal with a fabricated URL — defeating D14's "no public window
   means no merge eligibility" invariant.

   The seal step is what actually transitions the room. Per builder's pass-2:
   no public override window means no merge eligibility — enforced
   structurally via the four checks above, not by hoping the post succeeded.

POST /api/rooms/:id/confirm-merge
   Body: {
     merge_attempt_id,    # client-generated at tick N+1, distinct from audit_id (G28)
     current_head_sha     # fresh `gh pr view --json headRefOid` at tick N+1
   }
   → server compares current_head_sha against the reviewed_head_sha
     stored against the decided_pending_action claim, re-checks D1's
     other invariants (label, CI, drift), and either approves (room
     transitions to closed; audit decision_outcome=merge_approved
     and a separate github_merge_status field is written after gh pr
     merge --squash actually runs (G29))
     or downgrades (room transitions to closed; audit
     decision_outcome=merge_downgraded with reason). Idempotent on
     merge_attempt_id within 15min (G28); 410 Gone on stale.
     Per G25/G26 the local queen does not need to retain reviewed_head_sha
     across restarts — it only re-fetches current_head_sha from GitHub.

POST /api/rooms/:id/report-merge-result
   Body: {
     merge_attempt_id,
     github_merge_status: "succeeded" | "failed",
     merge_commit_oid?,    # required when status=succeeded
     error_class?          # optional when status=failed
   }
   → server cross-checks against fresh `gh pr view --json state,mergeCommit.oid`;
     rejects 409 status_mismatch on inconsistent claim (G33). Updates the
     audit row's github_merge_status field (initialized as "pending" when
     confirm-merge approved). Idempotent on merge_attempt_id (G33 inherits
     G22/G28's 15min window + 410 Gone on stale).
   → also called by the server-side reconciler (G32) when the local queen
     has not reported within 2min — server reads PR state and writes the
     status itself. The reconciler bypasses the bearer-side cross-check
     since it IS the cross-check.

# EXISTING — already in production, listed here so PR 4's plan is correct
GET  /api/rooms/:id
   → bearer-gated by `rooms.read_all`, exists at
     web/src/app/api/rooms/[roomId]/route.ts:28-34. Returns RoomCore.
     The local queen uses this directly — no need to reach for the
     operator-session-gated dashboard composite route.

# NEW — operator-session-gated
GET  /api/installations/:id/queen-settings
   → returns { queen_mode, queen_prompt_override }

POST /api/installations/:id/queen-settings
   → atomic update with audit event (D9 blocks on in-flight rooms;
     G6 force-expire-claims path requires confirmation modal + audit event)
```

### Capability bundle: new `local_queen` preset (distinct from existing `queen`)

The existing `queen` preset is room-management-only (`rooms.create / read / read_all / update / decide / close` + tasks visibility + agent_health.report). It deliberately does **not** include `installation_token.mint` — that's `apiarist`'s capability today.

Adding `installation_token.mint` to `queen` would silently expand the preset's blast radius from "can manipulate war rooms" to "can mint GitHub write-tokens on covered repos." A leaked queen bearer today can't merge PRs; a leaked queen bearer post-expansion could. Per builder's pass-2 review, this is the wrong shape.

Instead, a **distinct preset** for local-mode bearers makes the elevated privilege explicit:

```yaml
local_queen:
  # Existing queen preset (unchanged — operators on cloud mode keep using `queen`):
  - agent_health.report
  - tasks.create
  - tasks.read
  - tasks.cancel
  - rooms.create              # subject-type allowlist enforced server-side per G3
  - rooms.read
  - rooms.read_all
  - rooms.update
  - rooms.decide
  - rooms.close

  # New for local mode:
  - rooms.synthesize          # NEW — additive per D14, gates GET /api/rooms/synthesis-ready, GET /api/rooms/decided-pending-ready, POST claim-synthesis, POST resolve-action, POST seal-decision, POST confirm-merge, POST report-merge-result
  - installation_token.mint   # SHARED with apiarist — apiarist keeps it; local_queen ALSO gets it, gated by D10 token policy (allowed_repos + allowed_permissions)
  - pull_requests.merge       # explicit merge-capable minting; excluded from wildcard expansion and only valid with D10's exact merge policy
```

`rooms.watch` is **not** included — that capability gates `/api/rooms/watching` (worker subscription discovery for `/present`/`/contribute`). The local queen polls `/api/rooms/synthesis-ready` (gated by `rooms.synthesize`) instead, so `rooms.watch` would be unused privilege per the principle of minimal capability bundles (builder pass-7 §5).

The cloud queen keeps using the existing `queen` preset (no change). Local-mode bearers use `local_queen`. **Three paths in total: existing reviewer presets (drone/guard/etc.), existing `queen` preset (cloud queen), new `local_queen` preset (hive queen). No silent expansion of any existing preset.**

Per D14, the new `rooms.synthesize` capability gates the new `resolve-action` + `seal-decision` endpoint pair. Existing `rooms.decide` and `rooms.close` capabilities continue to gate the existing endpoints, which the cloud queen continues to use.

### Storage

```
hive:v1:installation:<id>:queen-settings   hash
  queen_mode             "cloud" | "local"           # D15 caches with 60s TTL
  queen_prompt_override  <yaml-encoded structured config — D12>

hive:byok:{installationId}                 hash    # existing — see byok-store.ts:11; out of scope for this RFC
  provider, model, key_encrypted, ...                # NOT relocated; see PR 6 scope note

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

Mode-toggle confirmation step (text aligned with D16's reconciled local-outage characterization): "Switching to local — the hive queen becomes the only path that discovers PRs, creates/updates PR review rooms, synthesizes verdicts, and posts actions on PRs. The cloud will emit a 'rooms-stuck-older-than-N-min' alarm if the local queen falls behind, but no cloud fallback will create rooms or synthesize decisions. Make sure your hive queen has uptime monitoring before flipping. Proceed?" Once flipped, the dashboard surfaces three signals: (a) the agent's self-reported heartbeat, (b) the cloud's observer-side stuck-room metric, and (c) local PR sweep health — together they are the alarm surface.

### Operational smoke

A local-mode rollout is not complete when the runner starts. Before the smoke, confirm the runner is using a `local_queen` token scoped to the watched repo and that `queen.watched_repos` includes it. Operators should first run a comment-only smoke (`enable_squash_merge=false`) against a tiny, ready-linked PR in a watched repo and verify three observable facts: the local queen sweep created a room, at least one reviewer contributed, and the hive queen posted the final synthesis. If those signals do not appear before the stuck-room alarm threshold, flip `queen_mode` back to `cloud` and investigate. Only after the comment-only smoke passes should `enable_squash_merge=true` be enabled and tested with a designated low-risk automerge-eligible PR the operator controls; otherwise a broken local queen can look healthy while PRs pile up unsynthesized or the first squash-merge test can become an unintended production merge.

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
      watched_repos:
        - hivemoot/hivemoot
      pr_discovery_interval_secs: 900

  messaging:
    telegram:         { enabled: true, ... }     # existing — Telegram chat
```

Same `messaging-telegram` agent (or a separate `hivemoot-queen` apiary service) loads this consolidated config. The queen feature only activates when `queen.enabled=true` AND the bearer has `rooms.synthesize`. Disabled by default; opting an installation into local mode flips this on per-agent.

### D6 boundary: server-side dispatcher, not literal code sharing

D6's "shared module callable from both" was imprecise — TypeScript bot/web code is not directly callable from the Python agent runtime (separate processes, different language). The actual boundary is the new `POST /api/rooms/:id/resolve-action` + `POST /api/rooms/:id/seal-decision` endpoint pair (server-side TypeScript). **Only the local-mode path hits this pair**; cloud queen continues on its existing `decide` + `close` route per G18. The pair owns:

- D1's invariant check (server reads label/CI/SHA/drift fresh from GitHub at decision time)
- D6's failure ordering branch (`comment` follows today's flow; `squash-merge` is rejected at this endpoint if invariants fail — the agent then independently runs `gh pr merge`)
- D7's audit event write (single source of truth for action records on the local-mode path)
- G2's `queen.action_downgrade` event when `chosen_action != permitted_action`

**The two modes use different endpoints with different capabilities, by design (D14, G18):**

- **Cloud queen** — continues using existing `decide` (synthesis claim, gated by `rooms.decide`) + `close` (gated by `rooms.close`) routes, action surface is **comment-only** via the existing `GitHubDecisionPoster`. Does NOT invoke `resolve-action` and does NOT inherit D1's invariant check. Safe today because cloud has no irreversible actions; pinned invariant per G18 is that any future irreversible cloud action MUST first route through `resolve-action`.

- **Local queen** — uses the new `resolve-action` + `seal-decision` endpoint pair (gated by `rooms.synthesize`), action surface is **comment OR squash-merge**, posts via `gh pr comment` and `gh pr merge --squash` from inside the hive container. D1's server-side invariant check, the four-check `comment_url` verification, the two-phase commit state machine all live on this path.

Both modes share the same Redis storage shape; what differs is the endpoint pair each mode uses to claim synthesis and post the final action. Cloud and local will never compete for the same room in v1 because the per-installation `queen_mode` toggle directs each installation to exactly one path.

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
       b. POST /api/rooms/:id/claim-synthesis (15min TTL) — returns the
          claim + room + participants + contributions composite (builder
          pass-9 §2). Handle 5 distinct benign-409 codes per D5:
          claim_already_held, invalid_status_for_claim, sequence_drift,
          claim_lost, claim_through_seq_mismatch.
       c. Post-claim re-validation (D5): re-check participants for re-RSVP
          / non-final-withdrawal races since claim
       d. Withdraw-finality check (D5): compare withdrew_at_sequence vs
          throughSequence; skip if not final
       e. Fetch fresh head_sha from GitHub (G21 client-side safety net):
          gh pr view <pr> --json headRefOid → reviewed_head_sha

       # Two local generateObject calls (D2, D3) — both run on Codex (flat cost)
       f. Codex.generateObject(DerivedVerdictSchema) → { verdict }
       g. Codex.generateObject(RecommendedActionSchema) → { recommendation, reasoning }

       # D1's invariant check + structural-floor check + D7 audit
       h. POST /api/rooms/:id/resolve-action {
            verdict, content, recommended_action,
            sealed_through_sequence: <claim's throughSequence>,
            reviewed_head_sha: <SHA captured in step e>
          }
          → server runs aggregateWorkerVerdicts (structural floor); if the
            floor disagrees with the submitted verdict, server overrides and
            emits queen.verdict_floor_override audit (G1).
          → server applies D1's invariant check using the FINAL verdict;
            returns permitted_action; writes D7 audit (plus G2
            queen.action_downgrade if recommendation != permitted).
            Room is NOT yet transitioned.

       # Mint token + post intended-action comment FIRST — comment URL
       # becomes the precondition for the state transition
       i. Mint installation token via /api/github/installation-tokens
          (D10 policy: pull_requests:write, issues:write, metadata:read,
           allowed_repos = watched_repos)
       j. If permitted_action == "comment":
            gh pr comment <pr> -b <prose>
            → POST /api/rooms/:id/seal-decision {
                comment_url: <gh response url>,
                final_state: "closed"
              }
       k. If permitted_action == "squash-merge":
            gh pr comment <pr> -b <prose-with-intended-action-header>
            → if comment fails: POST /api/rooms/:id/seal-decision {
                final_state: "closed",
                downgrade_reason: "intended_action_post_failed"
              }
              # downgraded to comment-only because the operator-override
              # window never became visible
            → if comment succeeds: POST /api/rooms/:id/seal-decision {
                comment_url: <gh response url>,
                final_state: "decided_pending_action"
              }
              # room enters pending state ONLY after the comment with the
              # intended-action header is verifiably published. Tick N+1
              # (≥60s, ≤15min per G4 TTL) re-validates throughSequence (G3)
              # + GitHub-side invariants, then runs gh pr merge --squash;
              # downgrades to comment if anything changed since tick N
```

This split — `resolve-action` returns the permitted action, then `seal-decision` records the verified comment URL and transitions state — is the architectural fix for builder's pass-2 §1: a failed intended-action comment can never leave a room in `decided_pending_action`. No public override window means no merge eligibility.

## Implementation slicing

| PR | Scope | Independence |
|---|---|---|
| 1 | Settings storage: `hive:v1:installation:<id>:queen-settings` Redis hash (the BYOK envelope at `hive:byok:{installationId}` is unchanged; this RFC explicitly does not relocate it), operator-session GET/POST endpoints, Probot 60s TTL cache (D15 + G7 default-to-cloud on Redis-down). Mode-flip endpoint atomic per G12 (Redis MULTI/EXEC or per-installation flip-lock so cloud queen-tick can't claim between the in-flight check and the mode write) | Yes — no reader yet |
| 2 | Cloud-side mode skip: queen-tick + PR webhook handlers SKIP PR review-room create/update and claim/synthesize/post when `mode=local` BUT still run D8's observer pass (read-only `listRooms`, emit "rooms-stuck-older-than-N-min" metric per G5 thresholds). Mode-flip blocks on in-flight rooms (D9), force-expire requires confirmation modal + audit event (G6) | Yes — defaults to cloud, no observable change |
| 3 | **Prep step**: move verdict primitives (`applyDowngradeOnlyFloor`, `aggregateWorkerVerdicts`, `mostConservative`, `extractContributionVerdict`, `DerivedVerdictSchema`) from `bot/api/lib/queen/verdict-deriver.ts` into `@hivemoot/war-room` (per builder pass-8 — web doesn't import bot; both bot and web import the shared package). New HTTP endpoints (`synthesis-ready`; `decided-pending-ready` per G27; `claim-synthesis` returning the room+participants+contributions composite per builder pass-9 §2; `resolve-action`; `seal-decision`; `confirm-merge` per G25 with `merge_attempt_id` per G28; `report-merge-result` per G33 with server-side cross-check). **Server-side reconciler (G32, load-bearing)**: scans rooms `closed + decision_outcome: merge_approved + github_merge_status: pending` older than 2 min, reads PR state via App-installation token, writes the resulting `github_merge_status`. Bounded by G32's 15-min reconcile window. **`409 invalid_status_for_confirm_merge`** for the already-closed-room case (G36) added to D5's benign-409 set. D9 mode-flip extension (G37): block flip on stranded-merge state. New `rooms.synthesize` capability. New **`local_queen` preset** (distinct from existing `queen` per builder pass-2; explicitly includes `installation_token.mint` and `pull_requests.merge`, names the elevated privilege). Token policy with `contents: "write"` merge scope verified by test (G9). Inside `resolve-action`: structural-floor check via `applyDowngradeOnlyFloor` (G1) → head-SHA drift guard re-reading GitHub (D1 + builder pass-9 §3, fields `reviewed_head_sha` on the request body, server-side comparison at decision time) → D1 invariant check using final verdict → G2 `queen.action_downgrade` audit event (incl. `head_sha_drift` reason) + G1 `queen.verdict_floor_override` audit. D6 failure-ordering split: `resolve-action` returns `permitted_action`; `seal-decision` requires verified comment URL or downgrade reason. State machine: `seal-decision` writes `final_state: "closed"` for comment + downgrade-comment paths (existing `RoomStatus`), `"decided_pending_action"` for squash-merge intent (the only NEW `RoomStatus` — per builder pass-9 §1, comment paths reuse `closed` rather than introducing a new `decided` state). Rate caps on `rooms.create` (D11) AND on `resolve-action` + `seal-decision` (G11). `decided_pending_action` carries `reviewed_head_sha` for tick-N+1 re-comparison. | Depends on PR 1's storage |
| 4 | Hive queen feature block under `plugins.hivemoot.queen`. Three trigger paths: (a) **PR discovery/update sweep** polls watched repos with `gh api`, creates missing `pr_review` rooms, and emits idempotent `subject_updated` events for observed head/state changes; (b) **synthesis loop** polls `synthesis-ready`, applies D5's race mitigations, captures `reviewed_head_sha` via fresh `gh pr view --json headRefOid` after `claim-synthesis` (builder pass-9 §3 + G21), runs two local `generateObject` calls (D2/D3) on Codex flat cost, submits to `resolve-action`, posts comment, calls `seal-decision`; downgrade-comment retries with backoff (G34) emit `queen.downgrade_comment_failed` audit on persistent failure; (c) **confirm-merge loop** polls `decided-pending-ready` (G27, separate query), captures fresh `current_head_sha`, generates `merge_attempt_id` (G28, separate from `audit_id`), calls `confirm-merge` (G25), runs `gh pr merge --squash`, calls `report-merge-result` (G33). Loads structured override config (D12). Operator setup guide pinned to require GitHub branch protection per G31. | Depends on PR 3 |
| 5 | `/dashboard/settings` page with Queen mode toggle + heartbeat indicator (combining agent self-report and D8's cloud-observer metric). Structured override config UI (D12). Confirmation step on mode-flip surfaces D9 + G6's blocking conditions. **Mandatory PR 5 scope**: per-installation local PR sweep health (last successful watched-repo scan, create/update errors) AND "merge-approved-but-not-completed" reconciliation alarm (G30) are first-class dashboard elements, not implied by the row's "heartbeat" shorthand. Treat both as required, not optional, even if the row text reads as a settings page. The load-bearing safety mechanism for stranded merges remains G32's server-side reconciler in PR 3 (G35); PR 5 surfaces visibility, PR 3 surfaces remediation. | Depends on PR 1 |
| 6 | Move BYOK UI from `/credentials` to `/settings/byok` (cosmetic; redirect old path). **Storage key NOT relocated** — only the dashboard route moves. | Independent |

## Original open questions (all resolved by the fleet)

The original RFC posed six questions to the fleet; all are resolved in the Decisions section. Annotated here for reference rather than re-reading as active.

**Q1.** Prompt location → **Resolved by D12.** Hardcoded base + per-installation **structured** override (not free-form text). Operator can tune for repo-specific conventions but the override is bounded by a YAML schema (`merge_conventions`, `additional_blockers`).

**Q2.** Drift-marker handling → **Resolved by D1's drift-guard invariant.** Drift marker present → server rejects merge action regardless of recommendation; comment posted instead. No auto-re-merging on drift, no automation surface for push-then-revert games.

**Q3.** `rooms.create` capability gating → **Resolved by D11.** Subject-type allowlist already enforced server-side (`pr_review | mention_response | issue_triage`); rate cap added per-bearer + per-installation per minute.

**Q4.** Action-surface scope-creep → **Resolved by D13.** Hard-coded enum (`comment | squash-merge`) for v1. New verbs go through code review + capability review.

**Q5.** Multi-installation per hive → **Resolved.** Keep one-per-installation. Multiple bearers = multiple agents; multiplexing isn't worth the bookkeeping at small N.

**Q6.** Misbehaving local queen → **Resolved by D1 + D4 + D7 + G2.** Server-side invariants (D1) + two-phase commit state machine (D4) + dispatcher writes audit (D7) + structured downgrade event (G2). Three layers of defense; the prompt is advisory throughout.

## Outcome I was looking for

Not a +1. The fleet's read on:
* Whether mode-toggle is the right shape vs always-on local + cloud-as-watchdog vs some other framing.
* Whether the prompt-driven action dispatch is the right primitive vs a structured-output action enum.
* Specific reads on Q1–Q6 above.
* Anything not seeing — particularly around capability scope, audit trails, and migration.

Got far more than that — guard found §1 (the prompt-injection-on-merge-path), drone preserved the verdict stack and caught the failure-model inversion, builder caught the doc coherence + capability annotation errors. The 16 decisions + 9 carry-forward implementation notes below reflect three reviewer passes' cumulative findings.

---

## Decisions (post fleet review)

The fleet's three-pass review (guard's security read + drone's verdict-stack analysis + drone's two follow-ups on trigger-loop code paths and the cloud→local failure-model inversion) reshaped the RFC materially. The biggest finding: the v1-as-drafted version put **prompt injection on the merge path** (guard §1) and discarded the existing **3-layer verdict stack** (drone) that was carefully engineered to be injection-resistant. Both reviewers concluded the mode toggle framing is right but the action-dispatch trust model needs to be inverted: the prompt is *advisory*, deterministic code is *authoritative*. All 16 decisions below carry that single thread.

Where guard's reasoning shaped a decision verbatim, it's quoted.

### Architectural (load-bearing)

**D1 — Server-side merge invariants enforced at `resolve-action` (per the two-step resolve-action → seal-decision split).**
Guard §1 (rephrased to current endpoint names): *"the merge decision MUST NOT be a string Codex emits. It must be a server-side invariant the dispatcher endpoint re-validates after receiving the verdict."* The new `resolve-action` endpoint re-reads from GitHub at decision-time:

- **Room-level derived verdict == `APPROVE`** (taken from the structural floor `aggregateWorkerVerdicts` server-side; if the floor is non-decisive — which is the modern default per D3's honesty note — the local-queen-submitted LLM verdict is used after Zod validation. See D3 + G1).
- `hivemoot:automerge` label present
- CI status green per GraphQL `commit.statusCheckRollup`
- **Head SHA drift guard** (builder pass-9 §3): the local queen captures `reviewed_head_sha` from a fresh `gh pr view --json headRefOid` call AFTER `claim-synthesis` and BEFORE running the LLM, then submits it as a required field on `resolve-action`'s body. `resolve-action` re-reads head SHA from GitHub server-side at decision time and rejects with `permitted_action: "comment"` + `queen.action_downgrade(reason: head_sha_drift)` if `reviewed_head_sha != current_github_head`. For squash-merge, `seal-decision` stores `reviewed_head_sha` on the room (new audit row associated with the `decided_pending_action` claim — not a new `RoomCoreData` field, per builder pass-10's storage-contract caution); at tick N+1, the local queen re-fetches head SHA from GitHub and compares against `reviewed_head_sha` BEFORE `gh pr merge --squash` — any mismatch downgrades to comment, recorded in the queen audit event as `decision_outcome: merge_downgraded` + `reason: head_sha_drift_at_tick_n1` (audit field, not a `TerminalReason`). **The reviewed SHA never comes from `throughSequence` or update-event state** — local sweep health is the load-bearing dependency G21 covers, and using event-derived state for the drift guard would mean missed update events could bypass the guard. The reviewed SHA always comes from a fresh GitHub read.
- `last_post_close_drift_*` unset

**Reviewer-requirement enforcement is deferred to GitHub** (guard pass-5): D1's invariants do NOT include "all required reviewers approved" because today's worker contributions store all review text in `raw_md` with `body = {}` (`agent/cli/hivemoot_agent/plugins_builtin/hivemoot/war_rooms/handler.py:277-284`); per-reviewer verdicts aren't deterministically extractable. CODEOWNERS, required reviews, and any other reviewer-side gates are enforced by GitHub branch protection at `gh pr merge --squash` time — D1's invariants are **additive guards on top of branch protection, not a replacement**. Operators on permissive branch-protection settings should pin their reviewer requirements at the GitHub side; the local queen will respect whatever the GitHub merge endpoint allows.

If any fail, the endpoint returns `permitted_action: "comment"` AND writes a structured `queen.action_downgrade` audit event (G2) capturing the divergence between `recommended_action` and `permitted_action`. The verdict prose surfaces the downgrade reason; the audit event surfaces the security signal to operators on a separate dashboard channel. **The prompt picks the verb; the API enforces the invariant; the divergence is loud, not silent.**

**Asymmetry to lock down (G18):** D1's invariant check lives only at `resolve-action`. Cloud queen's existing flow (using `decide` + `close` capabilities for the historical comment-only path) does NOT invoke `resolve-action` and therefore does NOT inherit D1. This is safe today because **cloud queen's action surface is comment-only — no merge, no irreversible actions**. Pinned as an invariant: any irreversible action (squash-merge, label management, branch deletion, etc.) MUST go through `resolve-action` regardless of which mode is requesting it. Cloud queen cannot evolve to support merge without first routing through the new endpoint pair. A future RFC that touches this should re-open D1 explicitly.

**D2 — Action enum is Zod-validated `generateObject`, not parsed from prose.**
Drone: *"the action enum should get the same structural treatment as the verdict enum."* The hive queen runs **two** local `generateObject` calls — both on Codex (flat cost, no BYOK):
1. Verdict via existing `DerivedVerdictSchema` (`z.enum(["APPROVE", "COMMENT", "CONCERNS", "REQUEST_CHANGES"])`)
2. Action via new `RecommendedActionSchema` (`z.enum(["comment", "squash-merge"])`)

Both outputs are submitted to `resolve-action`, which (a) runs the existing structural floor `aggregateWorkerVerdicts` server-side and overrides the verdict if the floor disagrees (G1), then (b) applies D1's invariants against the final verdict to derive `permitted_action`. No verb is ever parsed from text output. The "single source of truth" for the verdict logic stays server-side (the structural-floor function and Zod schema both live in `bot/api/lib/queen/`); only the model call moves to the hive container.

**D3 — Verdict stack preserved (structural floor at the server, LLM call local).**
Drone: *"the local queen doesn't have to throw away the verdict stack."* The 3-layer pipeline still runs end-to-end, just split across the boundary: layer 1 (`aggregateWorkerVerdicts`) is **server-side**, evaluated inside `resolve-action` against the verdict the local queen submits — if the floor is decisive (e.g. any worker contribution carries `body.verdict = REQUEST_CHANGES`), the server overrides any submitted enum and emits a `queen.verdict_floor_override` audit event (G1). Layer 2 (`deriveVerdictFromContributions`'s LLM call) becomes the **local** Codex `generateObject` call against the same `DerivedVerdictSchema`. Layer 3 (prose synthesis) also runs locally via `generateText`. This keeps a single source of truth for the **structural rules and enum schema** (server-side TypeScript) while moving the **LLM cost** to the local Codex subscription. Schema drift is caught by the server's Zod validation when the local queen submits.

**Honesty note about the structural floor's current reach** (guard pass-5): `aggregateWorkerVerdicts` reads `extractContributionVerdict(c)` which only returns a verdict when `contribution.body.verdict` is set. Per `bot/api/lib/queen/verdict-deriver.ts:1-15` and the post-simplification triage flow, **modern workers submit free-form markdown with `body = {}`**, so the floor returns its non-decisive default (`COMMENT`) for nearly every real room. Practical implication: under the current contribution shape, the server's structural floor is **dormant** as a cross-check on the local queen's submitted enum — D1's verdict gate effectively trusts the LLM-derived enum after Zod validation. **The actual merge anchor in local mode is the `hivemoot:automerge` label** (human-controlled, GitHub-side) plus CI / SHA / drift, not the structural floor. The floor stays in `resolve-action` so that **if** PR 3 (or a follow-on RFC) re-introduces structured `body.verdict` from workers, the cross-check engages without further changes; today it's a forward-compatible scaffold, not a load-bearing check. If verdict-side trust matters more in v1.5, "re-introduce structured `body.verdict` from workers" is the natural follow-on.

**Implementation primitive: PR 3 calls `applyDowngradeOnlyFloor`, not raw `aggregateWorkerVerdicts`** (guard pass-6). The codebase already has the correct primitive at `bot/api/lib/queen/verdict-deriver.ts:194-204` — its docstring at `:188-192` warns explicitly: *"`aggregateWorkerVerdicts` would return `COMMENT` in that case, which would silently cap `APPROVE`-class outputs — that's wrong here: the floor only applies when explicit structured verdicts are present."* A naïve "if floor disagrees with submitted verdict, override" implementation that called `aggregateWorkerVerdicts` directly would clamp every local-queen `APPROVE` to `COMMENT` (because `COMMENT` is "more conservative" than `APPROVE` per the `mostConservative` ordering at `:215-225`) and silently break every merge. **`resolve-action` MUST use `applyDowngradeOnlyFloor` semantics: clamp ONLY when `anyStructured` is true; pass through the LLM verdict unchanged otherwise.** Naming this primitive in the RFC prevents the trap at PR 3 review time.

**Package boundary** (builder pass-8): the new `resolve-action` endpoint lives in the **web** API surface (`web/src/app/api/rooms/[roomId]/resolve-action/route.ts`), but `applyDowngradeOnlyFloor` + `aggregateWorkerVerdicts` + `mostConservative` + `extractContributionVerdict` + `DerivedVerdictSchema` are private inside the **bot** package today. `web/package.json` does not depend on `bot`; it depends on `@hivemoot/war-room`. **PR 3 must move the verdict primitives + Zod schema out of `bot/api/lib/queen/verdict-deriver.ts` into `@hivemoot/war-room` (the shared package both bot and web import from) as a prep step before wiring `resolve-action`.** Bot's existing manager loop then imports from `@hivemoot/war-room` instead of its local `lib/queen/`. A web→bot import or a duplicated copy of the merge gate would create hidden drift in the exact policy path this RFC centralizes; the move keeps the single source of truth.

**D4 — Two-phase commit state machine for merge.**
Guard §4 + drone: drop the opt-out flag; the `require_dry_run_for_merge` second-tick flow is mandatory in v1. New room state `decided_pending_action`:

- **Tick N (synthesis):** verdict + action derived → if action=`squash-merge` and D1 invariants pass, comment posted with "intended action: squash-merge" header → room enters `decided_pending_action`.
- **Tick N+1 (≥60s later):** queen polls `decided-pending-ready` (G27), generates `merge_attempt_id` (G28), fetches fresh `current_head_sha` via `gh pr view --json headRefOid`, calls `POST /api/rooms/:id/confirm-merge` (G25). Server re-validates `throughSequence` (G3: any room-state change since tick N bumps the sequence and reopens the question) AND the GitHub-side invariants: `hivemoot:hold` label NOT present (per G13: label-only override for v1, no free-form text scanning), `current_head_sha == reviewed_head_sha`, CI still green, expected labels still present, `last_post_close_drift_*` still unset → returns approval (room transitions to `closed`; queen runs `gh pr merge --squash`). Any of those failing → returns downgrade (room transitions to `closed` with audit `decision_outcome: merge_downgraded`); queen runs `gh pr comment` with the downgrade prose. Per G25/G29, the decision-side outcome (`merge_approved` / `merge_downgraded`) is recorded in the queen audit event's `decision_outcome` field; the action-side outcome (the actual `gh pr merge --squash` result) is recorded separately in `github_merge_status` (D7). Neither is a new `TerminalReason` value.

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
- **Failure ordering: server-side `resolve-action` (durable) → comment post (verified URL) → server-side `seal-decision` (state transition) → tick N+1 → `gh pr merge --squash` (irreversible). This is the inverse of today's `GitHubDecisionPoster` pattern.**

Drone: *"The current `GitHubDecisionPoster` enforces: failure to post to GitHub does NOT undo the room close. The decision is durable; the post is best-effort. For squash-merge, this model inverts. `gh pr merge --squash` is irreversible."*

Today's flow (cloud): close room → post comment. Comment-post failure is recoverable; room-state is source of truth.

Local queen flow (new): `resolve-action` (server-side invariant check + audit, no state transition) → mint installation token → post intended-action comment via `gh pr comment` → `seal-decision` (transitions to existing `closed` for the comment path or new `decided_pending_action` for squash-merge intent, based on whether comment_url was verified) → tick N+1 (≥60s, ≤15min G4 TTL): local queen polls `decided-pending-ready` (G27), fetches fresh `current_head_sha` from GitHub, generates `merge_attempt_id` (G28), calls `confirm-merge` (G25) — server re-validates throughSequence + GitHub-side invariants and either approves (room transitions to `closed`, audit `decision_outcome: merge_approved`, local queen runs `gh pr merge --squash`) or downgrades (room transitions to `closed`, audit `decision_outcome: merge_downgraded`). If `resolve-action` fails, no merge. If comment fails between `resolve-action` and `seal-decision`, `seal-decision` is called with `downgrade_reason: intended_action_post_failed` and the room transitions directly to `closed` with no merge eligibility. If `confirm-merge` returns downgrade, the local queen runs `gh pr comment` with the downgrade prose and does NOT run `gh pr merge`.

**Expected behavior — agent crash between `resolve-action` and `seal-decision`:** if the queen agent crashes after `resolve-action` succeeds but before `seal-decision` is called, the room remains in `awaiting_contributions` or `deciding` (no state transition happened). The `resolve-action` audit event becomes a harmless historical record. The next tick's `synthesis-ready` query surfaces the room again and the queen re-claims and re-derives. **This is expected, not a bug** — `resolve-action` is intentionally idempotent at the audit-log level (multiple entries are fine) but transitionless until `seal-decision` arrives.

Implementation: the **server-side `resolve-action` + `seal-decision` endpoints** are the shared enforcement point **for the local-mode path specifically**. TypeScript bot/web isn't directly callable from the Python agent runtime (separate processes, different language) — the actual single source of truth is the network boundary. The hive queen's Python plugin builds its own request and executes the GitHub action only after the endpoint approves it; the policy decision (D1's invariant check, G17's `comment_url` verification, G2's downgrade audit) is server-side and uniform per the endpoint contract. Cloud queen continues using its existing `GitHubDecisionPoster` against `decide`/`close` per G18 — D6's failure-ordering inversion only applies to the local-mode `squash-merge` action, since cloud has no merge surface.

### Mechanism / policy

**D7 — Dispatcher writes audit events, not Codex's self-report.**
Guard §5: *"don't trust Codex to self-report the action it took."* The action dispatcher (the `gh pr X` subprocess wrapper) emits the audit event with: `{actor: AGENT_ID, decision-prompt-hash, override-hash, action-attempted, action-actual, exit-code, room_id}`. Server-side `resolve-action` records the canonical permitted_action it returned, and `seal-decision` records the verified comment_url (or downgrade_reason). Both are separate from any prose self-description. The local queen does not configure a separate runner identity; the protocol's `queenRunner` field carries the same `AGENT_ID` used everywhere else for the agent.

**D8 — Cloud observes via metrics in local mode + retains webhook-driven state (not failover, alarm).**
Guard §6 + drone agreement: in `queen_mode=local` the cloud queen-tick reads the room list, **doesn't claim or synthesize**, and emits one metric per installation: "rooms ready for synthesis older than N minutes." The dashboard heartbeat surfaces both the agent's self-reported heartbeat AND the cloud's view. If the agent self-reports healthy but the cloud sees rooms piling up, the dashboard alarms. *"The self-reported heartbeat from a hung process is famously unreliable"* — guard.

**Webhook-driven state is also retained on cloud in local mode** (builder pass-7 §3): cloud's existing webhook handlers continue to fire on `pr.opened` (creates the room), `pr.synchronize`/`pr.closed` (bumps `throughSequence`), and contribution events (bumps `throughSequence`). `pr.reopened` is NOT currently registered in `bot/api/github/webhooks/index.ts` and is out of scope for this RFC; adding it would be additive in a follow-on PR. Local queen relies on these bumps for sequence-staleness detection — its claim's `sealed_through_sequence` invalidates if the PR or contributions change between claim and `resolve-action`. The hive queen's `gh pr list` poll is a **backstop** for missed webhook events; the `subject_already_open` 409 makes double-creation benign. Cloud is not a pure read-only observer — it remains the primary writer for room creation + state bumps. The only cloud-side leg suppressed in local mode is the queen-tick synthesis path (claim → LLM → comment).

**D9 — Mode-flip blocks on in-flight rooms.**
Guard §7 + drone: the mode-flip endpoint refuses if any room is in `deciding` state with a non-expired claim, OR in `decided_pending_action` (the second-tick window). Operator must wait for in-flight work to settle or explicitly force-expire claims. Avoids the ambiguous-ownership state where cloud thought it was synthesizing but local takes over mid-flight.

**D10 — Queen-mode token policy: merge-capable permissions + per-repo allowlist.**
Guard §8 updated after GitHub's merge endpoint permission requirement was verified: when the dashboard mints a merge-capable local-queen bearer, it sets `policy.allowed_permissions = { contents: "write", pull_requests: "write", issues: "write", metadata: "read" }`. The `contents: "write"` grant is for GitHub's squash-merge endpoint, not for local verdict synthesis; the bearer must also hold explicit `pull_requests.merge`, which wildcard expansion excludes. `policy.allowed_repos` is exactly the `watched_repos` config list. Both halves are enforced at token-mint time.

**D11 — `rooms.create` rate-capped per bearer + per installation.**
Guard §2: the existing subject-type allowlist is already in place at `web/src/app/api/rooms/route.ts:35-39`; the gap is the rate cap. Add per-bearer-per-minute and per-installation-per-minute caps on the `rooms.create` route. Structured-warn telemetry on near-limit hits. Don't tie to subject_type — the storage cost is the same regardless.

**D12 — Prompt override is structured YAML config, not free-form text.**
Drone: *"free-form prompt override is a loaded gun pointed at the merge gate."* The override schema (stored as the `queen_prompt_override` field of `hive:v1:installation:<id>:queen-settings`):

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
Drone follow-up §2: *"two paths, two capability sets, no migration."* The new `rooms.synthesize` capability gates the new `synthesis-ready` + `claim-synthesis` + `resolve-action` + `seal-decision` endpoints. Atomicity is per-step (each call is its own atomic transaction; the multi-step flow's safety comes from `seal-decision`'s precondition check on `comment_url`, not from atomicity across calls). Existing `rooms.decide` and `rooms.close` capabilities continue to gate the existing endpoints, which the cloud queen continues to use. The new `local_queen` preset bundle includes `rooms.synthesize` + `installation_token.mint` (shared with apiarist — apiarist keeps it) on top of the existing `queen` preset; `rooms.watch` is intentionally NOT included (per builder pass-7 §5: the local queen uses `synthesis-ready`, not `/watching`). See "Capability bundle" section for the full list and rationale.

**D15 — Webhook `queen_mode` cached in Probot with 60s TTL.**
Drone follow-up minor: cloud-side webhook handlers and the queen-tick read `queen_mode` via a process-local cache with a 60-second TTL on hit, falling back to Redis on miss/expiry. Avoids hot-path Redis roundtrip on every webhook event for local-mode installations. Mode changes propagate within ≤60s after the operator toggles.

**D16 — Local-mode single-point-of-failure characterization, accepted for v1.**
Drone war-room contribution §"Dual-role single-point-of-failure": the cloud architecture has accidental partial-redundancy — webhook-driven room creation is independent of cron-driven synthesis, so a queen-tick outage keeps discovery alive even though synthesis stalls. Local mode intentionally does **not** keep that split. What local outage stops in v1: PR discovery, PR room update events, synthesis, and final actions. The cloud observer still reports stuck rooms, but it does not create rooms, bump room state, synthesize, or post fallback actions while `queen_mode=local`.

This is the right shape for v1 (one container, one Codex subscription, one bearer) but operators need to know what they're opting into. The mode-toggle confirmation step (`/dashboard/settings`) explicitly surfaces this:

> "Switching to local — the hive queen becomes the only path that discovers PRs, creates/updates PR review rooms, synthesizes verdicts, and posts actions on PRs. The cloud will emit a 'rooms-stuck-older-than-N-min' alarm if the local queen falls behind, but no cloud fallback will create rooms or synthesize decisions. Make sure your hive queen has uptime monitoring before flipping. Proceed?"

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

1. **PR 1 — settings storage**: per-installation `queen_mode` Redis hash + GET/POST endpoints. Probot 60s TTL cache for `queen_mode` (D15). Mode-flip endpoint atomic per G12 (Redis MULTI/EXEC or per-installation flip-lock around the in-flight check + mode write). (Rate caps on `rooms.create` ship in PR 3 alongside the new endpoints they protect.)

2. **PR 2 — cloud-side mode skip + observer**: queen-tick + webhook handlers SKIP claim/synthesize/post when `mode=local` BUT still run the D8 observer pass (read-only `listRooms`, emit stuck-room metric). Mode-flip endpoint blocks on in-flight rooms (D9).

3. **PR 3 — endpoints + capabilities**: **Prep step**: move verdict primitives (`applyDowngradeOnlyFloor` + supporting helpers + `DerivedVerdictSchema`) from `bot/api/lib/queen/verdict-deriver.ts` into `@hivemoot/war-room` (builder pass-8). New `claim-synthesis` (returns room+participants+contributions composite per builder pass-9 §2) + `resolve-action` (accepts `reviewed_head_sha` and runs head-SHA drift guard server-side, builder pass-9 §3) + `seal-decision` + `confirm-merge` (G25, tick-N+1 server-side comparison with `merge_attempt_id` per G28) endpoint set with **D1's server-side invariant check** at `resolve-action` and `confirm-merge` + **D6's failure-ordering enforcement** (verified comment_url precondition at `seal-decision`) + **D7's audit event writes** (separate at each step). Plus `decided-pending-ready` query (G27, distinct from `synthesis-ready`). New `rooms.synthesize` capability + new `local_queen` preset (additive per D14, distinct from existing `queen` per builder pass-2). Token policy fields wired (D10). Rate caps on `rooms.create` (D11) AND on `resolve-action` + `seal-decision` + `confirm-merge` (G11). State-machine: new `decided_pending_action` is the ONLY new `RoomStatus`; comment + downgrade-comment paths reuse existing `closed` (per builder pass-9 §1).

4. **PR 4 — hive queen plugin**: two trigger loops. (a) Synthesis loop polls `synthesis-ready`, applies D5's race mitigations, captures `reviewed_head_sha` via fresh `gh pr view --json headRefOid` after `claim-synthesis` (builder pass-9 §3 + G21), runs two local `generateObject` calls (verdict D3 + action D2) on Codex flat cost, submits both + `reviewed_head_sha` to `resolve-action`, server applies structural floor + head-SHA drift guard + D1 invariants, posts comment, calls `seal-decision`. (b) Confirm-merge loop polls `decided-pending-ready` (G27), captures fresh `current_head_sha`, generates a fresh `merge_attempt_id` (G28), calls `confirm-merge` (G25) — server compares against the stored `reviewed_head_sha` and either approves the merge or downgrades. Restart-resilient — no local state persisted across runs (G26). Loads structured override config (D12).

5. **PR 5 — `/dashboard/settings`**: Queen mode toggle + heartbeat indicator (combining agent self-report and D8's cloud-observer metric). Structured-config UI for override (D12). Confirmation step on mode-flip surfaces D9's blocking conditions.

6. **PR 6 — BYOK relocation**: cosmetic; redirect old `/credentials` path.

PR 1 → (PR 2 + PR 3) in parallel → PR 4 (depends on PR 3) + PR 5 (depends on PR 1) → PR 6 (independent of all).

### Carried-forward implementation notes (PR-blockers, not RFC-blockers)

Guard's post-Decisions APPROVE review identified 9 implementation details the Decisions section leaves under-specified. They aren't architectural — the trust model and ordering are settled. They're concrete things each PR's review must confirm before code lands. Captured here so they're not re-debated when the implementation lands.

**G1 — D3's structural floor lives inside `resolve-action`, not as a separate `derive-verdict` route.**
The original drafting routed verdict derivation through a server-side `POST /api/rooms/:id/derive-verdict` endpoint, but that contradicted the flat-cost story (server-side `deriveVerdictFromContributions` resolves the LLM model via BYOK; running it server-side billed BYOK while the rest of synthesis ran on Codex flat-rate — see builder pass-7 §1). Resolution: the LLM verdict call moves **local** (Codex flat-cost), and the server-side **structural floor** (`aggregateWorkerVerdicts`) is evaluated **inside `resolve-action`** against the verdict the local queen submits. If the floor is decisive (e.g. any worker submitted `REQUEST_CHANGES` ⇒ `REQUEST_CHANGES` regardless of the LLM's output), the server overrides the submitted enum and emits a `queen.verdict_floor_override` audit event. This preserves the single-source-of-truth invariant for the **structural aggregation rules and Zod enum** (which stay in `bot/api/lib/queen/verdict-deriver.ts`, server-side TypeScript) without requiring the server to call the LLM. PR 3 first moves `applyDowngradeOnlyFloor` + `aggregateWorkerVerdicts` + `mostConservative` + `extractContributionVerdict` + `DerivedVerdictSchema` out of `bot/api/lib/queen/verdict-deriver.ts` into `@hivemoot/war-room` (which web already depends on; bot imports it via `bot/package.json`). Then `resolve-action`'s handler imports `applyDowngradeOnlyFloor` from `@hivemoot/war-room` — **not** raw `aggregateWorkerVerdicts`, which would clamp `APPROVE` to `COMMENT` for free-form contributions and silently break every merge. See D3's "Implementation primitive" + "Package boundary" notes. No new HTTP endpoint for verdict derivation.

**G2 — D1's silent downgrade should emit a structured audit event, not just verdict prose.**
A divergence between Codex's chosen action (`squash-merge`) and what the server permits (`comment` only) is a security signal, not just a UX detail. PR 3's `resolve-action` endpoint emits a separate `queen.action_downgrade` audit event whenever `recommended_action != permitted_action`, surfaced on the dashboard alongside the per-room timeline. If Codex consistently picks merge when invariants fail, that's a sign of prompt drift, prompt injection, or compromised override — operators need to see it.

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

**G9 — D10's merge-capable token policy verified by token-policy test.**
PR 3's token-policy tests assert that the queen-mode bearer's GitHub installation token, minted with `policy.allowed_permissions = { contents: "write", pull_requests: "write", issues: "write", metadata: "read" }`, can successfully:
- `gh pr view --json title,headRefName,headRefOid,mergeable,statusCheckRollup,labels`
- `gh pr comment <pr> -b "..."`
- `gh pr merge --squash <pr>`

against a private repo. If GitHub changes the permissions needed for this sequence, the test fails and PR 3 doesn't merge until the policy is corrected.

**G11 — Rate caps on `resolve-action` and `seal-decision`, not just `rooms.create`.**
D11 caps `rooms.create` per bearer/installation. Per guard pass-3, the new endpoint pair has its own DOS surface: spam `resolve-action` to fabricate audit events, or spam `seal-decision` to attempt fast-track merges. Both endpoints get the same rate-cap pattern (per-bearer-per-minute + per-installation-per-minute) with structured-warn telemetry on near-limit hits. Different attack vectors: `resolve-action` floods write the audit log; `seal-decision` floods attempt to brute-force the comment_url verification (G17).

**G12 — Mode-flip endpoint must be a single atomic transaction (MULTI/EXEC or per-installation flip-lock).**
D9 says mode-flip refuses if any room is in `deciding` with non-expired claim or in `decided_pending_action`. Naively that's a read (in-flight set) → write (`mode=local`). Cloud queen-tick can claim a room between the read and the write. PR 1 implements either: (a) a Redis MULTI/EXEC wrapping the in-flight check + mode write, or (b) a per-installation flip-lock taken before both. Either way, the read and write must be atomic; the lock TTLs out so a crashed flip doesn't strand the installation.

**G13 — D4's "operator override" trigger at tick N+1 must be label-only, not free-form text scanning.**
D4 lists `hivemoot:hold` label, operator reply, head SHA, CI status, label set. "Operator reply" is free-form comment-text scanning — a PR author can fake clearing strings ("`hivemoot:not-actually-hold` :)"). For v1, the override trigger is: presence of the `hivemoot:hold` label + the GitHub-side invariants (head SHA stable, CI green, labels present). Drop free-form text scanning; revisit if a real use case appears.

**G14 — (placeholder; reserved for future carry-forward without renumbering)**

**G15 — (placeholder; reserved for future carry-forward without renumbering)**

**G16 — `installation_token.mint` in `local_queen` is a documented departure from the apiarist-broker pattern.**
The existing `agent-token-capabilities.ts:259-263` comment scopes `installation_token.mint` as apiarist-only, with apiarist running on the host UDS broker and other agents requesting tokens through it. `local_queen` getting `installation_token.mint` directly bypasses this layer — D10's `allowed_repos` + `allowed_permissions` policy bound the blast radius, but the architectural departure should be explicit. Document in PR 3's capability tests + add a comment on the `local_queen` preset definition referencing this G16 trade-off so the next reviewer of the preset bundle understands why.

**G17 — Server-side verification of `comment_url` precondition at `seal-decision`.**
Per the endpoint spec under "New surface area" — the four checks (URL points to subject_ref PR, comment author is bot identity, body contains `<!-- hivemoot:queen-action:<verb>:<audit_id> -->` header binding to the resolve-action call, `created_at` later than the audit event timestamp) are the load-bearing safety mechanism for D14's "no public window means no merge eligibility." Without server-side verification, a leaked bearer can forge the URL and merge with no override window ever published. Implementation note: PR 3 must include negative tests for each of the four checks (URL pointing to wrong PR, comment by wrong user, missing audit_id, timestamp before resolve-action) — one passing test per failure mode is the only way to verify the contract.

**G18 — Cloud queen action surface is comment-only; irreversible actions go through `resolve-action`.**
Per D1's "Asymmetry to lock down" paragraph — cloud queen does not invoke `resolve-action` and therefore does not inherit D1's server-side invariant check. Today safe (cloud is comment-only). Pinned invariant: future RFCs that add irreversible actions to cloud queen MUST first route them through `resolve-action`. PR 3's endpoint code includes a comment on the existing `decide`/`close` routes pointing at this carry-forward.

**G19 — Server-side merge enforcement is client-initiated in v1; server has detection, not prevention, of unauthorized merges.**
Guard pass-3/pass-4 NEW-G19: PR 4 has the local queen execute `gh pr merge --squash` directly using its minted installation token (D10 policy: `pull_requests:write`). The server-side `seal-decision` records intent + verified comment URL but does not mint a single-use merge token. Practical consequence: a compromised local queen with a valid bearer + minted installation token could merge a PR after `seal-decision` even if the server-side state was unchanged. Detection in v1 comes from the queen's `report-merge-result` call plus the server-side reconciler, not from cloud PR webhooks when `queen_mode=local`. Re-consider for v1.5: a server-minted single-use merge token (server runs `gh pr merge` itself with a short-lived token after invariants are re-checked one final time). Filed against future RFC.

**G20 — `seal-decision` downgrade emits `queen.intended_action_post_failed` audit.**
Guard pass-4 NEW-G28: when `seal-decision` is called with `downgrade_reason: intended_action_post_failed` (the `gh pr comment` failure path in D6's failure-ordering branch), PR 3 must emit a structured `queen.intended_action_post_failed` audit event capturing `{room_id, recommended_action, intended_action, audit_id_from_resolve_action, error_class, retry_count}`. Distinct from G2's `queen.action_downgrade` (which fires when the server downgrades because invariants didn't permit) — G20 fires when the **dispatcher** downgrades because the comment leg failed. Both are operator-visible signals that mean different things; conflating them obscures whether the queen is misbehaving (G2) vs GitHub is unhealthy (G20).

**G21 — Local PR sweep health is a load-bearing dependency surface for local mode.**
Guard pass-5 NEW-G29, revised by the exclusive-ownership fix: when `queen_mode=local`, the hive queen's watched-repo sweep is the canonical writer for PR room creation and observed `subject_updated` bumps. If that sweep silently fails, new PRs can lack rooms and existing rooms can miss re-review prompts. **Builder pass-9 §3 — the head-SHA contract remains the structural mitigation for stale-merge safety**: D1's drift guard uses a `reviewed_head_sha` captured from a fresh GitHub read (`gh pr view --json headRefOid` after `claim-synthesis`, before LLM), submitted on `resolve-action` body, re-checked server-side at `resolve-action`, stored on the room for squash-merge intents, and re-fetched + compared at tick N+1 before `gh pr merge --squash`. Event-derived `throughSequence` is NEVER the basis for the drift check — the reviewed SHA is always a fresh GitHub read so missed update events cannot bypass the guard. Mitigations carried forward to PR 5: surface local sweep health as a per-installation dashboard signal alongside the queen-tick observer metric. Out of v1 scope: full local sweep audit UI. In v1 scope: the head-SHA contract above (PR 3 + PR 4) + per-installation local sweep health signal (PR 5).

**G22 — `seal-decision` must be idempotent on retry, bounded by a 15min window.**
Guard pass-6: the local queen calls `seal-decision` after `gh pr comment` returns. A transient network failure between `gh pr comment` succeeding and the queen's HTTP call to `seal-decision` will cause a retry with the same `comment_url` + `audit_id`. The endpoint MUST be idempotent: a second call with the same `audit_id` returns the same `final_state` (or 409 conflict if the first call already transitioned and the second is racing). Naively writing the state transition twice would double-emit the audit event. **Drone pass-16 refinement**: the idempotency window has an upper bound — `audit_id` is accepted at `seal-decision` only if the originating `resolve-action` audit row is ≤15 min old (matching G4's `decided_pending_action` TTL); older `audit_id`s are rejected to prevent stale replay attacks. PR 3 includes negative tests: (a) call `seal-decision` twice with same `audit_id` → second call returns same response, single audit event in the log; (b) `audit_id` whose `resolve-action` row is >15min old → seal returns 410 Gone.

**G23 — G11 rate-cap hard-limit semantics: 429 + queen retries next tick.**
Guard pass-6: G11 says "structured-warn telemetry on near-limit hits" but doesn't specify behavior at the hard limit. PR 3 implements (a): return `429 Too Many Requests`, no-op the action, queen retries on the next tick. Other choices considered and rejected: (b) 503-equivalent + queue the request — queue management is bookkeeping the v1 scope doesn't need; (c) hard-fail with audit event and require operator intervention — too aggressive for a transient surge. Pin (a) explicitly so PR 3 doesn't pick (b) or (c). Matches the existing rate-cap pattern in `web/src/server/`.

**G24 — G17 check #2: comment author must equal the App's bot login, not an operator account.**
Guard pass-6: G17's "comment author is bot identity behind the installation token" check needs an unambiguous server-side identity to compare against. The server compares `comment.author.login` against the **App's bot login** (e.g. `hivemoot-app[bot]`), fetched once at startup or via the App-installation API and cached. Comparing against an operator-account login would let any human with a session on the operator's GitHub account satisfy the check. PR 3 includes negative tests: (a) comment posted by the operator's user account → seal fails; (b) comment posted by a random GitHub user with comment access → seal fails; (c) comment posted by the App's bot login via the installation token → seal succeeds. The bot-login resolution must be App-installation-derived, not configurable per-installation.

**G25 — tick-N+1 path uses a `confirm-merge` endpoint, not a re-call of `seal-decision`.**
Guard pass-7: the tick-N+1 head-SHA re-comparison + merge confirmation is a distinct security gate from `seal-decision`'s comment-URL verification, with different idempotency semantics (G28 below) and different inputs (`current_head_sha` from a fresh GitHub read, not `comment_url`). PR 3 introduces `POST /api/rooms/:id/confirm-merge` gated by `rooms.synthesize`; body carries `{ merge_attempt_id, current_head_sha }`. Server compares `current_head_sha` against the `reviewed_head_sha` stored against the `decided_pending_action` claim and either approves (room transitions to `closed` immediately, audit `decision_outcome: merge_approved` meaning "merge decision approved" — the local queen then runs `gh pr merge --squash` and a separate audit field `github_merge_status: pending|succeeded|failed` is written after the actual merge attempt) or downgrades (room transitions to `closed`, audit `decision_outcome: merge_downgraded` + `reason: head_sha_drift_at_tick_n1` or other re-validation failure). **Pre-merge close model** (drone pass-21): the room transitions before `gh pr merge --squash` runs, simplifying the contract to one server roundtrip per tick. A failed `gh pr merge --squash` after approval is detectable via the `github_merge_status` audit field + the **mandatory** PR 5 reconciliation signal pinned in G30 (room shows `decision_outcome: merge_approved` but `github_merge_status: failed | pending` past 5min, or PR is still open on GitHub). Keeps the security gate uniform and removes the need for the local queen to read its own audit rows.

**G26 — `decided_pending_action` does not require local-queen state persistence.**
Guard pass-7: if the local queen container restarts between tick N and tick N+1 (within G4's 15min TTL), it should NOT need its in-memory `reviewed_head_sha` to confirm the merge. Per G25, the server holds `reviewed_head_sha` against the claim and runs the comparison on `confirm-merge`'s side; the local queen only needs to (a) re-fetch fresh `current_head_sha` from GitHub and (b) submit it to `confirm-merge`. Restart resilience comes from the server-side state, not from local persistence. PR 4's plugin design must NOT serialize tick-N state to disk — option (c) from the carry-forward analysis.

**G27 — `decided-pending-ready` is a separate query from `synthesis-ready`.**
Guard pass-7: rooms in `decided_pending_action` are NOT surfaced by `GET /api/rooms/synthesis-ready` (which lists rooms in `awaiting_contributions`/`deciding` ready for synthesis). PR 3 adds `GET /api/rooms/decided-pending-ready` (also gated by `rooms.synthesize`) returning rooms whose `decided_pending_action` has been pending ≥60s and ≤G4's 15min TTL. Keeps semantics distinct: synthesis vs merge confirmation, and avoids G11/G23 rate-cap accounting blurring across two unrelated workloads.

**G28 — tick-N+1 `confirm-merge` uses its own `merge_attempt_id`, not tick-N's `audit_id`.**
Guard pass-7: G22's 15min `audit_id` window covers tick-N's `seal-decision` retries. The tick-N+1 `confirm-merge` call needs its own idempotency key (`merge_attempt_id`, generated client-side at tick N+1, separate from the `audit_id` from `resolve-action`); reusing `audit_id` would make a network retry on the merge indistinguishable from a stale replay. Same idempotency contract as G22 (15min window, 410 Gone on stale, negative tests for double-call), but keyed on `merge_attempt_id`. Two distinct windows, two distinct keys.

**G29 — `decision_outcome` field name is `merge_approved`, not `merge_completed`.**
Guard pass-8: `decision_outcome: merge_completed` reads to a literal-minded audit consumer (PR 5 dashboard, log analysis, on-call runbook) as "the merge happened on GitHub" when it actually means only that the server approved the request — the actual GitHub merge outcome lives separately in `github_merge_status: pending | succeeded | failed`. PR 3 names the audit fields explicitly: `decision_outcome: merge_approved | merge_downgraded` (decision-side, written by `confirm-merge`) and `github_merge_status: pending | succeeded | failed` (action-side, written by the local queen after `gh pr merge --squash` returns). Two distinct fields, two distinct meanings, no name collision. The `merge_approved` audit fires on `confirm-merge` approval; the `github_merge_status` field is initialized to `pending` then set to `succeeded` or `failed` once the GitHub call completes.

**G30 — PR 5 mandatory reconciliation signal: "merge-approved-but-not-completed" alarm.**
Guard pass-8: pre-merge close (G25) creates a class of states where `room.status == closed` AND `decision_outcome == merge_approved` AND the PR is **still open on GitHub** — caused by `gh pr merge --squash` failing post-approval (branch protection blocked it, transient 5xx, etc.), local queen crashing between approval and merge, or `github_merge_status` never getting written. Without reconciliation these states are silent. PR 5 surfaces a per-installation "merge-approved-but-not-completed" alarm as a first-class signal alongside `rooms-stuck-older-than-N-min`. Trigger: any room with `decision_outcome: merge_approved` AND (`github_merge_status: failed` OR `github_merge_status: pending` past 5 min OR GitHub-side PR still in `open` state past 5 min). Distinct meaning from G21's local-sweep-health signal; both are required dashboard elements in PR 5.

**G31 — Approval→merge race window: PR 4 operator docs require GitHub branch protection.**
Guard pass-8: between server-side `confirm-merge` approval and the local queen's `gh pr merge --squash` call, GitHub-side state can change (new commit lands, `hivemoot:hold` label added, `hivemoot:automerge` removed, CI fails). The race window is tiny (one round-trip + one shell-exec) but real, and `gh pr merge --squash` does NOT enforce custom labels server-side — only GitHub's native branch-protection rules apply at GitHub's merge-time. The post-merge close model would have eliminated this race by gating immediately before merge; the pre-merge model (chosen per drone pass-21) trades that for one fewer roundtrip. Mitigation that already exists: GitHub branch protection (head-SHA pinning, status-check requirements, "Require branches to be up to date before merging"). PR 4's hive-queen setup guide MUST explicitly recommend installations using `local` mode + `automerge` workflow enable branch protection with **"Require branches to be up to date before merging"** + status-check requirements + restricted-pushes. Without that, the race is unhandled.

**G32 — Server-side reconciler in PR 3 (load-bearing companion to G30's detection signal).**
Guard pass-9: G30 alone is **detection** — it tells an operator at 3am that a room is stranded; it does NOT unstrand it. If a queen crashes between `confirm-merge` approval and `gh pr merge --squash`, or if `gh pr merge --squash` fails for any reason, the room remains `closed + decision_outcome: merge_approved + github_merge_status: pending` until a human intervenes. PR 3 ships a **server-side reconciler** that mirrors G30's trigger logic and *acts*: on a **30-60s scan interval** (drone pass-27: too aggressive = GitHub API rate-limit risk multiplied by stranded rooms × installations; too conservative = longer stranded windows; 30-60s lands the right side of both), scan rooms with that signature older than 2 min, read PR state via the App-installation token (`gh pr view --json state,mergeCommit.oid` server-side, or GraphQL equivalent), and write `github_merge_status: succeeded | failed` **using the same audit-row shape as the bearer-reported path** (drone pass-27: G30's dashboard query must see reconciled results identically to queen-reported results — if the audit shape differs, the alarm logic bifurcates for no benefit). Bounded by G4's 15-min TTL on `decided_pending_action` and an additional 15-min reconcile window on the post-`closed` stranded state. **Hard PR 3 review gate**: if PR 3 ships detection-only (no reconciler) and `queen_mode=local` ever ships to production, the v1 design must revert to post-merge close + symmetric `seal-merge` callback. Don't let the dashboard alone be the answer.

**G33 — `POST /api/rooms/:id/report-merge-result` endpoint with server-side cross-check.**
Guard pass-9: `github_merge_status` is currently described as "written by the local queen after `gh pr merge --squash` returns" but the contract for that write isn't specified. PR 3 introduces `POST /api/rooms/:id/report-merge-result` gated by `rooms.synthesize`; body carries `{ merge_attempt_id, github_merge_status: "succeeded" | "failed", merge_commit_oid?, error_class? }`. **Server-side cross-check** (symmetric to G17's `seal-decision` 4-check): server runs `gh pr view --json state,mergeCommit.oid` against the PR's own subject_ref using the bot's installation token; rejects `409 status_mismatch` if the local queen claims `succeeded` but the PR is still `open`, OR claims `failed` but the PR is `merged` with the matching `merge_commit_oid`. Otherwise a leaked bearer can falsely report `succeeded` and bypass G32's reconciler. Idempotent on `merge_attempt_id` (15-min window, 410 Gone on stale, same contract as G22/G28). Two distinct fields, two distinct endpoints, two distinct cross-checks: `confirm-merge` (head-SHA) → `gh pr merge` → `report-merge-result` (state cross-check).

**G34 — Downgrade-path `gh pr comment` retry with backoff in PR 4.**
Guard pass-9: the `confirm-merge` downgrade path (room transitions to `closed` with `decision_outcome: merge_downgraded`) leaves the local queen running `gh pr comment` with the downgrade prose AFTER the room has transitioned. If that comment fails, the room is correctly `closed` but the human-visible explanation is missing — silent surface for "why didn't this merge?" Lower severity than G32 (the room state is at least correct), but still silent-failure surface. PR 4 implements bounded-retry-with-backoff (e.g., 3 attempts at 5s/30s/120s); persistent failure emits `queen.downgrade_comment_failed` audit event for G30's reconciliation alarm. Don't conflate with G32's invariant — these are two separate silent surfaces, both detectable, with different remediations.

**G35 — PR 5 ordering pinned: G32 reconciler co-located with the failure mode (PR 3), not deferred to PR 5.**
Guard pass-9: under pre-merge close, PR 5's reconciliation dashboard would otherwise be the primary observability channel for merge-failure surfacing — implying PR 3+4 cannot ship `queen_mode=local` to production until PR 5 lands. Resolution: G32 moves the active reconciler into PR 3, co-located with the failure mode it remediates. PR 5's dashboard remains MANDATORY (G30) but its role is operator-facing observability, not the load-bearing safety mechanism. Effect on the implementation slicing: PR 3 + PR 4 can ship `queen_mode=local` independently of PR 5; PR 5 lands in parallel for human-facing visibility. No re-ordering of the 6-PR stack required.

**G36 — `confirm-merge` against an already-closed room: `409 invalid_status_for_confirm_merge`.**
Guard pass-9: G28 pins idempotency on a *repeated* `merge_attempt_id` (15-min window, 410 Gone on stale). But a *different* `merge_attempt_id` arriving at a room that's already `closed` (reachable via G26's no-state-persistence + queen restart, where the restarted queen polls `decided-pending-ready`, sees nothing, but a stale poll from the pre-restart queen lands moments later) needs a defined response. PR 3 returns `409 invalid_status_for_confirm_merge` with `{ prior_decision_outcome, prior_github_merge_status }` so the queen can self-heal: if `prior_decision_outcome: merge_approved` and `prior_github_merge_status: succeeded`, the second confirm-merge is a no-op success; if `prior_github_merge_status: pending`, the queen can defer to G32's reconciler. Different from `409 claim_lost` / other D5 codes — this code is specific to "this room has already moved past confirm-merge." Add to D5's benign-409 set on the local-side claim-loop.

**G37 — D9 mode-flip extension: also block on stranded-merge state.**
Guard pass-9: D9 currently blocks mode-flip while any room is in `deciding` (non-expired claim) or `decided_pending_action`. It does NOT block on `closed + decision_outcome: merge_approved + github_merge_status: pending` (the stranded-merge state G32 is designed to reconcile). An operator flipping `local → cloud` mid-stranded-merge leaves a permanent inconsistency since cloud has no merge surface (G18 — cloud is comment-only) and cloud's queen-tick wouldn't trigger G32's reconciler. PR 3 extends D9's in-flight check to also block mode-flip while any room is in this stranded-merge state, bounded by G32's 15-min reconcile window: after that, the room either resolves naturally (`github_merge_status` updated) or G6's force-expire path is the operator escape valve.
