# AGENTS.md

This file gives provider-agnostic startup context for autonomous agents
working in `apiarist/` — a host-side daemon that brokers GitHub
installation tokens for the apiary fleet (V1) and will spawn agents
dynamically from backend configuration (V2+).

## Repository Purpose

`apiarist` is a **long-running Python daemon** that runs on each Hive
(the host that runs the apiary fleet of agent containers). It mediates
between local agent containers and the centralized hivemoot.dev backend.

V1 scope is GitHub installation token brokering: instead of mounting
long-lived classic PATs into containers, agents get short-lived
(≤ 1 hour), narrowly-scoped tokens minted on demand by the backend
(which holds the Hivemoot Bot App `.pem`). V2+ adds dynamic agent
spawning from dashboard configuration. See [`DESIGN.md`](./DESIGN.md)
for the full architecture, threat model, IPC protocol, and phase plan.

## Startup Context Files

Read these before deeper exploration:

1. [`DESIGN.md`](./DESIGN.md) — architectural source of truth (§§1, 3,
   6, 7, 10, 11, 14 are essential; whole doc is ~720 lines)
2. [`README.md`](./README.md) — operator-facing quick start
3. This file (`AGENTS.md`) — agent / contributor onboarding

After those, the cross-repo integration points live in the apiary repo:
`apiary/deploy-apiary.sh` (token-staging branch, Phase K) and
`apiary/run-hivemoot-docker.sh` (controller pre-job mint, Phase L).

## Build & Verify

```bash
# From the apiarist/ directory (monorepo path: hivemoot/hivemoot/apiarist/)
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

# Verify the scaffold
apiarist --version          # → "apiarist 0.1.0"
apiarist --help             # → usage with description
apiarist                    # → friendly stderr + exit 0

# Run the test / lint / type stack
pytest -v                   # unit tests (smoke only at Phase A; G+H grow this)
ruff check src tests        # style + simplification rules
mypy src                    # strict mode; configured in pyproject.toml
```

All three checks must pass on every PR. CI is enforced on every push via `.github/workflows/apiarist-ci.yml` (landed in Phase B+).

## Layout & Conventions

```
apiarist/
├── AGENTS.md              ← this file
├── DESIGN.md              ← architectural source of truth
├── README.md              ← operator-facing quickstart
├── LICENSE                ← Apache-2.0 (matches repo root)
├── pyproject.toml         ← package metadata, deps, tool config
├── .gitignore             ← Python defaults
├── src/apiarist/          ← package code (grows phase by phase)
│   ├── __init__.py
│   ├── __main__.py        ← CLI entry: `python -m apiarist`, console script `apiarist`
│   └── version.py         ← __version__ string (single source of truth)
└── tests/
    ├── unit/              ← pytest unit tests (Phase G)
    └── integration/       ← pytest e2e w/ fake backend + real socket (Phase H)
```

**Layout choice — `src/` vs flat.** apiarist uses a modern PEP 621
`src/` layout with `pyproject.toml` and `hatchling` build backend.
This **diverges from `agent/cli/`** (which uses a `sys.path`-prepended
wrapper script and is not pip-installed). The reason: apiarist is
deployed as a **systemd service** on Linux Hives — it needs to be
properly installed into a venv via `pip install` so the `apiarist`
console script lands on `PATH` and the service unit can invoke it.
The `agent/cli/` pattern works because that code only runs inside a
Docker container with the source bind-mounted; apiarist runs on the
bare host. Same monorepo, different deploy targets, different
packaging needs. Don't try to harmonize them.

**Tooling pins (in `pyproject.toml`).**

- Python: `>=3.11` (matches Ubuntu 24.04 default on Hive)
- Lint: `ruff>=0.6` with rule sets `E, F, I, N, UP, B, SIM, RUF`
- Types: `mypy>=1.10` in strict mode
- Tests: `pytest>=8.0` + `pytest-asyncio>=0.23` (asyncio_mode = "auto")
- Build: `hatchling` (single-source `__version__` from `src/apiarist/version.py`)

Runtime dependencies are intentionally added per phase rather than
front-loaded — see `pyproject.toml` for the comment block listing what
each phase will add.

## Phase Plan

`apiarist` ships across ~15 small PRs, one per phase, each independently
reviewable. See `DESIGN.md` §14 for the full ordered list. The current
phase is recorded in `IMPLEMENTATION.md` (created when the build session
starts) — read it first to know where we are.

Each phase PR should be **scoped to a single coherent change** and
include local verification steps (the `pytest`/`ruff`/`mypy` trio plus
any phase-specific manual exercise).

## Cross-Repo Touch Points

apiarist itself ships in this monorepo, but two later phases edit
files in two other places as separate small PRs:

- **Phase K** — `apiary/deploy-apiary.sh` (in `hivemoot/apiary`):
  branch on a new `auth:` field in `apiary.yaml` repo blocks. When
  `auth: github-app`, skip writing the static `github-token`,
  bind-mount `/run/apiarist.sock` into the agent container, and set
  the `AGENT_SERVICE` + `AGENT_TOKEN_SLOT` env vars so the agent
  runtime knows its identity and apiarist knows which agent-token to
  use. No file write of any GitHub token at any point.
- **Phase L′** — `agent/cli/hivemoot_agent/plugins_builtin/.../github`
  (in this monorepo): when `AGENT_SERVICE` is set, replace the static
  `GH_TOKEN` read with a UDS round-trip to `/run/apiarist.sock` that
  mints a fresh token on demand. Token is held in agent process
  memory only for the duration of the immediate API call(s); no
  caching at the agent layer (apiarist's cache is the right place).

The agent runtime IS modified in Phase L′ — see `DESIGN.md` §12.3 for
the rationale: long-running agent containers (`hivemoot-agent run`
daemon mode) with internal trigger schedules can't be mediated by a
host-side controller, so the agent itself must request tokens. Phases
A-O (in this directory) do not modify the runtime.

## Backend Dependency

V1 requires one new endpoint on hivemoot.dev:
`POST /api/github/installation-tokens` (see `DESIGN.md` §11). The route
shipped in Phase C as a 501 stub with real auth + body
validation, paired with the apiarist client. The actual GitHub App
handoff (sign JWT with `.pem`, exchange at api.github.com, return
`ghs_`) is a follow-up PR — Phase N (foxstoria pilot) is what
actually requires the real minting to be live.

## Anti-Goals

`DESIGN.md` §17 lists what apiarist is explicitly NOT. Read it before
proposing scope expansion. Briefly: not a generic IPC framework, not a
service mesh, not a config server, does not run agent jobs or wrap the
agent runtime, does not implement its own GitHub App auth (that lives
server-side at hivemoot.dev). Each anti-goal is load-bearing for
keeping V1 honest.

## Governance & PR Conventions

Follow the monorepo conventions in the root `AGENTS.md` and
`CONTRIBUTING.md`:

- Fork-first publishing (or push directly to upstream if you're the
  owner — see how recent PRs are structured).
- PR descriptions follow `.github/PULL_REQUEST_TEMPLATE.md`. Include a
  "What it looks like" section with terminal output for CLI changes.
- Issue linking via `Fixes #N` follows the root governance contract
  (`AGENTS.md`, `CONTRIBUTING.md`, `docs/architecture/HOW-IT-WORKS.md`).
  No apiarist-local exception exists; if the contract evolves to admit
  infra/maintenance carve-outs, that change belongs in the root docs
  and Queen's preflight, not here.
- Reviews come from the listen-only fleet on the monorepo:
  `hivemoot-guard` (security), `hivemoot-builder` (implementation),
  `hivemoot-drone` (consistency / architecture). After addressing
  feedback, post a follow-up PR comment **tagging each reviewer** so
  they re-review.
