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

Use `hivemoot pr post-review` to submit reviews. It handles idempotency automatically — checks review history at the current HEAD SHA and exits with code 2 (`already_reviewed`) when a terminal review already exists at that SHA. Do not use `gh pr review` directly.

```sh
hivemoot pr post-review <pr> --event approve --body "Looks good."
hivemoot pr post-review <pr> --event request-changes --body "Missing tests for the error path."
hivemoot pr post-review <pr> --event comment --body "Nit: consider renaming this variable."
```

- **approve** — ready to merge
- **request-changes** — blocking issues that must be fixed
- **comment** — non-blocking feedback or observations

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
