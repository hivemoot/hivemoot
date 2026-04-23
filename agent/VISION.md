# Vision

## Purpose

`hivemoot-agent` is the runtime layer that turns AI coding CLIs into autonomous
GitHub teammates. It should help maintainers run reliable, traceable agent
contributions on a schedule, with clear isolation boundaries and predictable
operations.

## Problem We Solve

Most AI coding tools are interactive assistants. They wait for prompts and are
optimized for one-off coding sessions.

Hivemoot-agent supports a different workflow:

- Agents run periodically without manual prompting
- Agents inspect repository state and choose useful work
- Agents publish auditable artifacts (PRs, reviews, comments, commits)
- Multiple agents can run concurrently with isolated workspaces and credentials

This repo exists to make that autonomous loop reliable in production.

## Product Principles

### Autonomy First

The runner should favor unattended operation over interactive convenience.
Defaults and workflows should support scheduled execution, not manual babysitting.

### Traceability by Default

Every meaningful action should be visible in logs or GitHub artifacts. Operators
must be able to answer who did what, when, and why.

### Isolation Over Shared State

Agent slots and runs must avoid accidental state bleed. Workspace, home, and log
layout should prevent cross-agent and cross-job interference.

### Security Is a Feature

Token handling, container boundaries, and path validation are product behavior,
not implementation details. Secure defaults matter more than broad flexibility.

### Operational Simplicity

When forced to choose, prefer fewer moving parts that are easier to understand
and debug in CI and Docker environments.

## Current Scope

The project currently provides:

- Dockerized runtime for supported providers (Claude, Codex, Gemini, Kilo,
  and OpenCode)
- Explicit worker drivers for single-run and legacy loop execution
- Per-agent homes and repository clones under `./data`
- CI coverage for shell correctness, compose validation, markdown linting, image
  build, and security scanning

## Near-Term Direction

### Runtime Hardening

- Continue tightening path/input validation
- Improve cleanup guarantees for interrupted runs
- Reduce accidental coupling between loop, multi-run, and one-shot modes

### Provider Reliability

- Keep provider integrations consistent in env naming, docs, and runtime wiring
- Ensure auth persistence behavior is explicit and testable for each provider
- Fail fast when provider setup is incomplete instead of failing late

### Documentation as Runtime Contract

- Keep `README.md`, `VISION.md`, and `ROADMAP.md` aligned with actual script behavior
- Document behavior that affects operations (state isolation, auth seeding,
  cleanup, scheduling, retry/backoff)

## Long-Term Direction

### Stronger Multi-Repo Operations

Evolve toward running many repositories with clear per-repo boundaries and safe
credential scoping.

### Better Observability

Improve run introspection with structured output and clearer failure signatures
so operators can triage quickly.

### Policy-Aware Automation

Deepen alignment with governance signals from Hivemoot Bot so agents prioritize
the right work at the right time.

## Decision Filter

Changes should generally move forward when they:

1. Increase autonomous reliability
2. Improve safety or traceability
3. Reduce operator toil
4. Keep behavior understandable from docs and logs

Changes should usually be rejected or redesigned when they:

1. Add large complexity with weak operational payoff
2. Hide behavior behind implicit side effects
3. Expand configuration surface without clear defaults
4. Create state-sharing risks across jobs or agents

## Success Criteria

We are succeeding when maintainers can:

- Run agents continuously with minimal intervention
- Trust that runs are isolated and reproducible
- Debug failures quickly from repository artifacts and logs
- Accept merged agent contributions without recurring cleanup work
