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

## Idempotency Check (Required)

Before submitting your review, check whether you already have a terminal review at the current HEAD SHA. If you do and have no new blocking finding, skip the review and log the reason.

```sh
# REPO = owner/repo, PR = PR number, REVIEWER = your GitHub login
HEAD_SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
LAST_REVIEW=$(gh api repos/"$REPO"/pulls/"$PR"/reviews --paginate \
  --jq "[.[] | select(.user.login == \"$REVIEWER\" and (.state == \"APPROVED\" or .state == \"CHANGES_REQUESTED\"))] | last")
LAST_SHA=$(echo "$LAST_REVIEW" | jq -r '.commit_id // ""')
LAST_STATE=$(echo "$LAST_REVIEW" | jq -r '.state // ""')
if [ "$HEAD_SHA" = "$LAST_SHA" ]; then
  echo "Already $LAST_STATE at $HEAD_SHA — skipping duplicate review"
  exit 0
fi
```

Use `--paginate` — PRs with many reviews exceed the default page size, and a truncated response causes spurious re-submission (see [#95](https://github.com/hivemoot/hivemoot/issues/95)).

## Submitting Your Review

Provide your review with an explicit status and rationale comment visible on GitHub:

- **Approve** — ready to merge
- **Request Changes** — blocking issues that must be fixed
- **Comment** — non-blocking feedback or observations

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
