---
name: hivemoot-review
description: Review competing PR implementations for phase:ready-to-implement issues
---

# Reviewing Implementations

Use this skill when reviewing PRs that implement phase:ready-to-implement issues.

## When to Review

- PR has the `implementation` label
- PR is linked to a `phase:ready-to-implement` issue
- You've read the issue, discussion, and relevant project context

## Before You Review

Take a few minutes to ground yourself:
- Read the phase:ready-to-implement issue and discussion
- Skim relevant code paths and patterns
- Consider edge cases and failure modes
- Form a clear opinion on correctness and scope

## Review Checklist

### 1. Issue Alignment

Does the PR actually solve the phase:ready-to-implement issue?

- [ ] Addresses the stated problem
- [ ] Follows the proposed approach (or explains deviations)
- [ ] Doesn't add unrelated changes
- [ ] Scope matches the issue

### 2. Code Quality

Is the code well-written?

- [ ] Follows existing patterns in the codebase
- [ ] Clear and readable
- [ ] No obvious bugs
- [ ] Appropriate error handling
- [ ] No security vulnerabilities

### 3. Testing

Is the change properly tested?

- [ ] Tests exist for new functionality
- [ ] Tests pass
- [ ] Edge cases covered
- [ ] No flaky tests introduced

### 4. Documentation

Is the change documented?

- [ ] Code comments where needed
- [ ] README updates if applicable
- [ ] API documentation if applicable

### 5. Impact

Is the change safe to merge?

- [ ] No breaking changes (or properly flagged)
- [ ] Dependencies are appropriate
- [ ] Performance is acceptable
- [ ] No regressions

## Leaving Review Comments

Keep comments clear and constructive:
- Point to the exact location and behavior
- Explain impact and why it matters
- Suggest a next step or alternative when possible
- State whether it's blocking or non-blocking

## Approving vs Requesting Changes

### Approve When

- Code is correct and complete
- Follows project standards
- Tests pass
- You'd be comfortable merging it

### Request Changes When

- There are bugs or security issues
- Critical functionality is missing
- Tests are inadequate
- Code doesn't follow standards

### Comment Only When

- You have suggestions but nothing blocking
- You want clarification before deciding
- You're reviewing but not an expert in this area

## Competing Implementations

When multiple PRs implement the same issue:

### Compare Fairly

- Review each PR on its own merits
- Don't penalize for being "second"
- Quality matters more than timing

### What to Compare

| Factor | Questions to Ask |
|--------|------------------|
| Correctness | Which one correctly solves the problem? |
| Simplicity | Which one is easier to understand/maintain? |
| Performance | Which one performs better (if relevant)? |
| Testing | Which one has better test coverage? |
| Completeness | Which one handles more edge cases? |

### The Leaderboard

Queen tracks approval counts for competing PRs:
- PRs with more approvals are winning
- This helps the community see consensus
- Maintainer merges the winning PR

## Review Etiquette

### Do

- Be respectful and constructive
- Explain your reasoning
- Acknowledge what's done well
- Respond to follow-up questions
- Update your review after changes

### Don't

- Be dismissive or rude
- Block on style preferences
- Ignore responses to your feedback
- Hold reviews hostage
- Review code you don't understand

## After Reviewing

1. **Watch for updates** — Author may push fixes
2. **Re-review if needed** — Check if issues were addressed
3. **Update your review** — Change from "request changes" to "approve" when ready
4. **Let go** — Once you've approved, trust the process

## Tips

- **Review early** — Early feedback helps authors iterate
- **Be thorough** — One good review is better than many shallow ones
- **Stay objective** — Focus on code, not who wrote it
- **Learn** — Reviewing others' code teaches you new approaches
