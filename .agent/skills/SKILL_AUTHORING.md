# Authoring Skills

Skills are reusable methodology modules that agents load deliberately. A good
skill is activated for the right task, kept short enough to not crowd the
context window, and validated so it doesn't silently rot.

## Required Frontmatter

Every `SKILL.md` must start with a YAML frontmatter block containing:

```yaml
---
name: <slug>
description: >
  One or two sentences. This is the routing signal — write it to match
  how an agent would describe the situation in plain language.

when_to_use:
  - Concrete trigger 1 (observable situation)
  - Concrete trigger 2

when_not_to_use:
  - Counter-example 1 — the most common wrong activation
  - Counter-example 2

triggers:
  - "keyword or label that activates this skill"
  - "another signal"

tags:
  - domain-tag
---
```

All five fields are required. CI will reject skills missing any of them.

## What Makes a Good Description

The description is the primary routing signal — it determines whether an
agent recognizes this skill as relevant to their current task.

**Good:** "Contribute to a hivemoot-governed project — propose features, join
discussions, vote on proposals, implement approved issues, and review PRs."

**Bad:** "For hivemoot." — too vague to route reliably.

Rule of thumb: if the description can't tell you *when not* to activate the
skill, it's too broad.

## `when_not_to_use` Is Required

At least one negative example is mandatory and enforced by CI. Negative
examples prevent the skill from becoming a catch-all that loads unnecessarily
and wastes context budget.

Write negative examples for the most tempting wrong activations — situations
that look similar to the skill's domain but where the skill's guidance
doesn't apply or would mislead.

## Eval Fixtures

Every skill must have two eval fixture files:

```
evals/activate.yml   — cases where the skill should activate
evals/skip.yml       — cases where the skill should NOT activate
```

These fixtures serve as documentation and regression tests. Each fixture
entry has:
- `id`: unique identifier
- `context`: prose description of the situation
- `signals`: observable cues
- `reason` (skip only): why the skill is a mismatch
- `expected_action` or `preferred_approach`: what to do instead

## Keep Skills Small

Skills are loaded into agent context — they have a cost. Keep the main
`SKILL.md` to what's universally needed. Use subfiles (`references/`) for
phase-specific or task-specific guidance that only applies in narrow cases.

An agent should be able to read the frontmatter and decide in seconds
whether to load the full skill.

## Validation

Run locally before pushing:

```bash
node scripts/validate-skills.js
```

CI runs this check automatically on any PR that touches `.agent/skills/`.
A skill that fails validation will block merge.
