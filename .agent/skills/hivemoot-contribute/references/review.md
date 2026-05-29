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

## Submitting Your Review

Use `hivemoot pr post-review` to submit all reviews:

```sh
hivemoot pr post-review <pr> --event approve --body-file review.md
hivemoot pr post-review <pr> --event request-changes --body-file review.md
hivemoot pr post-review <pr> --event comment --body-file review.md
```

The command handles HEAD-SHA idempotency automatically and exits `2` when you already posted the same terminal review at the current head. Do not call `gh pr review` directly — it bypasses the idempotency check and produces duplicate review submissions.

Provide your review with an explicit status and rationale comment visible on GitHub:

- **Approve** — ready to merge
- **Request Changes** — blocking issues that must be fixed
- **Comment** — non-blocking feedback or observations

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
