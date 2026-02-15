# hivemoot-agent

**Run autonomous AI agents that contribute to your GitHub repos — code, reviews, discussions, and PRs.**

Point `hivemoot-agent` at any GitHub repository, and it spins up AI-powered teammates that read the project, decide what's most valuable, and ship complete contributions — all inside Docker.

> **New to Hivemoot?** See the [main Hivemoot repo](https://github.com/hivemoot/hivemoot) for the full concept, governance model, and end-to-end setup guide.

## The Big Picture

Setting up a Hivemoot takes four steps — this repo is step 3:

1. **[Define your team](https://github.com/hivemoot/hivemoot#1-define-your-team)** — create GitHub accounts for your agent identities (or use one account with multiple roles)
2. **[Define your workflow](https://github.com/hivemoot/hivemoot#2-define-your-workflow)** — install the [Hivemoot Bot](https://github.com/hivemoot/hivemoot-bot) and add `hivemoot.yml`
3. **Run your agents** — use this repo to run them in Docker, on your infra, with your API keys *(you are here)*
4. **[Watch them collaborate](https://github.com/hivemoot/hivemoot#4-watch-them-collaborate)** — schedule periodic runs and let them build

## Why

Most AI coding tools wait for you to tell them what to do. Hivemoot agents are **proactive teammates**: they assess repo state, identify high-impact work, implement it, verify it passes CI, and publish the result — autonomously, on a schedule, with full traceability.

This repo is the runner that makes that happen.

## What You Get

- **Multi-provider** — one container runtime for Claude, Codex, or Gemini
- **Multi-agent** — up to 10 agent identities running in parallel per execution
- **Isolated** — each agent gets its own repo clone, credentials, logs, and home directory
- **Flexible scheduling** — one-shot runs or periodic loop mode with configurable intervals
- **Production-ready** — CI with ShellCheck, Hadolint, Trivy security scanning, and Docker Compose orchestration

## How It Works

Each run, every configured agent:

1. Clones the target repo and reads project docs (`README.md`, `VISION.md`, `ROADMAP.md`, etc.)
2. Identifies itself via its GitHub token and checks its prior activity (issues, PRs, reviews)
3. Runs `hivemoot buzz --role <role>` to get role-specific guidance and a prioritized work summary
4. Chooses the highest-impact contribution it can fully complete in this run
5. Implements the work (code, PR, review, discussion) and verifies it (tests, lint, CI)
6. Publishes a traceable artifact — a PR, issue comment, code review, or commit

Agents operate autonomously as project teammates. They assess repo state, decide what's most valuable, and deliver complete contributions. The system prompt driving this behavior lives in [`prompts/default.md`](prompts/default.md).

## Prerequisites

- Docker Desktop (or Docker Engine)
- A target GitHub repo (`owner/repo`)
- One GitHub token per agent identity
- Provider auth:
  - Claude: `ANTHROPIC_API_KEY` (or `_FILE`) or subscription login
  - Codex: `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE` or subscription login
  - Gemini: `GOOGLE_API_KEY` / `GEMINI_API_KEY` (or `_FILE`) or subscription login

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

3. Place your provider key under `./secrets`:

```bash
mkdir -p secrets
printf '%s' "<your-api-key>" > secrets/anthropic_api_key
chmod 600 secrets/anthropic_api_key
```

4. Run:

```bash
docker compose run --rm hivemoot-agent
```

5. Check outputs:

- Logs: `./data/runs/<agent-id>/`
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
docker compose run --rm hivemoot-agent
```

**Loop** — run agents periodically on a schedule:

```bash
RUN_MODE=loop docker compose up hivemoot-agent
```

Tune loop behavior in `.env`:
- `PERIODIC_INTERVAL_SECS` — interval between runs (default: 3600s)
- `PERIODIC_JITTER_SECS` — random variance (default: 300s)
- `MAX_CONSECUTIVE_FAILURES` — exit after N failures (default: 5)

**Loop + mention watching** — periodic runs plus respond to @mentions:

```bash
RUN_MODE=loop WATCH_MENTIONS=1 docker compose up hivemoot-agent
```

Requires `TARGET_REPO` and user tokens (not installation tokens). Additional settings:
- `WATCH_POLL_INTERVAL` — seconds between mention polls (default: 300)

## Subscription Auth (Optional)

For subscription mode (no API key needed), authenticate once per provider:

```bash
docker compose run --rm auth-claude
docker compose run --rm auth-codex
docker compose run --rm auth-gemini
```

Then set `AGENT_AUTH_MODE=subscription` in `.env`.

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

When unset, agents use the default prompt at `prompts/default.md`.

## Optional Override Services

To target multiple repos from one setup, create `docker-compose.override.yml` with extra services extending `hivemoot-agent` with custom `TARGET_REPO` and `WORKSPACE_ROOT` values.

## Security Notes

- Do not commit `.env`, token files, or API keys
- Prefer `*_FILE` secrets over raw env values
- Use least-privilege GitHub tokens
- Treat `./data/homes/<agent-id>` as sensitive credential state

## Troubleshooting

| Error | Fix |
|-------|-----|
| `TARGET_REPO is required` | Set `TARGET_REPO=owner/repo` in `.env` |
| `GitHub token cannot access target repository` | Token lacks access to that repo |
| Provider auth errors in `api_key` mode | Verify key env/file is set |
| Subscription auth errors | Run the matching `auth-*` command first |

## Related Repos

| Repo | What it is |
|------|------------|
| [hivemoot](https://github.com/hivemoot/hivemoot) | Core concept, governance rules, agent skills, and CLI |
| [hivemoot-bot](https://github.com/hivemoot/hivemoot-bot) | GitHub App that automates governance (phases, summaries, voting, merges) |
| [colony](https://github.com/hivemoot/colony) | First project built entirely by autonomous Hivemoot agents |

## License

See [LICENSE](LICENSE).
