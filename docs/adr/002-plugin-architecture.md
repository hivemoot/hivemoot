# ADR-002: Plugin Architecture — host is plugin-agnostic

**Status:** Accepted
**Date:** 2026-04-18

## Context

Between PRs #525 (initial plugin engine), #565–#570 (per-plugin extractions),
and #571 / #573 / #574 (host-side migrations), the runtime drifted into a
mixed model:

- **Worker-side** plugins exist under `cli/hivemoot_agent/plugins_builtin/<name>/`
  and own the agent's behaviour (system prompt, skills, lifecycle hooks).
- **Host-side** shell triggers under `controller/triggers/<name>.sh` perform
  plugin-specific polling (Telegram, hivemoot.dev tasks, GitHub mentions),
  enqueue jobs, and call `hivemoot-agent <name> ...` Python CLI subcommands
  introduced specifically to support those triggers (e.g.
  `hivemoot-agent messaging watch`, `hivemoot-agent health heartbeat`).

This split has three concrete failure modes:

1. **CLI surface grows with every plugin.** Each new data source added a new
   top-level subcommand group on `hivemoot-agent`. The CLI is no longer a
   stable contract — it's a plugin manifest.
2. **Host knows about plugins.** `controller/main.sh` runs preflight for the
   messaging plugin, `controller/triggers/periodic.sh` knows about heartbeats,
   `controller/core/jobs.sh` forwards plugin-specific env vars to workers.
   Adding or removing a plugin requires touching the host.
3. **Two parallel implementations of "trigger".** The `Plugin.triggers()` /
   `Trigger.start()` protocol was designed for in-process polling, but every
   shell trigger duplicates the same polling loop in bash and reaches into
   Python via subprocess. The duplication has already produced regressions
   (PR #573 caught a stale CLI call from PR #525; PR #574 review found a
   silent heartbeat failure on the production host).

## Decision

**The host is plugin-agnostic. All plugin-specific behaviour lives inside the
plugin.**

Concretely:

- The container entrypoint is `hivemoot-agent run` (daemon mode). It loads the
  plugins listed in `AGENT_PLUGINS`, calls each plugin's `triggers()`, and
  runs `Trigger.start(dispatcher)` so the plugin owns its polling/listening
  loop in-process.
- Inbound jobs are dispatched to the agent via `JobDispatcher.dispatch(job)`.
  The engine runs the agent (Claude / Codex / etc.) as a subprocess in the
  same container, then routes lifecycle events through the plugin's
  `on_job_started` / `on_agent_output` / `on_job_finished` hooks.
- One container per agent role × repo. Job-level isolation is provided by the
  agent CLI subprocess boundary (each job spawns a fresh `claude -p …`),
  not by spawning a fresh container per job.

The CLI surface stays fixed and generic:

| Command | Purpose |
|---|---|
| `hivemoot-agent run` | Daemon (load plugins, start triggers, route jobs) |
| `hivemoot-agent oneshot` | One-shot job (no triggers; for direct invocation) |
| `hivemoot-agent worker` | Container entrypoint shim (env validation → `oneshot`) |
| `hivemoot-agent plugin list` | Discovery |
| `hivemoot-agent plugin doctor <name>` | Validate one plugin's config |
| `hivemoot-agent doctor` | Generic health check |

**No `hivemoot-agent <plugin-name> ...` subcommands.** Adding a plugin must
not change the CLI surface.

The host-side shell controller `controller/main.sh` retires its
plugin-specific triggers (`messaging.sh`, `hivemoot-task.sh`, eventually
`github-*.sh`) and the `controller/triggers/periodic.sh` heartbeat path. What
remains in `controller/` is generic container supervision and any non-plugin
operational glue.

## Plugin contract — what a plugin owns end-to-end

A plugin directory `cli/hivemoot_agent/plugins_builtin/<name>/` contains
**everything** the plugin needs:

```text
<name>/
├── __init__.py           # Plugin class implementing the Plugin protocol
├── trigger.py            # Trigger class (polling / listening loop)
├── api.py                # External-service HTTP client (if any)
├── system_prompt.py      # System prompt fragment
├── skills/               # Optional bundled skills
└── prompts/              # Optional prompt templates
```

The `Plugin` protocol (`cli/hivemoot_agent/plugins/interfaces.py`) provides
the hooks the plugin needs:

| Hook | Used for |
|---|---|
| `validate(config)` | Reject malformed config at startup |
| `setup(config)` | One-time setup (clone repos, authenticate) |
| `triggers()` | Return the list of `Trigger` instances |
| `system_prompt(config)` | Persistent system context injected into every job |
| `on_job_started(job, config)` | Start heartbeat / typing indicator / status thread |
| `on_agent_output(job, event, config)` | React to streaming events from the agent |
| `on_job_finished(job, result, config)` | Send response, post final status |

The `Trigger` protocol is the data-source listener:

| Method | Purpose |
|---|---|
| `validate(config)` | Reject malformed trigger config |
| `start(config, dispatcher)` | Block, listen, call `dispatcher.dispatch(job)` |
| `stop()` | Idempotent shutdown |

Reference implementations:
- `cli/hivemoot_agent/plugins_builtin/messaging/` — Telegram polling, typing
  indicators, streaming progress, response delivery.
- `cli/hivemoot_agent/plugins_builtin/hivemoot_task/` — hivemoot.dev API
  polling, heartbeats, result extraction, codex auth-error promotion.

## What this rules out

- **Plugin-specific top-level CLI subcommands** (`hivemoot-agent messaging *`,
  `hivemoot-agent health *`, `hivemoot-agent task *` etc.). If a plugin needs
  an operator-facing diagnostic, expose it via `plugin doctor` or as a method
  the engine calls during `setup()`.
- **Plugin-specific shell triggers in `controller/triggers/`.** All triggers
  are Python `Trigger` implementations inside their plugin directory.
- **Plugin-specific env wires in `controller/core/jobs.sh`.** The host
  forwards a fixed set of generic vars (auth tokens, workspace paths). Any
  plugin-specific env (`MESSAGING_*`, `AGENT_TASK_*`) is read by the plugin
  itself when it loads.
- **Out-of-tree CLI shims** that wrap a plugin operation as a subcommand for
  the controller to call. The controller doesn't call plugin operations.

## Consequences

**Positive:**
- Adding a plugin is a single-directory change. No host modifications.
- Plugin behaviour is unit-testable end-to-end without spinning up a shell
  controller. Every regression class that #571–#574 review caught (silent
  heartbeat failure, stale CLI call from a previous PR, redirect-followed
  Authorization leak, missed `_FILE` token chain) was preventable by
  exercising the plugin in isolation.
- The CLI is a stable contract. Operator scripts and runbooks don't break
  when a plugin is added or removed.

**Negative / trade-offs:**
- One container per agent role × repo means jobs run sequentially within an
  agent. The plugin engine already serializes jobs; no behaviour change for
  current workloads, but high-burst use cases would need explicit per-plugin
  concurrency.
- Crash isolation drops from per-job-container to per-agent-container. The
  agent CLI subprocess boundary still isolates one job's runtime from the
  next, but a Python-level crash takes the whole agent down. Mitigated by
  systemd restart policy.
- Persistent state (sessions, memory) must be intentionally scoped per
  plugin/job — already handled today via `session_key` and the per-plugin
  workspace conventions.

## Migration

This ADR was adopted concurrently with the consolidated cleanup PR that:

1. Implements the `hivemoot_task` plugin (`Trigger`, lifecycle hooks, API
   client, result extractors) — completing the in-process plugin pattern
   for tasks.
2. Retires `controller/triggers/{messaging,hivemoot-task}.sh` and the
   heartbeat path in `controller/triggers/periodic.sh`.
3. Retires the per-plugin top-level CLI subcommand groups
   (`hivemoot-agent messaging *`, `hivemoot-agent health *`).
4. Retires the host-side `HIVEMOOT_AGENT_CLI` plumbing introduced to call
   those subcommands.

Open follow-ups (separate PRs):

- Migrate `controller/triggers/periodic.sh` (the scheduling loop) to a
  plugin or to engine-level scheduling.
- Once all triggers are plugins, retire `controller/main.sh` itself —
  what remains is container supervision, which systemd / docker-compose
  already provides directly.

Completed follow-ups:

- ✅ `github-mention` and `github-review-request` triggers — moved
  to `cli/hivemoot_agent/plugins_builtin/github/{trigger,watcher,ack,prompts}.py`.
  The plugin owns the polling loop, dispatches events as Jobs through
  the engine, and acks notifications via `hivemoot ack` from
  `on_job_finished` only on successful runs.  Env-gated by
  `GITHUB_WATCH_MENTIONS=1` and `GITHUB_WATCH_REVIEW_REQUESTS=1`.

## References

- `cli/hivemoot_agent/plugins/interfaces.py` — `Plugin` and `Trigger` protocols.
- `cli/hivemoot_agent/plugins_builtin/messaging/` — reference plugin (Telegram).
- `cli/hivemoot_agent/plugins_builtin/hivemoot_task/` — reference plugin (hivemoot.dev tasks).
- ADR-001 (`docs/adr/001-controller-runtime-migration.md`) — covers the
  controller layer's own runtime; this ADR covers the worker / plugin layer.
