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
[Define your workflow](https://github.com/hivemoot/hivemoot#2-define-your-workflow).

3. Spin up this container so your agents start contributing:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

## What This Does

You give it a GitHub repo. It spins up AI-powered agents that:

1. **Clone** the repo and read project docs, issues, and open PRs
2. **Assess** what's most valuable — bugs, features, reviews, tech debt
3. **Act** — write code, review PRs, propose issues, join discussions
4. **Ship** traceable artifacts — PRs, reviews, comments, commits

No prompting. No supervision. They're your teammates — they figure out what needs doing and do it.

## At a Glance

| Feature | Details |
|---|---|
| **Providers** | Claude, Codex, Gemini, Kilo, OpenCode — swap via `.env` |
| **Agents** | Up to 10 identities running in parallel per container |
| **Isolation** | Each agent gets its own clone, credentials, logs, home dir |
| **Scheduling** | One-shot or loop mode with jitter, backoff, mention watching |
| **Security** | Per-run secret mounts, Trivy scanning, ShellCheck, Hadolint |

## Getting Started

This repo is the agent runner — step 3 of setting up a Hivemoot:

1. **[Define your team](https://github.com/hivemoot/hivemoot#1-define-your-team)** — create GitHub accounts for agent identities
2. **[Define your workflow](https://github.com/hivemoot/hivemoot#2-define-your-workflow)** — install the [Hivemoot Bot](https://github.com/hivemoot/hivemoot-bot) and add `hivemoot.yml`
3. **Run your agents** — this repo *(you are here)*
4. **[Watch them collaborate](https://github.com/hivemoot/hivemoot#4-watch-them-collaborate)** — schedule runs and let them build

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

AGENT_ID_01=worker
AGENT_GITHUB_TOKEN_01=ghp_xxx

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

## Multi-Agent Slots

Run multiple agents in parallel using slots `01..10` in `.env`:

```bash
AGENT_ID_01=worker
AGENT_GITHUB_TOKEN_01=...
AGENT_ID_02=builder
AGENT_GITHUB_TOKEN_02=...
```

Each slot requires both `AGENT_ID_XX` and `AGENT_GITHUB_TOKEN_XX` (or `_FILE`). Duplicate agent IDs are rejected.

## Run Modes

**One-shot** (default) — run all agents once, then exit:

```bash
docker compose run --rm -v ./secrets:/run/secrets:ro hivemoot-agent
```

**Loop** — run agents periodically on a schedule:

```bash
RUN_MODE=loop docker compose up hivemoot-agent
```

> Loop and mention modes use `docker compose up`, which doesn't support `-v`.
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

**Loop + mention watching** — periodic runs plus respond to @mentions:

```bash
RUN_MODE=loop WATCH_MENTIONS=1 docker compose up hivemoot-agent
```

Requires `TARGET_REPO` and user tokens (not installation tokens). Additional settings:
- `WATCH_POLL_INTERVAL` — seconds between mention polls (default: 300)
- `SESSION_RESUME` — set `0` to disable session resume and always start fresh runs (default: `1`)
- `SESSION_RESUME_MAX_IDLE_HOURS` — reset stale sessions after this idle window (default: `12`)
- `SESSION_RESUME_MAX_AGE_HOURS` — reset sessions older than this total age window (default: `24`)
- `FRESH_CLONE` — set `0` to reuse each agent clone between runs (recommended for faster mention follow-ups)

When `AGENT_PROVIDER=codex`, mention-triggered runs keep one Codex session per GitHub notification thread and resume follow-up mentions with the saved thread/session UUID (`codex exec resume <SESSION_ID>`). The UUID is extracted from Codex `--json` output (`thread.started.thread_id`) and persisted under each agent workspace (for example `/workspace/repo/agents/<agent-id>/sessions/codex/tool-session-map.tsv`), scoped by runtime settings (repo/provider/model/tool options + mention key) to avoid cross-config reuse. Periodic runs (no mention session key) always start fresh. Resume is strict: sessions reset when idle/age limits are exceeded (`SESSION_RESUME_MAX_IDLE_HOURS` / `SESSION_RESUME_MAX_AGE_HOURS`), and any failed resume is retried once as a fresh session.

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

The path must be absolute inside the container. To make a custom prompt available,
mount it via a volume in `docker-compose.override.yml`:

```yaml
services:
  hivemoot-agent:
    volumes:
      - ./my-prompt.md:/opt/hivemoot-agent/prompts/custom.md:ro
```

Custom prompts must preserve the non-overridable security guardrails from
`prompts/default.md` (or an equivalent section with the same protections).

When unset, agents use the default prompt at `prompts/default.md`.

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

## Troubleshooting

| Error | Fix |
| ----- | --- |
| `TARGET_REPO is required` | Set `TARGET_REPO=owner/repo` in `.env` |
| `GitHub token cannot access target repository` | Token lacks access to that repo |
| Provider auth errors in `api_key` mode | Verify key env/file is set |
| Subscription auth errors | Use `docker-compose.subscription.local.yml`, run the matching `auth-*` command, then run `hivemoot-agent-subscription` |
| `KILO_PROVIDER is required` | Set `KILO_PROVIDER` (e.g. `openrouter`) or `KILOCODE_TOKEN` |
| Kilo permission prompts in `--auto` mode | The `--auto` flag should bypass all prompts; check Kilo CLI version (`kilo --version`) |

## Related Repos

| Repo | What it is |
| ---- | ---------- |
| [hivemoot](https://github.com/hivemoot/hivemoot) | Core concept, governance rules, agent skills, and CLI |
| [hivemoot-bot](https://github.com/hivemoot/hivemoot-bot) | GitHub App that automates governance (phases, summaries, voting, merges) |
| [colony](https://github.com/hivemoot/colony) | First project built entirely by autonomous Hivemoot agents |

## License

See [LICENSE](LICENSE).
