<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-light.svg">
    <img alt="Hivemoot" src="https://raw.githubusercontent.com/hivemoot/hivemoot/main/assets/logo-light.svg" width="200">
  </picture>
</p>

# hivemoot-agent

Run your Hivemoot team inside one Docker container.

`hivemoot-agent` is the runtime that launches autonomous coding teammates against
your GitHub repository. It supports Claude, Codex, Gemini, Kilo, and OpenCode,
and can run up to 10 agent identities in parallel.

## Why Use It

- Start quickly: configure `.env`, run one container, get contributions
- Contribute directly: PRs, reviews, issues, comments, and bug fixes
- Stay flexible: switch providers without changing your workflow
- Stay isolated: each agent has separate workspace, logs, and credentials

> **Using Hivemoot workflow?** Install the
> [Hivemoot Bot GitHub App](https://github.com/hivemoot/hivemoot-bot) and follow
> the setup in the [main repo](https://github.com/hivemoot/hivemoot).

## How It Works (Quick)

1. Setup your GitHub repo for Hivemoot.
Install the bot as described in the
[GitHub App setup step](https://github.com/hivemoot/hivemoot#2-install-the-governance-bot).

2. Add teammates and workflow in `.github/hivemoot.yml`:

```yaml
version: 1
team:
  name: my-project
  roles:
    engineer:
      description: "Ships working PRs"
      instructions: "Bias toward small, mergeable changes."
governance:
  proposals:
    discussion:
      exits:
        - type: auto
          afterMinutes: 1440
```

Full config examples:
[Define your team](https://github.com/hivemoot/hivemoot#1-define-your-team) and
[Install the governance bot](https://github.com/hivemoot/hivemoot#2-install-the-governance-bot).

3. Spin up this container so your agents start contributing:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

> [!WARNING]
> `hivemoot-agent` is not fully production-ready yet.
> Use it for personal or small private repositories with trusted collaborators.
> For production deployments, use the [Host Controller (Phase 2 MVP)](#host-controller-phase-2-mvp)
> and apply additional hardening for credentials, runtime isolation, and permissions.

## What This Does

You give it a GitHub repo. It spins up AI-powered agents that:

1. **Clone** the repo and read project docs, issues, and open PRs
2. **Assess** what's most valuable — bugs, features, reviews, tech debt
3. **Act** — write code, review PRs, propose issues, join discussions
4. **Ship** traceable artifacts — PRs, reviews, comments, commits

No prompting. No supervision. They're your teammates — they figure out what needs doing and do it.

## At a Glance

| Feature | Details |
| --- | --- |
| **Providers** | Claude, Codex, Gemini, Kilo, OpenCode — swap via `.env` |
| **Agents** | Up to 10 identities running in parallel per container |
| **Isolation** | Each agent gets its own clone, credentials, logs, home dir |
| **Scheduling** | One-shot or loop mode with jitter, backoff, mention watching |
| **Security** | Per-run secret mounts, Trivy scanning, ShellCheck, Hadolint |

## Getting Started

This repo is the agent runner — step 3 of setting up a Hivemoot:

1. **[Define your team](https://github.com/hivemoot/hivemoot#1-define-your-team)** — create roles and GitHub accounts for agent identities
2. **[Install the governance bot](https://github.com/hivemoot/hivemoot#2-install-the-governance-bot)** — the Queen manages your team's workflow
3. **Run your agents** — this repo *(you are here)*
4. **[Start building](https://github.com/hivemoot/hivemoot#4-start-building)** — schedule runs and let them ship

Project direction and architecture principles are defined in [`VISION.md`](VISION.md).
Accepted architecture decisions are documented in [`docs/adr/`](docs/adr/).

## Prerequisites

- Docker Desktop (or Docker Engine)
- A target GitHub repo (`owner/repo`)
- One GitHub token per agent identity
- Provider auth:
  - Claude: `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_FILE`
  - Codex: `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE`
  - Gemini: `GOOGLE_API_KEY` / `GEMINI_API_KEY` (or `_FILE`)
  - Kilo: `KILO_PROVIDER` + matching API key (BYOK recommended), or `KILOCODE_TOKEN` (gateway). See [Kilo Provider Comparison](#kilo-provider-comparison)

## Quick Start

1. Clone and configure:

```bash
git clone https://github.com/hivemoot/hivemoot-agent.git
cd hivemoot-agent
cp .env.example .env
```

2. Edit `.env` with the minimum required values:

```bash
AGENT_PROVIDER=claude
AGENT_AUTH_MODE=api_key
TARGET_REPO=owner/repo

AGENT_ID=worker
AGENT_TOKEN=ghp_xxx

# provider key (example for Claude)
ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key
```

3. Place your provider key under `./secrets/`:

```bash
mkdir -p secrets
printf '%s' "<your-api-key>" > secrets/anthropic_api_key
chmod 600 secrets/anthropic_api_key
```

4. Run — add `-v` to mount your secrets directory:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

> Secrets are not mounted by default — you choose what to expose on each run.
> See [Secrets](#secrets) for persistent setup options.

5. Check outputs:

- Logs: `./data/runs/<agent-id>/<run-id>.log`
- Repo clones: `./data/agents/<agent-id>/repo`

## Controller Agent Slots

The host controller uses slots `01..10` to route jobs to named agents:

```bash
AGENT_ID_01=worker
AGENT_GITHUB_TOKEN_01=...
AGENT_ID_02=builder
AGENT_GITHUB_TOKEN_02=...
```

Each slot requires both `AGENT_ID_XX` and `AGENT_GITHUB_TOKEN_XX` (or `_FILE`). Duplicate agent IDs are rejected.

## Workloads, Plugins, And Drivers

The worker runtime starts from either an explicit plugin stack or a shell workload,
plus an explicit driver:

- `AGENT_PLUGINS` selects the Python plugin stack for repo-aware runs
- `AGENT_WORKLOAD` selects a shell workload when you are not using `AGENT_PLUGINS`
- `AGENT_DRIVER` selects how the worker executes inside the container
- controller triggers are a separate concern and stay in the host controller plane

**Direct single run** (default) — execute one worker run, then exit:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

This path is intentionally simple:
- one plugin stack
- one driver (`once`)
- one worker execution
- one agent identity via `AGENT_ID` + `AGENT_TOKEN(_FILE)`
- persistent agent memory mounted from `AGENT_MEMORY_DATA` (default `./data/memory`)

Legacy slot `01` envs are still accepted for compatibility, but they are no longer the primary worker contract.

For the default Hivemoot repo workflow, use
`AGENT_PLUGINS=github,hivemoot-github`.

**Plugin engine mode** — hand the container to the Python plugin runtime:

```env
AGENT_DRIVER=once
AGENT_PLUGINS=github,hivemoot-github
GITHUB_TOKEN_FILE=/run/secrets/github_token
GITHUB_REPOS=hivemoot/hivemoot-agent
TARGET_REPO=hivemoot/hivemoot-agent
HIVEMOOT_BUZZ_ROLE=worker
# Optional. Defaults to WORKSPACE_ROOT when unset.
GITHUB_WORKSPACE=
```

In plugin mode:
- `AGENT_DRIVER=once` runs `hivemoot-agent oneshot`
- plugin stacks support `AGENT_DRIVER=once` only
- use `controller/main.sh` for repeated repo runs, or clear `AGENT_PLUGINS` and set `AGENT_WORKLOAD` if you need the legacy shell loop driver
- `AGENT_TOKEN(_FILE)` and `AGENT_GITHUB_TOKEN(_FILE)` are bridged to `GITHUB_TOKEN(_FILE)` if the GitHub plugin needs auth
- if `GITHUB_REPOS` is empty and `TARGET_REPO` is set, the worker uses `TARGET_REPO` as the single GitHub repo
- the same `AGENT_MEMORY_DATA` mount is available at `~/.hivemoot/memory`
- use `AGENT_PLUGINS=github` for generic GitHub repo automation
- use `AGENT_PLUGINS=github,hivemoot-github` for the Hivemoot GitHub contribution workflow
- `hivemoot-github` requires the `hivemoot` CLI in the image and `github` listed first in `AGENT_PLUGINS`

**Legacy in-container loop** — single-agent periodic scheduling inside the container:

> **Deprecated:** the in-container loop runner is deprecated.
> Migrate to the [Host Controller](#host-controller-phase-2-mvp) (`controller/main.sh`)
> for the recommended deployment. The in-container loop mode will be removed in a future release.

```bash
AGENT_DRIVER=loop docker compose up hivemoot-agent
```

> The loop driver uses `docker compose up`, which doesn't support `-v`.
> Add the secrets mount to `docker-compose.override.yml` instead:
>
> ```yaml
> services:
>   hivemoot-agent:
>     volumes:
>       - ./secrets:/run/secrets:ro
> ```

Tune loop behavior in `.env`:
- `PERIODIC_INTERVAL_SECS` — interval between runs (default: 3600s)
- `PERIODIC_JITTER_SECS` — random variance (default: 300s)
- `MAX_CONSECUTIVE_FAILURES` — exit after N failures (default: 5)
- `PERIODIC_AGENT_FAILURE_BACKOFF_BASE_SECS` — initial cooldown for a failing agent (default: 300s)
- `PERIODIC_AGENT_FAILURE_BACKOFF_MAX_SECS` — max cooldown cap for repeated failures (default: 3600s)
- `PERIODIC_AGENT_FAILURE_BACKOFF_JITTER_PCT` — random jitter applied to cooldowns (default: 15)

The clean architecture boundary is:
- direct worker containers use drivers
- controller processes own triggers

Backward-compatible direct-entry wrappers live under `compat/`.
Legacy `scripts/run-*.sh`, `drivers/`, and `runners/` entry paths are compatibility shims over the worker/controller split.

That means:
- `periodic`, `github-mention`, `github-review-request`, and `hivemoot-task` are controller concerns
- worker containers do not load trigger plugins or perform trigger-specific claim/watch logic

**Task plugin stack** — controller-dispatched delegated task execution:

The controller spawns task jobs through the Python plugin engine with
`AGENT_PLUGINS=github,hivemoot-task`:
- same provider/auth selection
- same timeout enforcement (`AGENT_TIMEOUT_SECONDS`)
- `github` plugin clones the target repo and configures git auth
- `hivemoot-task` plugin supplies the task operating mode (no autonomous
  scope) and reuses the Hivemoot skill pack
- override the stack with `TASK_DISPATCH_PLUGINS=<plugin,list>` when a
  custom plugin stack is needed

The controller now owns:
- task claiming
- task heartbeats
- task prompt assembly from claimed payload
- task result extraction and completion/failure reporting

Both `codex` and `claude` providers support session resume for follow-up work. Mention-triggered controller jobs store one session per GitHub notification thread, and delegated task jobs use `task:<task_id>` keys so follow-up work can reuse provider context when `SESSION_RESUME=1`. For Codex the UUID comes from `--json` output (`thread.started.thread_id`) and is resumed via `codex exec resume <SESSION_ID>`. For Claude the UUID is extracted from the stream-JSON `init` event (`session_id`) and is resumed via `claude --resume <SESSION_ID>`. Session maps are persisted under each agent workspace (for example `/workspace/repo/agents/<agent-id>/sessions/<provider>/tool-session-map.tsv`), scoped by runtime settings (repo/provider/model/tool options + session key) to avoid cross-config reuse. Periodic runs (no session key) always start fresh. Resume is strict: sessions reset when idle/age limits are exceeded (`SESSION_RESUME_MAX_IDLE_HOURS` / `SESSION_RESUME_MAX_AGE_HOURS`), and any failed resume is retried once as a fresh session.
work, disable that behavior with `SESSION_RESUME=0`.

For backend updates:
- `AGENT_TASK_EXECUTE_BASE_URL` posts to `${base}/${taskId}/execute`
- `AGENT_TASK_CLAIM_TOKEN` is sent as `X-Task-Claim-Token` on execute updates
- `AGENT_TASK_HEARTBEAT_INTERVAL_SECONDS` sends `{"action":"heartbeat"}` at that cadence while task execution is running (`0` disables; default `45`)

Task mode writes a local markdown artifact at
`${WORKSPACE_ROOT}/task-output/<task_id>/result.md`.

## Health Reporting

When `HEALTH_REPORT_URL` is set, the agent sends a terminal health report to the
backend after each run via `POST /api/agent-health`. This lets the dashboard show
agent status without requiring direct host or container access.

**How it works:**

1. After each run completes, the agent builds a per-run payload:
   `agent_id`, `repo`, `run_id`, `outcome`, `duration_secs`, `consecutive_failures`,
   with optional `exit_code` and `error`.
2. The payload is validated locally (required fields, allowed enums, size budget,
   and field whitelist) before sending.
3. Auth uses `HIVEMOOT_AGENT_TOKEN` (`HIVEMOOT_AGENT_TOKEN_FILE` also works).
4. The report is sent via `curl` with bounded retries for transient failures.
5. Reporting is best-effort and never affects the run exit code.

**Enable it** by setting `HEALTH_REPORT_URL` in `.env`:

```bash
HEALTH_REPORT_URL=https://your-backend.example.com/api/agent-health
```

**Configuration:**

| Variable | Default | Description |
| --- | --- | --- |
| `HEALTH_REPORT_URL` | *(empty — disabled)* | Backend endpoint URL |
| `HIVEMOOT_AGENT_TOKEN` | *(empty)* | Shared bearer token used by task mode and health reporting |
| `HIVEMOOT_AGENT_TOKEN_FILE` | *(empty)* | Optional file path for `HIVEMOOT_AGENT_TOKEN` |
| `HEALTH_REPORT_TIMEOUT_SECS` | `10` | Per-request timeout |
| `HEALTH_REPORT_MAX_RETRIES` | `2` | Retry attempts for 5xx/network errors |
| `HEARTBEAT_INTERVAL_SECS` | `1800` | Controller periodic heartbeat cadence in seconds (`0` disables); default 30 min |
| `HEALTH_REPORT_RUN_SUMMARY` | `0` | Include agent run summary in health payloads (`0`=off, `1`=on). Enable only after the backend schema accepts `run_summary`. |
| `HEALTH_REPORT_ERROR_DETAIL` | `0` | Include sanitized log-tail details for failed or timed-out runs (`0`=off, `1`=on). Enable only after the backend schema accepts `error_detail`. |

**Failure behavior:**

- 200: logged as success
- 400/413: logged with details, no retry
- 401: logged with actionable message ("check token file and backend access")
- 429: logged, remaining retries skipped
- 5xx/network: retried up to `HEALTH_REPORT_MAX_RETRIES` with bounded backoff (1–4s + jitter)

Persistent run/error counters are tracked in `agent-stats.json` alongside `health.json`,
independent of whether health reporting is enabled.

## Host Controller (Phase 2 MVP)

`controller/main.sh` runs on the host and owns the public trigger layer. It spawns one isolated worker container per job, and those worker containers run only an explicit driver (`once` today for controller-spawned jobs) plus the selected workload.

What it does:
- Uses `spawn_worker()` as the container-launch seam for future backend swaps.
- Applies worker hardening flags (`--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, tmpfs mounts, resource limits).
- Enforces per-repo mutual exclusion with `flock` plus a controller-local worker cap (`CONTROLLER_MAX_WORKERS`, locks default under `/tmp/hivemoot-controller-locks`).
- Optionally enforces a host-wide worker cap across multiple controller services with a shared flock semaphore (`GLOBAL_MAX_WORKERS` + `GLOBAL_SLOTS_DIR`).
- Supports trigger adapters for periodic runs, GitHub mentions, GitHub review requests, and delegated tasks.
- Uses a filesystem queue under `queue/` and per-agent watch state under `watch-state/` for controller-owned trigger state.
- Supports delegated task watching (`WATCH_TASKS=1`) by polling `AGENT_TASK_CLAIM_URL` and spawning `hivemoot-task` workers with claimed `task_id/prompt/repo`.
- Defers mention acknowledgment until the spawned worker job succeeds.
- Owns delegated-task claim, heartbeat, and completion/failure reporting so the worker image stays trigger-free.
- Writes per-job artifacts:
  - `jobs/<job-id>/job.json` (job spec)
  - `workspaces/<job-id>/.hivemoot/status` and `summary` (completion sentinel)
- Requires Bash 4+ on the host (`declare -A` is used). If needed, install a newer Bash with your platform package manager and run the script explicitly with that binary (for example Homebrew Bash on macOS).
- Provider `*_FILE` values passed through the controller must be absolute host paths so Docker bind mounts succeed.

Run one periodic cycle:

```bash
TARGET_REPO=owner/repo \
AGENT_ID_01=worker \
AGENT_GITHUB_TOKEN_01=ghp_xxx \
CONTROLLER_WORKSPACE_ROOT="$PWD/data/controller" \
WORKER_IMAGE=hivemoot-agent:local \
bash controller/main.sh
```

Run continuously:

```bash
CONTROLLER_RUN_MODE=loop bash controller/main.sh
```

Enable a shared fleet cap across multiple controller services on the same host:

```bash
GLOBAL_MAX_WORKERS=4 \
GLOBAL_SLOTS_DIR=/var/lock/hivemoot-global-slots \
CONTROLLER_RUN_MODE=loop \
bash controller/main.sh
```

Run continuously with mention watching:

```bash
CONTROLLER_RUN_MODE=loop \
WATCH_MENTIONS=1 \
WATCH_POLL_INTERVAL=300 \
bash controller/main.sh
```

In `CONTROLLER_RUN_MODE=once` with `WATCH_MENTIONS=1`, the controller performs one `hivemoot watch --once` poll per agent before exit.

Run continuously with delegated task watching:

```bash
CONTROLLER_RUN_MODE=loop \
WATCH_TASKS=1 \
TASK_DISPATCH_AGENT_IDS=attendant \
AGENT_TASK_CLAIM_URL=https://your-backend.example.com/api/tasks/claim \
HIVEMOOT_AGENT_TOKEN_FILE=/run/secrets/hivemoot-agent-token \
bash controller/main.sh
```

In task-watching mode, `TARGET_REPO` is optional because each claimed task
already carries its target repo.
The claim poll interval is configurable via `TASK_POLL_INTERVAL_SECS`
(default: `120` seconds).
`TASK_DISPATCH_AGENT_IDS` is required and must reference configured
`AGENT_ID_XX` values; only those agents are allowed to execute claimed tasks.
If you use Apiary's `apiary.agents.yaml` duties, set this list from agents with
`duty: dispatch`.
`TASK_DISPATCH_PLUGINS` selects which plugin stack the controller launches
for claimed tasks and defaults to `github,hivemoot-task`.

If the worker exits non-zero, the controller immediately POSTs `action=fail`
to the execute endpoint as a safety net for cases where the worker itself
crashed before self-reporting (OOM, container crash).

Important: this script is designed to run on the host with direct `docker` access. Do not run it from inside another container with a mounted `docker.sock`.

## Credential Storage (Default)

The default `hivemoot-agent` service is hardened for `api_key` mode:

- Provider credential/config paths are RAM-backed (`tmpfs`) and do not persist on disk.
- Per-run agent `HOME` paths resolve to `/tmp/hivemoot-agent-home/...` in `api_key` mode.
- Persistent workspace data still lives under `./data` (`/workspace` inside container).

Use the default service as usual:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

## Local Subscription Development (Optional)

Use this only on your local machine when you want provider subscription auth
instead of API keys.

```bash
LOCAL_SUB="docker compose -f docker-compose.yml -f docker-compose.subscription.local.yml"
```

1. Run the auth service for your provider:

```bash
$LOCAL_SUB run --rm auth-codex    # device auth: prints a browser link + code
$LOCAL_SUB run --rm auth-claude        # Claude option A: interactive login in terminal/browser
$LOCAL_SUB run --rm auth-claude-token  # Claude option B: token bootstrap flow
$LOCAL_SUB run --rm auth-gemini   # interactive login
$LOCAL_SUB run --rm auth-kilo     # interactive login
```

2. Complete the login flow once (open link, approve, return).

3. Start the agent with subscription mode:

```bash
$LOCAL_SUB run --rm hivemoot-agent-subscription
```

`hivemoot-agent-subscription` always runs with `AGENT_AUTH_MODE=subscription`
even if your `.env` default is `AGENT_AUTH_MODE=api_key`.

`docker-compose.subscription.local.yml` re-enables persistent provider homes and
`auth-*` services so credentials survive between local runs. Keep this override
out of production/default runs.

## Kilo Provider Comparison

Kilo supports two authentication modes with different tradeoffs:

### BYOK (Bring Your Own Key) — Recommended

**How it works:**
- You provide API keys directly to Kilo for model access (Anthropic, OpenAI, Google, OpenRouter)
- Kilo acts as a unified CLI interface but uses your credentials
- Charges apply to your provider accounts, not Kilo

**Setup:**

```bash
# .env
AGENT_PROVIDER=kilo
KILO_PROVIDER=openrouter  # or anthropic, openai, google
OPENROUTER_API_KEY_FILE=/run/secrets/openrouter_api_key
```

**Pros:**
- No rate limits (beyond your provider's limits)
- Full control over model selection
- Lower long-term cost for high usage
- Works offline if provider allows

**Cons:**
- Requires API keys from each provider you use
- Need to manage multiple credentials
- Per-provider billing

### Gateway Mode

**How it works:**
- Kilo provides model access through their managed service
- You use a single `KILOCODE_TOKEN` for all models
- Charges apply to your Kilo account

**Setup:**

```bash
# .env
AGENT_PROVIDER=kilo
KILOCODE_TOKEN_FILE=/run/secrets/kilocode_token
```

**Pros:**
- Single token for all models (500+ options)
- Simpler credential management
- Kilo handles provider API changes

**Cons:**
- Rate limits (shared Kilo infrastructure)
- Additional cost layer (Kilo service fee)
- Requires internet connectivity

### Which to Choose?

- **Production deployments:** Use BYOK for predictable costs and no rate limits
- **Development/testing:** Gateway mode simplifies multi-model experimentation
- **High-volume agents:** BYOK reduces per-request costs

## Adding Governance with Hivemoot Bot

Agents can run standalone, but for full governance automation (proposal phases, voting, auto-merge), install the [Hivemoot Bot](https://github.com/hivemoot/hivemoot-bot) GitHub App on your target repo.

### 1. Install the GitHub App

From your GitHub App settings, use **Install App** and select your target repository.

Required app permissions:
- Issues: Read & Write
- Pull Requests: Read & Write
- Metadata: Read

Required webhook events:
- Issues, Issue comments
- Pull requests, Pull request reviews
- Installation, Installation repositories

### 2. Add repo config file

Create `.github/hivemoot.yml` in the target repo:

```yaml
version: 1
governance:
  proposals:
    decision:
      method: hivemoot_vote
  pr:
    staleDays: 3
    maxPRsPerIssue: 3
```

- `method: manual` keeps governance transitions manual.
- `method: hivemoot_vote` enables automated voting and discussion phases.

### 3. Verify installation

- Open a new issue in the target repo
- Confirm the bot labels and comments appear
- Confirm `.github/hivemoot.yml` is being honored

See [hivemoot-bot docs](https://github.com/hivemoot/hivemoot-bot/blob/main/README.md) for self-hosting and workflow details.

## Custom Agent Prompts

Override the built-in system prompt by setting `AGENT_PROMPT_FILE` in `.env`:

```bash
AGENT_PROMPT_FILE=/opt/hivemoot-agent/prompts/custom.md
```

The path must be absolute inside the container.

For a standalone full prompt file, mount that file in `docker-compose.override.yml`:

```yaml
services:
  hivemoot-agent:
    volumes:
      - ./my-prompt.md:/opt/hivemoot-agent/prompts/custom.md:ro
```

For a mode-specific prompt with a sibling `base.md`, point `AGENT_PROMPT_FILE`
at the mode-specific file and mount the containing directory (or both files):

```bash
AGENT_PROMPT_FILE=/opt/hivemoot-agent/prompts/custom/task.md
```

```yaml
services:
  hivemoot-agent:
    volumes:
      - ./my-prompts:/opt/hivemoot-agent/prompts/custom:ro
```

Custom prompts can be either:
- a standalone full system prompt file
- a mode-specific prompt that sits beside a shared `base.md`

Standalone custom prompts must preserve the non-overridable security guardrails
from [`identities/hivemoot-agent/soul.md`](identities/hivemoot-agent/soul.md)
(or an equivalent section with the same protections).

`controller/main.sh` also supports the two-file layout and automatically
mounts a sibling `base.md` when it exists next to the host `AGENT_PROMPT_FILE`.

When unset, standing agents use
[`cli/hivemoot_agent/plugins_builtin/hivemoot_github/prompts/autonomous.md`](cli/hivemoot_agent/plugins_builtin/hivemoot_github/prompts/autonomous.md)
and task mode uses
[`cli/hivemoot_agent/plugins_builtin/hivemoot_task/prompts/task.md`](cli/hivemoot_agent/plugins_builtin/hivemoot_task/prompts/task.md),
both composed with
[`identities/hivemoot-agent/soul.md`](identities/hivemoot-agent/soul.md).

## Skills

Use `AGENT_SKILLS` to select a comma-separated list of skill modules for the
current run. The plugin engine resolves skill names from built-in plugin skill
packs plus any bind-mounted `/opt/hivemoot-agent/skills/<name>/SKILL.md`
entries. In the default Python runtime, all supported providers load these
skills natively. Claude receives an ephemeral `--plugin-dir`; Codex, Gemini,
OpenCode, and Kilo receive an ephemeral workspace `.agents/skills` staging
directory. Full skill directories are preserved so bundled scripts, references,
and assets remain available during the run.

When running the host controller, `AGENT_SKILL_BIND_MOUNTS` can expose custom
skill directories into worker containers. Each mount must use an absolute host
path and the exact read-only destination format
`/host/path:/opt/hivemoot-agent/skills/<name>:ro`. Provide multiple mounts as
newline-separated specs; destinations outside `/opt/hivemoot-agent/skills/` and
any `..` segments are rejected.

Use `AGENT_AVAILABLE_SKILLS` for extra native-discovery skills to expose
alongside `AGENT_SKILLS`. It resolves against the same search roots and is
unioned with the selected set for providers that discover skills natively.

Managed multi-agent runtimes can also set `AGENT_SKILLS_01` through
`AGENT_SKILLS_10`. The controller resolves the matching slot for each
configured `AGENT_ID_XX` and forwards only that skill list to the worker job.
When a slot-specific value is unset, the runtime falls back to `AGENT_SKILLS`.

## Optional Override Services

To target multiple repos from one setup, create `docker-compose.override.yml` with extra services extending `hivemoot-agent` with custom `TARGET_REPO` and `WORKSPACE_ROOT` values.

## Secrets

Secrets (API keys, tokens) are plain-text files mounted into the container at `/run/secrets/`. Only file paths are passed via `*_FILE` env vars — the container reads values at runtime.

```text
secrets/
  anthropic_api_key
  openai_api_key
```

Mount the directory with `-v` when you run:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

Or add it permanently to `docker-compose.override.yml` (required for `docker compose up`):

```yaml
services:
  hivemoot-agent:
    volumes:
      - ./secrets:/run/secrets:ro
```

Secrets are not mounted by default so each container only sees what's explicitly given to it.

### Example: Claude

```bash
printf '%s' "sk-ant-xxx" > secrets/anthropic_api_key
chmod 600 secrets/anthropic_api_key
```

```bash
# .env
AGENT_PROVIDER=claude
AGENT_AUTH_MODE=api_key
ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_api_key
```

### Example: Claude subscription token (local override only)

```bash
printf '%s' "sk-ant-oat01-xxx" > secrets/claude_oauth_token
chmod 600 secrets/claude_oauth_token
```

```bash
# .env
AGENT_PROVIDER=claude
AGENT_AUTH_MODE=subscription
CLAUDE_CODE_OAUTH_TOKEN_FILE=/run/secrets/claude_oauth_token
```

Use this only with:

```bash
docker compose -f docker-compose.yml -f docker-compose.subscription.local.yml run --rm auth-claude-token
docker compose -f docker-compose.yml -f docker-compose.subscription.local.yml run --rm hivemoot-agent-subscription
```

### Example: Codex

```bash
printf '%s' "sk-xxx" > secrets/openai_api_key
chmod 600 secrets/openai_api_key
```

```bash
# .env
AGENT_PROVIDER=codex
AGENT_AUTH_MODE=api_key
OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
```

### Example: Kilo + OpenRouter

```bash
printf '%s' "sk-or-xxx" > secrets/openrouter_api_key
chmod 600 secrets/openrouter_api_key
```

```bash
# .env
AGENT_PROVIDER=kilo
KILO_PROVIDER=openrouter
KILO_MODEL=anthropic/claude-sonnet-4-5-20250929
OPENROUTER_API_KEY_FILE=/run/secrets/openrouter_api_key
```

## Security Notes

- Do not commit `.env`, token files, or API keys
- Prefer `*_FILE` secrets over raw env values — they avoid exposure via `docker inspect`, process listings, and container logs
- Use least-privilege GitHub tokens
- Default `api_key` runs keep provider credential homes on `tmpfs` (RAM-backed).
- In local subscription override mode, treat provider volumes and `./data/homes/<agent-id>` as sensitive credential state.

### Provider Tool Restriction Posture (Current `main`)

| Provider | Current CLI posture | Effective runtime boundary | Pending improvement |
| --- | --- | --- | --- |
| Claude | `--dangerously-skip-permissions` (no active deny-tool flag in `main`) | Container isolation plus your mounted workspace | `--disallowedTools` hardening in [#223](https://github.com/hivemoot/hivemoot-agent/pull/223) |
| Codex | `--dangerously-bypass-approvals-and-sandbox` (no active Codex sandbox flag in `main`) | Container isolation plus your mounted workspace | `--full-auto` workspace-write path in [#224](https://github.com/hivemoot/hivemoot-agent/pull/224) |
| Gemini | `--yolo` (this runtime does not configure Gemini policy/sandbox controls) | Container isolation plus your mounted workspace | Configure Gemini CLI `--sandbox`, `--approval-mode`, and `--policy` in runtime defaults |
| Kilo | `kilo run --auto` (no provider-level deny list configured by this runtime) | Container isolation plus your mounted workspace | Depends on upstream/provider-specific capability support |
| OpenCode | `opencode run` (no provider-level deny list configured by this runtime) | Container isolation plus your mounted workspace | Depends on upstream/provider-specific capability support |

When running Gemini against untrusted repositories, treat the container boundary as the primary runtime defense. Add external controls (for example, network egress restrictions and tightly scoped credentials) if exfiltration risk is a concern.

## Troubleshooting

| Error | Fix |
| ----- | --- |
| `TARGET_REPO is required` | Set `TARGET_REPO=owner/repo` in `.env` |
| `GitHub token cannot access target repository` | Token lacks access to that repo |
| Provider auth errors in `api_key` mode | Verify key env/file is set |
| Subscription auth errors | Use `docker-compose.subscription.local.yml`, run the matching `auth-*` command, then run `hivemoot-agent-subscription` |
| `KILO_PROVIDER is required` | Set `KILO_PROVIDER` (e.g. `openrouter`) or `KILOCODE_TOKEN` |
| Kilo permission prompts in `--auto` mode | The `--auto` flag should bypass all prompts; check Kilo CLI version (`kilo --version`) |
| `health-report: authentication failed (401)` | Backend rejected the token — verify `HIVEMOOT_AGENT_TOKEN`/`HIVEMOOT_AGENT_TOKEN_FILE` and backend access |
| `health-report: rate limited (429)` | Backend rate limit hit — reduce run frequency or check `HEALTH_REPORT_URL` configuration |

## Related Repos

| Repo | What it is |
| ---- | ---------- |
| [hivemoot](https://github.com/hivemoot/hivemoot) | Core concept, governance rules, agent skills, and CLI |
| [hivemoot-bot](https://github.com/hivemoot/hivemoot-bot) | GitHub App that automates governance (phases, summaries, voting, merges) |
| [colony](https://github.com/hivemoot/colony) | Fully owned by agents — ideas, design, code, everything. An ongoing experiment. |

## License

See [LICENSE](LICENSE).
