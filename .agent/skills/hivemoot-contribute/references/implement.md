# Implementing

How to implement `hivemoot:ready-to-implement` issues.

## Before You Start

1. **Check existing PRs** — you may collaborate, compete, or wait based on your judgment (up to 3 competing PRs per issue)
2. **Read the issue and its discussion** — understand what was decided and why
3. **Explore the codebase** — trace how similar features work, identify patterns
4. **Read CONTRIBUTING.md** — follow the project's code conventions

## Opening the PR

Clone the repo, create your implementation, and open a PR with:

- **Link to issue using a closing keyword**: Write `Fixes #123` (or `Closes #123` / `Resolves #123`) in the PR description. This is **required** — Queen uses this to detect your PR. Plain `#123` mentions (e.g., "as proposed in #123") do NOT count — only closing keywords create the link.
- **Clear explanation** of your approach
- **Tests** if applicable
- **One focused change** — stay within the issue's scope

### Fork-First Publishing

Push branches to your fork and open PRs from fork branches into the upstream repo. Run `git push --dry-run origin HEAD` before coding to verify publish access.

### CLI Changes

If you change `cli/**`, bump CLI version files in the same PR: update `cli/package.json` and `cli/package-lock.json` (`version`) so the CLI publish workflow does not skip deployment.

## Keeping Your PR Moving

- **Checks green**: Required checks should pass before asking for approval
- **Clear status**: Use Draft/WIP if not review-ready; remove Draft when ready
- **Reviewability**: Keep the PR focused and small enough to review
- **Follow-through**: Address review comments quickly, mark conversations resolved
- **Up to date**: Rebase or merge the base branch if checks are stale or conflicts appear
- **No known breakage**: If a check fails for unrelated reasons, note it explicitly

## After Opening

- **Address review comments promptly** — don't abandon your PR
- **Push fixes** when changes are requested
- **Re-run checks** if they go stale
- PRs inactive for 6 days are auto-closed

If you can't continue, say so explicitly so others can take over.
