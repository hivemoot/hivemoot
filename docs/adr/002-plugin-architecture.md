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

- A future host-side trigger for cases that genuinely need per-job
  container isolation (separate blast radius, per-job resource caps)
  remains out of scope.  If one is added, it must be a new primitive
  designed around the plugin protocol, not a revival of the shell
  supervisor.

Completed follow-ups:

- ✅ `github-mention` and `github-review-request` triggers — moved
  to `cli/hivemoot_agent/plugins_builtin/github/{trigger,watcher,ack,prompts}.py`.
  The plugin owns the polling loop, dispatches events as Jobs through
  the engine, and acks notifications via `hivemoot ack` from
  `on_job_finished` only on successful runs.  Env-gated by
  `GITHUB_WATCH_MENTIONS=1` and `GITHUB_WATCH_REVIEW_REQUESTS=1`.
- ✅ `cron` plugin — added
  `cli/hivemoot_agent/plugins_builtin/cron/` with `CronPlugin`,
  `CronTrigger`, a stdlib-only 5-field cron expression parser
  (`expression.py`), an `@every Nh/Nm/Ns/Nd` shorthand, and a
  `Schedule` config object (`schedule.py`).  Replaces the retired
  host-side `controller/triggers/periodic.sh` with strictly-better
  semantics: each schedule entry has its own cron expression, prompt
  body, optional jitter, and optional session resume.  A fleet that
  wants the old "wake up every hour with the role prompt" behaviour
  writes one entry; a fleet that wants "triage at 9am weekdays,
  security audit on Mondays, autonomous work every 2h" writes three.
  All times UTC to sidestep DST.  Config lives in
  `CRON_SCHEDULES_JSON` env var.  Stdlib-only — no cron parser
  dependency added, keeping the "no third-party Python deps at
  runtime" discipline the rest of the CLI follows.  Enable by listing
  `cron` in `AGENT_PLUGINS`.  The shell `controller/triggers/periodic.sh`
  was retired with the rest of the host-side supervisor — see
  follow-up below.
- ✅ `hivemoot-task` decoupled from `github` — the plugin no longer
  requires `GITHUB_REPOS` / `TARGET_REPO`, no longer requires `github`
  to appear in `AGENT_PLUGINS`, and no longer bakes repo context into
  its system prompt.  A task is a generic unit of work; the backend
  can dispatch anything ("review this RFC," "summarize yesterday's
  governance," "edit file X in repo Y") and the plugin dispatches it
  without enforcing a repo contract.  `Job.metadata["repo"]` is kept
  as informational pass-through for plugins that want it, and tasks
  that happen to involve a repo use whatever other plugins (github,
  hivemoot-github) are loaded to access it.  Enables a pure
  `AGENT_PLUGINS=hivemoot-task` task-worker role with no repo
  plumbing.
- ✅ Host-side shell supervisor retired.  Deleted
  `controller/core/`, `controller/triggers/`, `shared/lib-*.sh`
  (global slots, classify, observability, agent slots, path
  validators), and the shell test scripts that exercised them.
  All triggers now run in-process inside `hivemoot-agent run`;
  container supervision (one daemon per agent role × repo) is
  handled by systemd / docker-compose / the deployer's orchestrator,
  not by a bash process watching docker from the host.  Compose
  services set `command: ["run"]` for daemon mode; the Dockerfile
  CMD default stays `["worker"]` so a raw `docker run` with no
  plugin config fails fast instead of entering an idle daemon.
  `controller/main.sh` and `scripts/controller.sh` remain as thin
  deprecation stubs that exit with a clear migration message until
  apiary's deploy scripts migrate; they can be deleted after that.
- ✅ Three-layer system prompt: root + identity + plugins.  The
  engine now assembles system prompts in three distinct, tagged
  layers instead of merging everything through plugin composition.
  `<root>` is the runtime's universal baseline (security posture,
  honesty, reasoning discipline), shipped in-repo at
  `cli/hivemoot_agent/root_system_prompt.md` and always applied.
  `<identity>` is deployer-supplied at container-setup time via
  `AGENT_IDENTITY_FILE` — per-agent content (role, voice, mission,
  domain conventions) that isn't baked into this repo.  `<plugin>`
  blocks remain for capability content only.  The `hivemoot-identity`
  plugin is demoted to a transitional deprecation shim that emits a
  warning and still contributes the legacy voice/commit content so
  unmigrated fleets don't regress mid-rollout; once deployers mount
  their own identity files, the shim gets deleted.  This fixes two
  problems with the old approach: security rules are now always
  applied regardless of `AGENT_PLUGINS` (can't be accidentally
  omitted), and identity is a first-class deployer input instead of
  a singleton-disguised-as-plugin.

## References

- `cli/hivemoot_agent/plugins/interfaces.py` — `Plugin` and `Trigger` protocols.
- `cli/hivemoot_agent/plugins_builtin/messaging/` — reference plugin (Telegram).
- `cli/hivemoot_agent/plugins_builtin/hivemoot_task/` — reference plugin (hivemoot.dev tasks).
- ADR-001 (`docs/adr/001-controller-runtime-migration.md`) — covers the
  controller layer's own runtime; this ADR covers the worker / plugin layer.
