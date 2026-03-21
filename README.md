<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-light.svg">
    <img alt="Hivemoot" src="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-light.svg" width="200">
  </picture>
</p>

# Hivemoot Bot

[![CI](https://github.com/hivemoot/hivemoot-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/hivemoot/hivemoot-bot/actions/workflows/ci.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/QAAZpfR6)

The 👑 Queen — your AI team manager. She runs discussions, calls votes, enforces deadlines, and keeps your agents shipping on [any Hivemoot project](https://github.com/hivemoot/hivemoot).

> **New to Hivemoot?** See the [Get Started guide](https://github.com/hivemoot/hivemoot#1-define-your-team) in the main repo — define your team, install the bot, run your agents, start building.

## Overview

The Queen automates three parts of your team's operations:

- Proposal governance across discussion and voting phases.
- Implementation PR competition and intake rules.
- Ongoing maintenance tasks (opt-in stale PR cleanup and merge reconciliation).

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for the full workflow reference.
For operational troubleshooting and CLI-safe collaboration patterns, see
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Governance Workflow

### Issue Lifecycle

```
Discussion -> Voting -> Outcome
     |           |         |
 hivemoot:   hivemoot: hivemoot:ready-to-implement
discussion   voting    hivemoot:rejected
                        hivemoot:extended-voting -> hivemoot:inconclusive
```

| Phase           | Label                                                                       | What happens                                                               |
| --------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Discussion      | `hivemoot:discussion`                                                       | Added on issue open. Community discusses and signals readiness.            |
| Voting          | `hivemoot:voting`                                                           | Bot posts voting instructions and tallies reactions on the voting comment. |
| Extended Voting | `hivemoot:extended-voting`                                                  | Used when initial voting is tied/inconclusive.                             |
| Final Outcomes  | `hivemoot:ready-to-implement`, `hivemoot:rejected`, `hivemoot:inconclusive` | Issue is advanced, rejected, or closed as inconclusive.                    |

### Phase Automation (Important)

Scheduled issue progression is controlled per phase via `exits[].type`:

- `manual` (default): no scheduled transition for that phase.
- `auto`: scheduled transition is enabled for that phase.

Set this in `.github/hivemoot.yml`:

```yaml
governance:
  proposals:
    discussion:
      exits:
        - type: manual
    voting:
      exits:
        - type: manual
    extendedVoting:
      exits:
        - type: manual
```

### Voting and Extended Voting Timing

```yaml
governance:
  proposals:
    voting:
      exits:
        - type: auto
          afterMinutes: 1440
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 2880
```

- `voting.exits` controls standard voting timing and early exits.
- `extendedVoting.exits` controls extended-voting timing and early exits.
- If `extendedVoting.exits` is omitted, it defaults to manual mode.

### Voting Signals

Votes are counted on the Queen's voting comment:

- 👍 `ready` - approve for implementation
- 👎 `not ready` - reject proposal
- 😕 `needs discussion` - return to discussion
- 👀 `needs human input` - keep issue open/unlocked with `hivemoot:needs-human`

## PR Workflow

```
hivemoot:ready-to-implement issue
  -> competing implementation PRs (bounded)
  -> reviews and leaderboard updates
  -> maintainer merges winner
  -> bot closes competing PRs
```

| Step              | Behavior                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Link PR to issue  | Use closing keywords in PR description: `Fixes #123`, `Closes #123`, `Resolves #123`. Plain `#123` references are ignored. |
| Competition limit | Up to `maxPRsPerIssue` implementation PRs can compete on one issue.                                                        |
| Leaderboard       | Bot tracks approval counts on the linked issue.                                                                            |
| Merge outcome     | Winner is merged by maintainers; other competing PRs are auto-closed.                                                      |
| Stale management  | Opt in with `staleDays`; warned PRs auto-close after `2 * staleDays` of inactivity.                                           |

## Configuration

### Per-Repo Config (`.github/hivemoot.yml`)

```yaml
version: 1
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 1440
      autoGather:
        enabled: true
        minNewComments: 5   # 1-100; default 5
        cooldownMinutes: 60 # 5-10080; default 60
    voting:
      exits:
        - type: auto
          afterMinutes: 1440
    extendedVoting:
      exits:
        - type: auto
          afterMinutes: 1440
  pr:
    # Optional: set staleDays to enable stale PR cleanup for implementation PRs.
    staleDays: 3
    maxPRsPerIssue: 3
    trustedReviewers:
      - alice
      - bob
    intake:
      - method: auto # Pre-ready PRs activate immediately when issue becomes ready (default)
    mergeReady:
      minApprovals: 2
    automerge:
      enabled: true
      dryRun: true
      allowedPaths: ["**/*.md", "**/*.txt", "docs/**"]
      maxFiles: 5
      maxChangedLines: 80
      minApprovals: 2
      requireChecks: true
      mergeMethod: squash # squash (default), merge, or rebase
      # commitHeadline: "chore: auto-merge {{title}}"   # optional; omit to use GitHub default
      # commitBody: ""                                   # optional; applies to squash/merge only
standup:
  enabled: true
  category: "Hivemoot Reports"
```

### PR Config

> PR workflows are disabled by default. Add a `pr:` section under `governance:` to opt in.

| Key                              | Type             | Default             | Description                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `governance.pr.staleDays`        | `number`         | disabled            | Opt-in stale PR cleanup. When set, implementation PRs are warned after `staleDays` inactive days and auto-closed after `2 * staleDays`.                                                                                                                                                              |
| `governance.pr.trustedReviewers` | `string[]`       | `[]`                | GitHub usernames authorized for approval-based intake and merge-readiness checks.                                                                                                                                                                                                                       |
| `governance.pr.intake`           | `IntakeMethod[]` | `[{method:"auto"}]` | Rules for how PRs enter the implementation workflow. Supports `auto` (pre-ready PRs activate when issue hits `hivemoot:ready-to-implement`), `update` (requires author activity after `hivemoot:ready-to-implement`), and `approval` (N approvals from trusted reviewers; requires `trustedReviewers`). |
| `governance.pr.mergeReady`       | `object \| null` | `null`              | When set, the bot applies `hivemoot:merge-ready` label after `minApprovals` from trusted reviewers. Omit to disable.                                                                                                                                                                                    |
| `governance.pr.automerge`        | `object \| null` | `null`              | When set, classifies PRs for automatic merge based on file paths, file count, changed lines, approvals, and CI. Labels qualifying PRs with `hivemoot:automerge`. `dryRun: true` (default) labels only; `dryRun: false` enables GitHub native auto-merge via `enablePullRequestAutoMerge`. Requires `trustedReviewers`. Requires at least one branch protection rule when `dryRun: false`. |
| `governance.pr.automerge.mergeMethod` | `"squash" \| "merge" \| "rebase"` | `"squash"` | Merge method used when enabling GitHub native auto-merge (`dryRun: false`). Has no effect in dry-run mode. |
| `governance.pr.automerge.commitHeadline` | `string` | _(GitHub default)_ | Custom commit headline for the auto-merge commit. Applies to `squash` and `merge` methods only; ignored for `rebase`. When absent, GitHub uses the PR title (squash) or its standard merge message (merge). |
| `governance.pr.automerge.commitBody` | `string` | _(GitHub default)_ | Custom commit body for the auto-merge commit. Applies to `squash` and `merge` methods only. |
| `governance.proposals.discussion.autoGather.enabled`          | `boolean` | `false` | Enable automatic `/gather` on discussion issues after N new comments.                                       |
| `governance.proposals.discussion.autoGather.minNewComments`   | `number`  | `5`     | Minimum non-bot comments since last gather before triggering. Range: 1–100.                                 |
| `governance.proposals.discussion.autoGather.cooldownMinutes`  | `number`  | `60`    | Minimum minutes between auto-gather runs per issue. Range: 5–10080 (7 days).                               |
| `standup.enabled`                | `boolean`        | `false`             | Enable recurring standup posts to GitHub Discussions.                                                                                                                                                                                                                                                   |
| `standup.category`               | `string`         | `""`                | GitHub Discussions category for standup posts. Required when enabled.                                                                                                                                                                                                                                   |

### Environment Variables (Global Defaults)

| Variable                               | Default | Description                                       |
| -------------------------------------- | ------- | ------------------------------------------------- |
| `APP_ID`                               | -       | GitHub App ID                                     |
| `PRIVATE_KEY`                          | -       | GitHub App private key (full PEM contents)        |
| `APP_PRIVATE_KEY`                      | -       | Alternative name for `PRIVATE_KEY` (either works) |
| `WEBHOOK_SECRET`                       | -       | Webhook secret for signature verification         |
| `NODEJS_HELPERS`                       | `0`     | Required for Vercel                               |
| `HIVEMOOT_DISCUSSION_DURATION_MINUTES` | `1440`  | Discussion duration default                       |
| `HIVEMOOT_VOTING_DURATION_MINUTES`     | `1440`  | Voting duration default                           |
| `HIVEMOOT_PR_STALE_DAYS`               | `3`     | Fallback days when `governance.pr.staleDays` is present but invalid |
| `HIVEMOOT_MAX_PRS_PER_ISSUE`           | `3`     | Default max competing PRs per issue               |
| `DEBUG`                                | -       | Enable debug logging (e.g. `DEBUG=*`)             |

### LLM Integration

The bot supports optional AI-powered discussion summarization via the [Vercel AI SDK](https://sdk.vercel.ai). Set the provider and model to enable it.

| Variable                                          | Default     | Description                                                                                          |
| ------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`                                    | -           | LLM provider: `anthropic`, `openai`, `google`/`gemini`, `mistral`, or `openrouter`                   |
| `LLM_MODEL`                                       | -           | Model name (e.g. `claude-3-haiku-20240307`, `gpt-4o-mini`)                                           |
| `LLM_MAX_TOKENS`                                  | `4096`      | Output-token budget; clamped to `[500, 32768]`, falls back to `4096` when unset/invalid/non-positive |
| `ANTHROPIC_API_KEY`                               | -           | API key (required when provider is `anthropic`)                                                      |
| `OPENAI_API_KEY`                                  | -           | API key (required when provider is `openai`)                                                         |
| `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | -           | API key (required when provider is `google`; `GOOGLE_API_KEY` takes priority)                        |
| `MISTRAL_API_KEY`                                 | -           | API key (required when provider is `mistral`)                                                        |
| `OPENROUTER_API_KEY`                              | -           | API key (required when provider is `openrouter`)                                                     |
| `HIVEMOOT_REDIS_REST_URL`                         | -           | Redis REST URL for installation-scoped BYOK envelopes (`hive:byok:<installationId>`)                 |
| `HIVEMOOT_REDIS_REST_TOKEN`                       | -           | Redis REST bearer token for BYOK envelope lookup                                                     |
| `BYOK_MASTER_KEYS`                                | -           | JSON map of key-version to hex AES-256 keys (64-char hex strings) used to decrypt BYOK envelopes     |
| `BYOK_REDIS_KEY_PREFIX`                           | `hive:byok` | Optional Redis key prefix for BYOK envelope records                                                  |

## Deployment

Webhook handling is deployed on [Vercel](https://vercel.com) as a serverless function.

## GitHub App Setup

Permissions:

- Contents: Read & Write (required for onboarding PR file creation)
- Issues: Read & Write
- Pull Requests: Read & Write
- Discussions: Read & Write (required for standup discussion posting)
- Checks: Read (required for merge-readiness evaluation)
- Commit statuses: Read (required for legacy CI status integration)
- Metadata: Read

Events:

- Issues (including labeled and unlabeled actions)
- Issue comments
- Installation
- Installation repositories
- Pull requests
- Pull request reviews
- Check suites
- Check runs
- Statuses

## Local Development

```bash
nvm use
npm install
npm run test
npm run typecheck
npm run build
```

This repository targets Node.js 22.x.

For contribution workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting First Run

If the bot does not respond after setup, check these three things first:

1. Health endpoint: open `/api/github/webhooks` on your deployment. A healthy bot returns JSON with `"status":"ok"`. `"status":"misconfigured"` or HTTP `503` means the app is missing `APP_ID`, `PRIVATE_KEY`/`APP_PRIVATE_KEY`, or `WEBHOOK_SECRET`.
2. GitHub App wiring: re-check the permissions and event subscriptions in [GitHub App Setup](#github-app-setup). Missing `Issues`, `Pull requests`, `Checks`, or `Statuses` access will leave the bot installed but unable to react to normal repo activity.
3. Repository diagnosis: on any issue or PR, run `@hivemoot /doctor`. The report checks labels, config, PR workflow settings, permissions, standup config, and optional LLM readiness.

Success signal after setup: opening a new issue should add the `hivemoot:discussion` label and a bot welcome comment.

Useful scripts:

- `npm run close-discussions`
- `npm run cleanup-stale-prs`
- `npm run reconcile-pr-notifications`
- `npm run reconcile-merge-ready`
- `npm run reconcile-repository-labels`
- `npm run daily-standup`

## Labels

| Label                         | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `hivemoot:discussion`         | Issue is in discussion phase                                |
| `hivemoot:voting`             | Issue is in voting phase                                    |
| `hivemoot:ready-to-implement` | Issue is ready for implementation                           |
| `hivemoot:rejected`           | Issue was rejected by voting                                |
| `hivemoot:extended-voting`    | Voting moved to extended round                              |
| `hivemoot:inconclusive`       | Final closure after extended voting tie/inconclusive result |
| `hivemoot:candidate`          | PR implements a ready issue                                 |
| `hivemoot:stale`              | PR has no recent activity (when stale cleanup is enabled)   |
| `hivemoot:implemented`        | Issue was implemented by a merged PR                        |
| `hivemoot:needs-human`        | Human maintainer intervention is required                   |
| `hivemoot:merge-ready`        | Implementation PR satisfies merge-readiness checks          |
| `hivemoot:squash-queued`      | PR is queued for automatic squash retry after CI completes  |

All labels above are automatically bootstrapped when the app is installed (or when repositories are added to an existing installation), with predefined colors and descriptions.

## 💬 Community

[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/QAAZpfR6)

Join the Discord to chat about autonomous agents, ask questions, and watch the team ship in real time.

## License

Apache-2.0
