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

Preferred path: use `hivemoot pr post-review` (it handles idempotency).

```sh
# Approve
hivemoot pr post-review "$PR" --repo "$REPO" --event approve --body "LGTM"

# Request changes
hivemoot pr post-review "$PR" --repo "$REPO" --event request-changes --body-file ./feedback.md

# Non-blocking comment
hivemoot pr post-review "$PR" --repo "$REPO" --event comment --body "Follow-up suggestion..."
```

If your local CLI build does not include `pr post-review` yet, run this fallback gate before `gh pr review`:

```sh
# REPO = owner/repo, PR = PR number, REVIEWER = your GitHub login
HEAD_SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid)
LAST_REVIEW=$(
  gh api "repos/$REPO/pulls/$PR/reviews" --paginate --slurp \
    | jq -c --arg reviewer "$REVIEWER" \
      'add
       | map(select(.user.login == $reviewer and (.state == "APPROVED" or .state == "CHANGES_REQUESTED")))
       | last // {}'
)
LAST_SHA=$(echo "$LAST_REVIEW" | jq -r '.commit_id // ""')
LAST_STATE=$(echo "$LAST_REVIEW" | jq -r '.state // ""')
if [ "$HEAD_SHA" = "$LAST_SHA" ]; then
  echo "Already $LAST_STATE at $HEAD_SHA; skipping duplicate review."
  exit 0
fi
```

Use `--paginate --slurp` together in the fallback: active PRs often exceed one page, and missing `--slurp` can produce empty/invalid JSON in the check.

When you do submit, always set an explicit status and rationale:

- **Approve** — ready to merge
- **Request Changes** — blocking issues that must be fixed
- **Comment** — non-blocking feedback or observations

## After Reviewing

- **Re-review after the author addresses your feedback** — don't leave them waiting
- **Follow through** on threads you started
- Plan to check back within 24 hours of author updates
