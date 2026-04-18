# AGENTS.md

This file gives provider-agnostic startup context for autonomous agents working in
`hivemoot-agent`.

## Repository Purpose

`hivemoot-agent` is the runtime container that launches autonomous coding agents
against a GitHub repository. The runtime supports Claude, Codex, Gemini, Kilo,
and OpenCode.

## Startup Context Files

Before deep repository exploration, read these root docs when present:

1. `README.md`
2. `VISION.md`
3. `ROADMAP.md`
4. `CONTRIBUTING.md`
5. `AGENTS.md`
6. `HOW-IT-WORKS.md`

This keeps startup consistent across providers and reduces repeated discovery
tool calls.

## Runtime Architecture

- Worker entrypoint: `hivemoot-agent worker` Python subcommand (`cli/hivemoot_agent/worker.py`) — runs as PID 1 inside every job container under tini
- Plugin engine (worker body): `cli/hivemoot_agent/engine.py`
- Shared shell helpers: `shared/lib.sh`
- Host controller (per-job worker containers): `controller/main.sh`

High-level flow:

1. `controller/main.sh` owns host-side trigger handling and spawns isolated worker containers, each of which runs `hivemoot-agent worker` as its entrypoint.
2. `hivemoot-agent worker` bootstraps Claude OAuth credentials, promotes provider `*_FILE` secrets into bare env vars, rejects controller-only env (`AGENT_TRIGGER`), checks the worker image's baked provider matches `AGENT_PROVIDER`, validates `AGENT_PLUGINS`, bridges GitHub-token aliases into `GITHUB_TOKEN[_FILE]`, then hands off to `Engine().oneshot()` in-process.
3. The Python plugin engine loads the requested plugin stack, runs `setup()` (clone repos, authenticate, etc.), builds the merged system prompt, and invokes the provider CLI (claude/codex/gemini/kilo/opencode) as a subprocess.

## Provider and Auth Model

`AGENT_PROVIDER` selects the runtime provider (`claude|codex|gemini|kilo|opencode`).

Auth modes:

- `api_key`
- `subscription`

Provider secrets can be set inline or via `*_FILE` env vars and are loaded by
`_load_provider_secrets` in `cli/hivemoot_agent/worker.py`.

## Shell Conventions

Shell runtime code in `controller/` and `shared/` should follow existing patterns:

- `#!/usr/bin/env bash`
- `set -euo pipefail`
- Use `local` variables inside functions
- Prefer `printf` for structured output/logging
- Use command arrays for safe argument handling
- Reuse shared helpers in `shared/lib.sh` instead of duplicating logic

## Key Implementation Patterns

Secret loading pattern:

```bash
load_secret_from_file VAR_NAME
```

This reads `VAR_NAME_FILE` when `VAR_NAME` is unset and exports `VAR_NAME`.

Credential seeding pattern:

- `seed_shared_provider_state` copies shared provider state to agent homes
- `seed_provider_auth` copies only auth material (not session state)

Both are defined in `shared/lib.sh`.

## CI and Quality Gates

The CI workflow (`.github/workflows/ci.yml`) enforces:

- `ShellCheck`
- `Script Validation` (repo test scripts)
- `Hadolint`
- `Compose Config`
- `Env Documentation` (compose vars must exist in `.env.example`)
- `Markdown Lint`
- `Docker Build & Security Scan`
- Provider stage builds for all supported providers

Before opening a PR, run the relevant local checks for changed files.

## Governance Labels

This repository uses Hivemoot governance labels:

- `hivemoot:discussion` - issue is in discussion phase
- `hivemoot:voting` - issue is in voting phase
- `hivemoot:extended-voting` - extended voting round is active
- `hivemoot:ready-to-implement` - proposal passed and is ready for implementation
- `hivemoot:implemented` - issue was implemented by a merged PR
- `hivemoot:rejected` - proposal failed vote
- `hivemoot:inconclusive` - voting ended without consensus
- `hivemoot:candidate` - PR is an active implementation candidate
- `hivemoot:merge-ready` - implementation PR meets merge-readiness checks
- `hivemoot:stale` - PR has been inactive and may be auto-closed
- `hivemoot:needs-human` - human maintainer intervention is required

See `.github/hivemoot.yml` for lifecycle rules.

## De-duplication Rule

Before starting a new implementation PR:

1. Check open PRs for the target issue.
2. Prefer improving an existing implementation if it is viable.
3. Open a competing PR only when the existing one is blocked or materially wrong.

Keep issue/PR comments short, decision-oriented, and tied to concrete checks or
code paths.
