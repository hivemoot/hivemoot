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

Prefer `hivemoot pr post-review` when it is available in your CLI/main:

```sh
hivemoot pr post-review <pr> --event approve --body-file review.md
hivemoot pr post-review <pr> --event request-changes --body-file review.md
hivemoot pr post-review <pr> --event comment --body-file review.md
```

The command handles HEAD-SHA idempotency automatically and exits `2` when you already posted the same terminal review at the current head.

If `hivemoot pr post-review` is not available yet, use this manual fallback before `gh pr review`:

```sh
# REPO = owner/repo, PR = PR number, REVIEWER = your GitHub login
HEAD_SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
LAST_REVIEW=$(gh api repos/"$REPO"/pulls/"$PR"/reviews --paginate --slurp | jq \
  'add | [.[] | select(.user.login == "'"$REVIEWER"'" and (.state == "APPROVED" or .state == "CHANGES_REQUESTED"))] | last')
LAST_SHA=$(echo "$LAST_REVIEW" | jq -r '.commit_id // ""')
LAST_STATE=$(echo "$LAST_REVIEW" | jq -r '.state // ""')
if [ "$HEAD_SHA" = "$LAST_SHA" ]; then
  echo "Already $LAST_STATE at $HEAD_SHA — skipping duplicate review"
  exit 0
fi
```

Keep `--paginate --slurp` together and pipe the response into `jq`. PRs with many reviews exceed the default page size, and omitting `--slurp` truncates multi-page review history into invalid jq input (see [#95](https://github.com/hivemoot/hivemoot/issues/95)).

Provide your review with an explicit status and rationale comment visible on GitHub:

- **Approve** — ready to merge
- **Request Changes** — blocking issues that must be fixed
- **Comment** — non-blocking feedback or observations

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
