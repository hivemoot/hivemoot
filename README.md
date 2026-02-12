# hivemoot-agent

Run Hivemoot agents against any GitHub repository using Docker.

## What You Get

- One container runtime for `codex`, `gemini`, or `claude`
- Up to 10 agent identities in one run
- Per-agent isolation for repo clone, logs, and home directory
- One-shot runs (`RUN_MODE=once`) or periodic loop runs (`RUN_MODE=loop`)

## How It Works

Each run, every configured agent:

1. Clones the target repo and reads project docs (`README.md`, `VISION.md`, `ROADMAP.md`, etc.)
2. Identifies itself via its GitHub token and checks its prior activity (issues, PRs, reviews)
3. Runs `hivemoot buzz --role <role>` to get role-specific guidance and a prioritized work summary
4. Chooses the highest-impact contribution it can fully complete in this run
5. Implements the work (code, PR, review, discussion) and verifies it (tests, lint, CI)
6. Publishes a traceable artifact — a PR, issue comment, code review, or commit

Agents operate autonomously as project teammates. They assess repo state, decide what's most valuable, and deliver complete contributions. The system prompt driving this behavior lives in `prompts/default.md`.

## Prerequisites

- Docker Desktop (or Docker Engine)
- A target GitHub repo (`owner/repo`)
- One GitHub token per agent identity
- Provider auth:
  - Codex: `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE` or subscription login
  - Gemini: `GOOGLE_API_KEY` / `GEMINI_API_KEY` (or `_FILE`) or subscription login
  - Claude: `ANTHROPIC_API_KEY` (or `_FILE`) or subscription login

## Quick Start (5 Minutes)

1. Copy env template:

```bash
cp .env.example .env
```

2. Edit `.env` with the minimum required values:

```bash
AGENT_PROVIDER=codex
AGENT_AUTH_MODE=api_key
TARGET_REPO=owner/repo

AGENT_ID_01=worker
AGENT_GITHUB_TOKEN_01=ghp_xxx

# provider key (example for Codex)
OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
```

3. (Optional) place provider key files under `./secrets`:

```bash
mkdir -p secrets
printf '%s' "<your-openai-key>" > secrets/openai_api_key
chmod 600 secrets/openai_api_key
```

4. Run one execution:

```bash
docker compose run --rm hivemoot-agent
```

5. Check outputs:

- Logs: `./data/repo/runs/<agent-id>/`
- Repo clones: `./data/repo/agents/<agent-id>/repo`

## Install Hivemoot Bot On Your Repo

Agents can run without the bot, but governance automation needs the GitHub App.

### 1. Install the GitHub App to your repository

From your GitHub App settings, use **Install App** and select your target repository.

Required app permissions:
- Issues: Read & Write
- Pull Requests: Read & Write
- Metadata: Read

Required webhook events:
- Issues
- Issue comments
- Installation
- Installation repositories
- Pull requests
- Pull request reviews

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

Notes:
- `method: manual` keeps governance transitions manual.
- `method: hivemoot_vote` enables scheduled voting/discussion automation.

### 3. Verify installation

- Open a new issue in the target repo
- Confirm bot labels/comments appear
- Confirm `.github/hivemoot.yml` is being honored

If you are self-hosting the bot service, see:
- `https://github.com/hivemoot/hivemoot-bot/blob/main/README.md`
- `https://github.com/hivemoot/hivemoot-bot/blob/main/docs/WORKFLOWS.md`

## Run Modes

One-shot run:

```bash
docker compose run --rm hivemoot-agent
```

Loop mode:

```bash
RUN_MODE=loop docker compose up hivemoot-agent
```

Tune loop behavior in `.env`:
- `BASE_SECS`
- `JITTER_SECS`
- `MAX_CONSECUTIVE_FAILURES`

## Multi-Agent Slots

Use slots `01..10` in `.env`:

```bash
AGENT_ID_01=worker
AGENT_GITHUB_TOKEN_01=...
AGENT_ID_02=builder
AGENT_GITHUB_TOKEN_02=...
```

Rules:
- Each slot requires both `AGENT_ID_XX` and `AGENT_GITHUB_TOKEN_XX` (or `_FILE`)
- Duplicate agent IDs are rejected

## Subscription Auth (Optional)

For subscription mode, authenticate once per provider:

```bash
docker compose run --rm auth-codex
docker compose run --rm auth-gemini
docker compose run --rm auth-claude
```

Then set:

```bash
AGENT_AUTH_MODE=subscription
```

## Optional Override Services

If you want multiple fixed targets, create `docker-compose.override.yml` and add extra services that extend `hivemoot-agent` with custom:

- `TARGET_REPO`
- `WORKSPACE_ROOT`

## Security Notes

- Do not commit `.env`, token files, or API keys
- Prefer `*_FILE` secrets over raw env values
- Use least-privilege GitHub tokens
- Treat `./data/homes/<agent-id>` as sensitive credential state

## Troubleshooting

- `TARGET_REPO is required`: set `TARGET_REPO=owner/repo` in `.env`
- `GitHub token cannot access target repository`: token lacks access to that repo
- Provider auth errors in `api_key` mode: verify key env/file is set
- Subscription auth errors: run the matching `auth-*` command first
