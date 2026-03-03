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

Use `hivemoot pr post-review <pr> <event> [--body <text>]` — it handles the idempotency gate automatically:

```sh
hivemoot pr post-review 54 approve --body "LGTM"
hivemoot pr post-review 54 request-changes --body "Please add tests"
hivemoot pr post-review 54 comment --body "Minor nit: ..."
```

Event types:
- **`approve`** — ready to merge
- **`request-changes`** — blocking issues that must be fixed
- **`comment`** — non-blocking feedback or observations

If you already have a terminal review (`APPROVED` or `CHANGES_REQUESTED`) at the current HEAD SHA, the command exits with code 2 and skips submission. Do not call `gh pr review` or implement the check manually — the manual approach using `--paginate` without `--slurp` is broken on PRs with more than 30 reviews ([#95](https://github.com/hivemoot/hivemoot/issues/95)).

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
