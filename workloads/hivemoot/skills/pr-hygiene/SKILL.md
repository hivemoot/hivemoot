---
name: pr-hygiene
description: >
  Enforces pull request quality standards: issue linking, clear
  descriptions, scope discipline, CI monitoring, and review response
  protocol. Ensures PRs are reviewable, traceable, and move efficiently
  through the review pipeline. Works with any GitHub-hosted project.
---

## Skill: PR Hygiene

You are running with the pr-hygiene skill active. Ensure every PR you
create or review meets professional quality standards.

### Creating PRs

**Issue link is mandatory.** Every PR description MUST include a closing keyword:
- `Fixes #123`, `Closes #123`, or `Resolves #123`
- Plain `#123` mentions do NOT auto-close the issue — only closing keywords work
- Without this link, automated tooling cannot trace PRs to issues

**Description quality:**
- Write WHY this change exists, not what the code does
- One clear idea per PR — if you need "and" to describe it, split it
- Reference the bug or issue it resolves
- Check `CONTRIBUTING.md` and `README.md` for repo-specific requirements (e.g.,
  PR templates, mandatory sections, required labels)

**Before/after examples** (required for user-visible changes):

| Change type | Show |
|-------------|------|
| UI | Screenshot, ASCII mockup, or screen recording |
| Config | Before/after YAML/JSON/TOML snippet |
| Behavior | Scenario table with before/after columns |
| CLI output | Terminal output block |
| API response | Before/after JSON |

Skip only for purely internal changes with zero user-visible effect.

### Scope Discipline

- Stay within the issue scope — don't fix unrelated things "while you're here"
- One logical change per PR — separate refactoring from features from bug fixes
- If you discover something that needs fixing, open a new issue instead
- Keep PRs small enough to review in one sitting when possible

### Work Coordination

Before starting work on an issue marked ready for implementation:
1. Check existing PRs — is someone already working on this?
2. Check issue comments for assignment claims or active discussion
3. Signal your intent (comment, self-assign, or follow the project's claim protocol)
4. If you can't continue, say so explicitly so others can take over

Follow the project's `CONTRIBUTING.md` for the specific assignment workflow.

### Keeping PRs Moving

- **CI first**: ensure checks pass before requesting review
- **Respond promptly**: address review comments within 24 hours
- **Mark resolved**: close conversation threads after fixing
- **Stay current**: rebase or merge base branch if checks are stale
- **Note failures**: if a check fails for unrelated reasons, say so explicitly
- **Monitor after push**: if you push updates, watch CI and fix your own failures

### When Reviewing PR Hygiene

Check these before reviewing the code itself:
- [ ] Closing keyword present (`Fixes/Closes/Resolves #N`)
- [ ] Description explains WHY, not just WHAT
- [ ] Scope matches the linked issue (no unrelated changes bundled)
- [ ] Before/after examples present for user-visible changes
- [ ] PR is not marked Draft (unless author requested early feedback)

If hygiene issues are found, flag them but don't let them block substantive review.
Address both in a single pass.

### When NOT to Apply

- Issue discussion and triage (no PR involved)
- Draft PRs explicitly marked as work-in-progress exploration
- Bot-generated PRs (dependency bumps, automated formatting)
