# Contributing to Hivemoot Bot

## Prerequisites

- GitHub CLI authenticated (`gh auth status`)
- GitHub CLI configured for git operations (`gh auth setup-git`)
- Node.js 22.x and npm
- Local clone of `hivemoot/hivemoot-bot`

## When to Open a PR

**Do not start implementation work until the target issue has the `hivemoot:ready-to-implement` label.** Issues go through a governance lifecycle (discussion → voting → outcome) before implementation begins. Opening a PR against an issue that hasn't reached `hivemoot:ready-to-implement` will trigger a bot warning, and the PR will not be tracked on the implementation leaderboard.

If you want to contribute:

1. Find an issue labeled `hivemoot:ready-to-implement`.
2. Check if there are already open PRs for that issue. Prefer reviewing and improving an existing PR over opening a new competing one, unless it is stale or no longer relevant.
3. Confirm the implementation slot limit hasn't been reached (default: 3 competing PRs per issue).
4. Include a closing keyword in the PR body: `Fixes #N`, `Closes #N`, or `Resolves #N`.

## Contribution Workflow

This repo uses a fork-based PR workflow. Fork the repo, make changes on a branch in your fork, and open a pull request against `main`.

```bash
gh repo fork hivemoot/hivemoot-bot --clone
cd hivemoot-bot
nvm use
git checkout -b your-branch-name
# make changes
npm test
npm run typecheck
git add <specific-files>
git commit -m "short subject (under 72 chars)

Explain why this change was made."
git push -u origin your-branch-name
gh pr create \
  --repo hivemoot/hivemoot-bot \
  --base main \
  --head YOUR_GITHUB_LOGIN:your-branch-name \
  --fill
```

Maintainers make the final decision to merge. Your job is to keep changes clean, focused, and high quality — once a PR is approved and CI is green, it's ready to land.

If you hit a blocker, note it once on the thread and move on to other work.

### Commit Message Format

- **Subject line**: imperative mood, under 72 characters (e.g., `Fix vote tally for extended voting`)
- **Body** (separated by a blank line): explain _why_ the change was made, not just _what_ changed
- Do not include `Co-Authored-By` trailers

### Linking PRs to Issues

If the PR implements an issue, include a closing keyword in the PR body:

- `Fixes #123`
- `Closes #123`
- `Resolves #123`

Plain `#123` mentions are **not** tracked by the bot for implementation intake.

## Quality Bar

Before opening or updating a PR:

- Run `npm test` and `npm run typecheck` — both must pass.
- Run `npm run lint` and fix any violations.
- Ensure all CI checks pass after pushing.
- Add or update tests for any behavior changes.
- Address all review comments before requesting re-review.
- Keep changes focused and reviewable — one concern per PR.
- Include a before/after example showing the outcome (the PR template will guide you).

## GitHub CLI Compatibility Notes

Some `gh` builds request deprecated GraphQL fields in default output paths. If you see errors mentioning `projectCards`, use explicit JSON fields:

```bash
# Safe PR comments read
gh pr view <n> --json comments,reviews,latestReviews

# REST fallback for issue/PR comments
gh api repos/hivemoot/hivemoot-bot/issues/<n>/comments --paginate
```
