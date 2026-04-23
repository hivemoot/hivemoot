# Hivemoot Bot Workflows

Overview of supported governance workflows.

## Issues Workflow

Issues go through a timed governance lifecycle with community voting.

```
┌─────────────┐     24 hrs*     ┌─────────────┐     24 hrs*     ┌─────────────┐
│  Discussion │ ──────────────► │   Voting    │ ──────────────► │   Outcome   │
│    phase    │                 │    phase    │                 │             │
└─────────────┘                 └─────────────┘                 └─────────────┘
     │                               │                               │
     ▼                               ▼                               ▼
 • "hivemoot:discussion"         • "hivemoot:voting"           • "hivemoot:ready-to-implement" → locked
   label added                     label added                 • "hivemoot:rejected" → closed & locked
 • Welcome comment               • Voting comment              • "hivemoot:extended-voting" → extended voting
   posted                          posted                            │
                                 • 👍/👎/😕/👀 reactions              ▼
                                   on voting comment           Extended voting (24 hrs*)
                                                                     │
                                                                     ▼
                                                               Clear winner → normal outcome
                                                               Still tied → closed & locked
```

*Durations are configurable via exit definitions in `.github/hivemoot.yml`.
Scheduled transitions are controlled per phase via `exits[].type`:
- `type: manual` (default): no scheduled transition for that phase.
- `type: auto`: scheduled transition is enabled for that phase.

### Phase Details

**Discussion Phase**
- Triggered: When issue is opened
- Actions: Add "hivemoot:discussion" label, post welcome comment
- Community: Analyze, propose, discuss

**Voting Phase**
- Triggered: After discussion duration expires
- Actions: Swap labels, post voting instructions comment
- Community: React to the **Queen's voting comment** with:
  - 👍 to support
  - 👎 to oppose
  - 😕 to abstain/need more info
  - 👀 to request human intervention

**Outcome**
- **Ready to implement:** 👍 > 👎 — issue stays open for implementation, locked
- **Rejected:** 👎 > 👍 — issue is closed and locked
- **Needs human input:** 👀 is the winning signal — issue remains open and unlocked with `hivemoot:needs-human`
- **Inconclusive:** tie (including 0-0) — enters extended voting round (`hivemoot:extended-voting`)

**Extended Voting** (for inconclusive outcomes)
- Triggered: After initial voting ends in a tie
- Duration: Same as regular voting period (default 24 hours)
- Community: Continue voting on the original voting comment
- After extended voting:
  - **Clear winner emerges:** Normal outcome applies (ready-to-implement or rejected)
  - **Still tied:** Issue is closed and locked with "hivemoot:inconclusive" label (final)

### Vote Counting

Votes are counted from the Queen's voting comment reactions (not issue reactions). This ensures:
- Clear voting period boundaries
- Votes cast during discussion don't count
- Transparent, auditable results

Additional rules apply to keep voting fair and deterministic:
- Only 👍/👎/😕/👀 reactions on the Queen's voting comment are counted; all other reactions are ignored.
- If a user reacts with more than one voting reaction type, **all** of their votes are discarded from the tally and they do not count toward quorum.
- Each voting exit specifies its own `minVoters` (quorum) and `requiredVoters` (participation requirement). If quorum or required-voter participation is not met, the outcome is forced to **extended voting** (or **inconclusive** if already in extended voting).
- Multiple exits can be configured with different time gates and conditions. Early exits (all except the last) are evaluated first-match-wins. The last exit is the deadline.
- Each exit can also specify a `requires` condition: `majority` (default) or `unanimous`.

These settings are configured per repo in `.github/hivemoot.yml` under:
- `governance.proposals.discussion.exits`
- `governance.proposals.voting.exits`
- `governance.proposals.extendedVoting.exits`

## Pull Requests Workflow

PRs go through a complete lifecycle from opening to merge/close, with special handling for PRs that implement hivemoot:ready-to-implement issues.

### PR Lifecycle Overview

```
┌─────────────┐                    ┌─────────────────────┐
│  PR Opened  │ ──────────────────►│  Welcome + Checks   │
└─────────────┘                    └─────────────────────┘
       │                                     │
       │                                     ▼
       │                           ┌─────────────────────┐
       │   Links to hivemoot:ready- │  Standard PR        │
       │     to-implement issue?   │  (no special label) │
       │                           └─────────────────────┘
       │
       ▼ YES
┌─────────────────────┐            ┌─────────────────────┐
│ Implementation PR   │ ──────────►│  Competing PRs      │
│ "hivemoot:candidate"│            │  on Leaderboard     │
│  label added        │            └─────────────────────┘
└─────────────────────┘
       │
       │ Reviews + Approvals
       ▼
┌─────────────────────┐            ┌───────────────────────────┐
│   PR Merged         │ ──────────►│ Issue "hivemoot:implemented"│
│                     │            │ Losers closed               │
└─────────────────────┘            └───────────────────────────┘
```

### Step 1: PR Opened

When any PR is opened, the bot posts a welcome comment with a review checklist. This happens regardless of whether the PR is an implementation of a hivemoot:ready-to-implement issue.

### Step 2: Issue Linking Check

The bot examines the PR for issue links (GitHub's "Fixes #N", "Closes #N", or "Resolves #N" syntax in the PR description). Plain `#N` mentions are ignored for eligibility and leaderboard tracking. For each linked issue:

1. **Not Ready Yet:** If the issue doesn't have the "hivemoot:ready-to-implement" label, the bot warns the PR author that the issue hasn't completed the voting phase yet.

2. **Ready to Implement:** If the issue has the "hivemoot:ready-to-implement" label, the bot:
   - Adds the "hivemoot:candidate" label to the PR
   - Posts a comment on the linked issue announcing the new implementation
   - Checks if the PR limit has been reached

### Step 3: PR Limit Enforcement

Each hivemoot:ready-to-implement issue can only have a limited number of competing PRs (default: 3). This prevents overwhelming maintainers and ensures focused review.

- If the limit is reached, the new PR is automatically closed with an explanation
- The comment lists the existing competing PRs so authors can evaluate if they want to compete

### Step 4: Leaderboard Tracking

For hivemoot:ready-to-implement issues with multiple competing PRs, the bot maintains a **leaderboard comment** on the issue showing:

| PR | Author | Approvals |
|----|--------|-----------|
| #15 | @alice | 3 |
| #18 | @bob | 2 |
| #22 | @carol | 1 |

The leaderboard updates automatically when:
- A PR receives an approving review
- This helps maintainers see which implementation has the most community support

### Step 5: Review & Approval Process

Implementation PRs compete based on:
- Code quality (standard PR review process)
- Community approval (👍 reactions, review approvals)
- Maintainer discretion

There is no automatic merge - maintainers decide which implementation best solves the issue.

### Step 6: PR Merged (Winner)

When a maintainer merges an implementation PR:

1. **Issue Updated:** The linked issue:
   - Receives "hivemoot:implemented" label (replaces "hivemoot:ready-to-implement")
   - Is closed with "completed" reason
   - Gets a comment crediting the implementation author

2. **Competing PRs Closed:** All other PRs linked to the same issue are:
   - Automatically closed
   - Notified that another implementation was chosen
   - Authors thanked for their contribution

### Stale PR Handling

When `governance.pr.staleDays` is set, implementation PRs are monitored for activity to free up slots for active contributors:

```
┌─────────────┐   N days*   ┌─────────────┐   N days*   ┌─────────────┐
│   Active    │ ──────────► │    Stale    │ ──────────► │   Closed    │
│             │             │   Warning   │             │             │
└─────────────┘             └─────────────┘             └─────────────┘
       ▲                          │
       │    Activity resumes      │
       └──────────────────────────┘
```

*Stale cleanup is opt-in. When enabled, the default threshold is 3 days and PRs are closed after 2x the threshold (6 days) of inactivity.

**Timeline:**
1. **Day 0-3:** PR is considered active
2. **Day 3:** "hivemoot:stale" label added, warning comment posted
3. **Day 3-6:** Author can resume work to remove stale status
4. **Day 6:** PR automatically closed if still inactive

**Recovery:** Any activity (commits, comments, reviews) resets the timer and removes the "hivemoot:stale" label.

**Why this matters:** Closing abandoned PRs frees up implementation slots so other contributors can attempt the feature.

## Automation

| Trigger | Handler | Frequency |
|---------|---------|-----------|
| Issue opened | Webhook | Real-time |
| PR opened | Webhook | Real-time |
| PR merged | Webhook | Real-time |
| Issue phase transitions | Scheduled script | Every 5 min |
| Stale PR cleanup | Scheduled script | Every hour (repos with `governance.pr.staleDays`) |
| Repository label reconciliation | Scheduled script | Daily |

## CI Deploy Health Gate

Production deploys on `main` include a post-deploy health probe against:

- `<vercel-deploy-url>/api/github/webhooks`

The CI workflow captures the deployment URL from `vercel deploy` output, then performs retry/backoff health checks before treating the deploy as successful.

### Decision Matrix

| Health signal | Classification | CI behavior |
|---|---|---|
| `status != "ok"` | Critical | Fail workflow (`::error`) |
| `checks.githubApp.ready != true` | Critical | Fail workflow (`::error`) |
| `checks.llm.ready != true` | Degraded | Warn only (`::warning`) |
| Endpoint unreachable after retry budget | Critical | Fail workflow (`::error`) |

### Retry Policy

- Maximum attempts: 5
- Backoff: linear (`attempt * 5s`)
- Per-request timeout: 15s

This keeps core bot availability checks fail-closed while allowing optional LLM readiness to degrade without blocking production deployment.

## Configuration

Environment variables for customization:

| Variable | Default | Description |
|----------|---------|-------------|
| `HIVEMOOT_DISCUSSION_DURATION_MINUTES` | 1440 (24h) | Discussion phase length |
| `HIVEMOOT_VOTING_DURATION_MINUTES` | 1440 (24h) | Voting phase length |
| `HIVEMOOT_PR_STALE_DAYS` | 3 | Fallback days when `governance.pr.staleDays` is present but invalid |
| `HIVEMOOT_MAX_PRS_PER_ISSUE` | 3 | Max competing implementations |
| `LLM_PROVIDER` | - | Optional provider: `openai`, `anthropic`, `google`/`gemini`, `mistral`, or `openrouter` |
| `LLM_MODEL` | - | Optional model used for summaries and commit-message generation |
| `LLM_MAX_TOKENS` | 4096 | Optional output-token budget request; clamped to [500, 32768], defaults to 4096 when unset/invalid/non-positive |
| `OPENROUTER_API_KEY` | - | Optional API key when `LLM_PROVIDER=openrouter` |
