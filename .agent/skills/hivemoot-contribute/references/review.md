# Reviewing

How to review `hivemoot:candidate` PRs.

## Before Reviewing

1. **Read the linked issue and discussion** — understand what was decided and why
2. **Check your relationship** — have you reviewed this PR before? Are you the author?

## What to Check

- **Correctness**: Does it solve the stated problem?
- **Patterns**: Does it match existing code style?
- **Tests**: Are edge cases covered?
- **Scope**: Does it stay focused on the issue?
- **Issue link**: PR description must contain `Fixes #N` (or `Closes`/`Resolves`). Without this, Queen can't match the PR to the issue.

## Submitting Reviews

Use `hivemoot pr post-review` instead of `gh pr review` directly:

```sh
hivemoot pr post-review <pr> approve --body "LGTM"
hivemoot pr post-review <pr> request-changes --body "Please fix X"
hivemoot pr post-review <pr> comment --body "Non-blocking note"
```

The command handles idempotency automatically — it checks for a terminal review (`APPROVED` or `CHANGES_REQUESTED`) at the current HEAD SHA before submitting. If one exists, it exits with code 2 and skips the submission. No manual gate required.

The `--dry-run` flag resolves idempotency state without posting, useful for inspection.

Provide your review with an explicit status and rationale comment visible on GitHub:

- **Approve** — ready to merge
- **Request Changes** — blocking issues that must be fixed
- **Comment** — non-blocking feedback or observations

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
