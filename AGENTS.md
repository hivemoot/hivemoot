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

The runtime follows **ADR-002: Plugin Architecture** — the host is plugin-agnostic;
all plugin-specific behaviour lives inside the plugin. Read
[`docs/adr/002-plugin-architecture.md`](docs/adr/002-plugin-architecture.md) before
changing the architecture; what follows is a summary.

**Components:**

- Container entrypoint: `hivemoot-agent run` (daemon mode) — loads plugins per `AGENT_PLUGINS`, starts each plugin's `Trigger`, dispatches inbound jobs in-process. This is the image's default CMD.
- Oneshot entrypoint: `hivemoot-agent worker` (`cli/hivemoot_agent/worker.py`) — env validation + Claude OAuth bootstrap, then hands off to the engine's `oneshot` path. Use for single explicit runs; does **not** start trigger threads.
- Plugin engine: `cli/hivemoot_agent/engine.py` — owns job execution, plugin loading, agent subprocess spawning.
- Plugins live in `cli/hivemoot_agent/plugins_builtin/<name>/`. Each plugin owns its `Trigger` (data source), `Plugin` (lifecycle hooks), workload (`system_prompt`, skills), and any external API client. **Single directory, single source of truth per plugin.**
- No host-side shell supervisor. The container is long-lived; triggers run in-process threads; systemd / `docker compose` / a container orchestrator handles container supervision.

**The non-negotiable rules:**

1. **No `hivemoot-agent <plugin-name> ...` CLI subcommands.** The CLI surface is fixed: `run`, `oneshot`, `worker`, `plugin list`, `plugin doctor`, `doctor`. Adding a plugin must not change argparse.
2. **No host-side trigger scripts.** All triggers are Python `Trigger` implementations inside their plugin directory.
3. **No cross-plugin env snooping.** Each plugin reads its own env (`MESSAGING_*`, `AGENT_TASK_*`, `GITHUB_*`, `CRON_*`, etc.) at load time; a plugin MUST NOT read another plugin's config.

Reference plugins:
- `cli/hivemoot_agent/plugins_builtin/messaging/` (Telegram polling, typing, response delivery).
- `cli/hivemoot_agent/plugins_builtin/hivemoot_task/` (hivemoot.dev API polling, heartbeats, result extraction).

## Provider and Auth Model

`AGENT_PROVIDER` selects the runtime provider (`claude|codex|gemini|kilo|opencode`).

Auth modes:

- `api_key`
- `subscription`

Provider secrets can be set inline or via `*_FILE` env vars and are loaded by
`_load_provider_secrets` in `cli/hivemoot_agent/worker.py`.

## Shell Conventions

The remaining shell lives under `scripts/` and covers repo hygiene
(trivy checks, script executable bits) plus compose-level contract
tests that Python can't reach.  When editing these scripts:

- `#!/usr/bin/env bash`
- `set -euo pipefail`
- Use `local` variables inside functions
- Prefer `printf` for structured output/logging
- Use command arrays for safe argument handling

Per ADR-002, **agent runtime code is Python.** New plugin work, new
triggers, and new per-plugin logic belong under
`cli/hivemoot_agent/plugins_builtin/<name>/`.

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
