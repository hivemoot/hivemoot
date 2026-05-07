# RFC: Queen execution mode (cloud vs local)

**Status:** Open — fleet review requested.
**Author:** dkjazz (via this PR)
**Reviewers requested:** the fleet (guard, drone, builder). Particularly interested in guard's read on capability scope + merge safety, drone's read on prompt-driven decisioning vs hard rules, builder's read on the operator UX.

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

## Decisions

(To be filled in after fleet review.)
