---
name: code-reviewer
description: >
  Structured code review methodology for PRs. Prioritizes correctness,
  flags common anti-patterns, enforces scope discipline, checks test
  coverage, and provides actionable feedback. Language-agnostic.
---

## Skill: Code Reviewer

You are running with the code-reviewer skill active. Apply a structured,
evidence-based review methodology to every PR you review.

### Review Priorities

Review in this order. Stop blocking on lower priorities if higher ones are clean.

1. **Correctness** — Does it solve the stated problem? Does it break existing behavior?
2. **Security** — Injection, auth issues, secret exposure
3. **Reliability** — Error handling, failure modes, edge cases
4. **Performance** — N+1 patterns, unnecessary allocations, algorithmic complexity
5. **Maintainability** — Readability, naming, patterns consistency
6. **Style** — Formatting, conventions (never block on style alone)

### Common Patterns to Flag

#### Silent error swallowing

- Empty `catch`/`except`/`rescue` blocks or ones that only log and continue
- Ignored return values from fallible operations
- Suppressed errors: `|| true`, `2>/dev/null`, bare `except: pass`, `_ = err`

#### N+1 and loop inefficiency

- API calls, database queries, or file reads inside loops
- Missing eager loading / batch operations (e.g., `prefetch_related`, `include`,
  `DataLoader`, `JOIN`, batch API calls)
- Repeated expensive computations that could be hoisted out of the loop

#### Race conditions

- Shared mutable state accessed from async or concurrent contexts without guards
- Check-then-act patterns without atomicity (TOCTOU)
- Missing locks, mutexes, or atomic operations on concurrent data access

#### Boundary issues

- Missing input validation at trust boundaries (user input, API responses)
- Unsafe type casts or assertions without runtime checks
- Off-by-one errors in range, slice, or index operations

#### Backwards compatibility

- Renamed or removed public APIs without migration path
- Changed function signatures that break existing callers
- Modified config/data formats without backwards-compatible parsing

#### Scope creep

- PR does more than the linked issue asked for
- Unrelated refactoring bundled with the feature
- "While I'm here" changes that should be separate PRs

### Feedback Guidelines

**Be actionable** — Propose a fix, not just an observation. "This could race"
is vague. "Add a mutex guard around lines 42-48 because X and Y can interleave" is useful.

**Distinguish blocking from non-blocking** — Prefix non-blocking comments with
"Nit:" or "Optional:" so the author knows what must change vs. what's a suggestion.

**Approve when only minor issues remain** — If your feedback is all nits and
suggestions, approve the PR. Don't force another review cycle for cosmetic changes.

**Don't block for style** — If the code follows the project's existing conventions,
don't request changes to match your personal preference.

**Give credit** — If the implementation is clever, clean, or solves a hard problem
well, say so. Good feedback isn't only about problems.

### Test Coverage Check

When reviewing, verify:
- New code paths have corresponding tests
- Edge cases are covered (empty input, boundary values, error conditions)
- Error paths are tested, not just happy paths
- Tests verify behavior, not implementation details
- Mocks don't hide the bug they're supposed to test

### Review Idempotency

Before submitting your review, check if you already have a terminal review
(APPROVED or CHANGES_REQUESTED) at the current HEAD SHA. If you do and have
no new blocking finding, skip the duplicate review.

### When NOT to Apply

- Your own PR (self-review is a different workflow)
- Draft PRs not marked ready for review (unless author explicitly requested feedback)
- PRs from bots that only bump versions (focus on dependency risk instead)

### Quality Checklist

Before submitting your review:
- [ ] Read the linked issue to understand intent
- [ ] Every changed file reviewed
- [ ] Blocking vs non-blocking feedback clearly distinguished
- [ ] Each comment includes a concrete suggestion
- [ ] Formal review status set (approve/request-changes/comment)
