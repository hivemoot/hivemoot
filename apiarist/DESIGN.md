# apiarist — host-side daemon for the Hivemoot fleet

> **Status:** Design — not yet implemented. V1 scope: GitHub installation
> token brokering. V2+ scope: dynamic agent spawning, additional fleet
> management responsibilities.

## 1. Why this exists

Hivemoot is a **federated multi-Hive runtime**: many operators run their own
Hives on their own hardware, all coordinated by the centralized backend at
hivemoot.dev. Two facts follow from this:

1. **The Hivemoot Bot GitHub App's private key cannot live on operator
   hardware.** It is the master credential for the entire App across every
   installation by every operator. It must stay in the centralized backend
   (Vercel env), where only the App owner controls it.
2. **Hives still need to talk to GitHub.** Reviewer agents need GitHub
   tokens to read PRs, post reviews, respond to mentions. Today this is
   solved with long-lived classic PATs in `apiary.secrets.yaml`. That model
   is operationally viable but security-suboptimal: any compromised
   container exfiltrates a credential that lives forever and grants broad
   access.

Apiarist solves the second by mediating between the Hive's containers and
the centralized backend, which holds the App key. It also becomes the
natural home for other host-side responsibilities that benefit from
*talking to the backend* and *acting locally* — most notably, dynamic
agent spawning driven by dashboard configuration.

## 2. Naming

**Daemon name:** `apiarist` — formal English for "beekeeper." Distinctive
across the existing Hivemoot namespace (`apiary`, `bot`, `agent`, `colony`,
`hivemoot`). Single word; clean as a systemd unit, Python package, socket
filename, and unprivileged user account.

| Concept | Name |
|---|---|
| Daemon binary | `apiarist` |
| Python package | `apiarist` |
| Systemd unit | `apiarist.service` |
| User account | `apiarist` |
| Group | `apiarist` |
| IPC socket (host path) | `/run/apiarist/apiarist.sock` |
| IPC socket (container path, post bind-mount) | `/run/apiarist.sock` |
| Config dir | `/etc/apiarist/` (optional, see §6) |
| State dir | `/var/lib/apiarist/` |
| Log destination | systemd journald (`journalctl -u apiarist`) |

## 3. Architectural analog

Apiarist is structurally analogous to:

- **HashiCorp Vault Agent** — runs on application hosts, holds a
  low-privilege auth method to Vault server, fetches dynamic secrets,
  exposes them to apps via templated files or local API. Apps don't talk to
  Vault directly.
- **Kubelet** — runs on each worker node, holds a node identity, polls
  control plane for desired state, manages local containers to match.

Apiarist is smaller and narrower than either, but inherits the pattern:
**one trusted host process, with a delegated credential to the central
authority, that does local work on the authority's behalf.**

## 4. Long-term vision

Apiarist will accumulate features over time. Anticipated:

| Feature | Phase | Description |
|---|---|---|
| GitHub token brokering | **V1** | Mint short-lived installation tokens via backend; expose to local agent containers. |
| Dynamic agent spawning | V2 | Pull desired-fleet config from backend; reconcile local agent set (start/stop docker containers, write/remove systemd units). |
| Backend-driven config sync | V3 | Push local fleet metadata up to backend (running services, last-seen, errors); pull config changes down. |
| Telemetry forwarding | V3 | Local metrics/logs aggregation and forwarding to backend. |
| Health remediation | V4 | Restart wedged agents, gc stale workspaces, alert on persistent failures. |
| Webhook receiver | V4 | Accept push notifications from backend (e.g., "spawn this agent now") rather than poll. |

The V1 build is intentionally minimal but the **module layout (§7) accommodates
all of the above without restructuring.**

## 5. V1 scope

**In scope (V1):**

- Long-running daemon, systemd-managed (Linux) and launchd-managed (macOS).
- Reads `apiary.secrets.yaml` for the agent token(s) (multi-token schema:
  one per scope policy — see §9).
- Calls hivemoot.dev backend's `POST /api/github/installation-tokens` (a new
  endpoint — see §11) to mint short-lived GitHub installation tokens.
- Exposes a Unix-domain socket at `/run/apiarist.sock` accepting JSON-RPC
  style requests from **agent containers** (the long-running
  `hivemoot-agent run` daemons that serve the apiary fleet).
- One operation: `mint_token` — given a `service` (the requesting agent's
  identity, taken from the `AGENT_SERVICE` env apiary deploy sets) and a
  `repo`, returns a fresh installation token. Apiarist looks up which
  agent-token slot to use for that service, mints with that bearer (or
  returns a cached token), and replies. Cache is in-memory only, default
  TTL 5 min, keyed by `(installation_id, repo, permissions_hash)`.
- Apiary deploy integration: `apiary/deploy-apiary.sh` bind-mounts
  `/run/apiarist.sock` into agent containers and sets `AGENT_SERVICE` in
  their env. Container runtime change (Phase L′) replaces static GH_TOKEN
  reads with mint-via-UDS calls. Containers using the existing PAT path
  (no `refresh_token: true` flag in their repo block) are unaffected.
- Structured JSON logging to stderr (captured by journald), with token-
  shape redaction per §10.
- Health check operation (`health` op over the socket) returning daemon
  liveness + last successful backend roundtrip.
- Graceful shutdown on SIGTERM; in-flight requests complete.

**Out of scope (V1, deferred to later phases):**

- Dynamic agent spawning (V2).
- Backend-initiated push (V4 — V1 is pull-only).
- Token revocation (we rely on natural 1-hour expiry).
- Mid-job token refresh (V1 expects jobs ≤ 1 hour, which holds today).
- Mac launchd unit (macOS not needed for current production; Linux first).
- Prometheus metrics endpoint (defer until we have a Prometheus to point at).
- TUI / CLI for direct interaction (use `journalctl` + `socat` for now).

## 6. Architecture overview

```
┌─────────────────────────────── HIVE HOST ───────────────────────────────┐
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ apiarist.service (systemd, runs as user `apiarist`)              │   │
│  │                                                                  │   │
│  │  ┌─────────────┐   ┌──────────────┐   ┌──────────────────────┐   │   │
│  │  │ IPC server  │   │ Backend      │   │ Feature plugins      │   │   │
│  │  │ (UDS)       │◄─►│ client       │◄─►│  tokens: mint_token  │   │   │
│  │  │             │   │ (httpx)      │   │  spawn:  reconcile   │   │   │
│  │  └─────┬───────┘   └──────────────┘   └──────────────────────┘   │   │
│  │        │           in-memory cache only — token never on disk    │   │
│  └────────┼──────────────────────────────────────────────────────────┘   │
│           │                                                             │
│           │ /run/apiarist.sock (chmod 660, group: agent)                │
│           │ bind-mounted into every agent container                     │
│           ▼                                                             │
│  ┌──────────────────────────────────────────┐                           │
│  │ long-running agent container             │                           │
│  │   (hivemoot-agent run; daemon mode)      │                           │
│  │                                          │                           │
│  │  internal triggers fire on their own     │                           │
│  │  schedule (cron, github polls, mentions) │                           │
│  │                                          │                           │
│  │  when GitHub call needed:                │                           │
│  │   1. open /run/apiarist.sock             │                           │
│  │   2. send: {service, repo}               │                           │
│  │   3. receive: {token, expires_at}        │                           │
│  │   4. use ghs_xxx in memory ─────────────────► api.github.com         │
│  │   5. token GC'd when call completes      │                           │
│  └──────────────────────────────────────────┘                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                          │
                          │ HTTPS (apiarist → hivemoot.dev on cache miss)
                          ▼
                ┌──────────────────────────────────────────┐
                │ hivemoot.dev (Vercel)                    │
                │  POST /api/github/installation-tokens    │
                │   Bearer <agent_token>                   │
                │   {repo: "owner/name"}                   │
                │   → resolveTokenToInstallation           │
                │   → enforce token policy (allowed_repos) │
                │   → sign JWT with App .pem               │
                │   → POST api.github.com/app/installations│
                │     /<id>/access_tokens                  │
                │     with permissions + repository_ids    │
                │     narrowed per policy                  │
                │   → return {token, expires_at,           │
                │             permissions, repositories}   │
                └──────────────────────────────────────────┘
```

**Key boundaries:**

- The App private key never touches the Hive — lives only in Vercel
  env vars on hivemoot.dev. Apiarist holds only the *agent token*, a
  bearer credential to hivemoot.dev that's already on the Hive in
  `apiary.secrets.yaml`.
- **Agent containers talk to apiarist directly via the bind-mounted
  UDS.** This is a deliberate design choice: agent containers run in
  daemon mode (`hivemoot-agent run`) with internal trigger schedules
  that the host cannot observe. There is no controller pre-spawn hook
  to mediate token requests. The agent is the trigger source, so the
  agent makes the request.
- **Tokens NEVER touch disk** (for repos that have opted in to
  apiarist auth via `refresh_token: true` in `apiary.yaml`). Apiarist
  holds them in process memory for a short cache window (default
  5 min); the agent receives them over the socket and exposes them
  to its tooling via the `GITHUB_TOKEN` env var for the duration of
  the agent's ACTIVE period (any GitHub-touching work in flight).
  When the agent becomes fully idle, the env var is cleared. See
  §12.3 for the activity-gated FSM and what "ACTIVE period" means
  in practice.

  Repos that have NOT opted in (the default `refresh_token: false`)
  retain today's static-PAT model: the token comes from
  `apiary.secrets.yaml`, is staged on disk at deploy time inside the
  per-service secrets dir, and stays in env from container boot
  until container exit. The "no disk + ACTIVE-period env" property
  is the V1 apiarist contract for opt-in repos, not a global
  fleet-wide guarantee until every repo is migrated.
- Filesystem permissions on `/run/apiarist.sock` (chmod 660, group
  `agent`) gate which processes can request mints. Apiary deploy adds
  the agent container's user to the `agent` group.
- Per-service identity: each agent container is launched with an
  `AGENT_SERVICE` env var (set by `apiary/deploy-apiary.sh`); agent
  passes it in mint requests so apiarist can apply per-service token
  policy (look up which agent token slot to use, enforce allowed_repos).
- All secrets at rest on the Hive: only the agent token (existing,
  `apiary.secrets.yaml`, chmod 600). `ghs_` installation tokens are
  ephemeral and exist only in apiarist's memory cache + agent's
  process memory while in use.

## 7. Component layout

Apiarist lives at the **top level of the hivemoot monorepo** as a sibling
to `agent/`, `bot/`, `cli/`, and `web/`. It is host-side fleet management
code that integrates with the apiary repo's deploy scripts via a small
IPC contract — apiarist itself ships in the monorepo so it inherits the
existing reviewer fleet (guard / builder / drone) and CI infrastructure.
The cross-repo integration points (`apiary/deploy-apiary.sh`,
`apiary/run-hivemoot-docker.sh`) are touched separately as small apiary
PRs in Phases K-L.

```
apiarist/                            # path is monorepo-relative (hivemoot/hivemoot/apiarist/)
├── DESIGN.md                       # this file
├── README.md                       # ops-facing docs (post-implementation)
├── pyproject.toml                  # package metadata, deps, entry point
├── src/
│   └── apiarist/
│       ├── __init__.py
│       ├── __main__.py             # `python -m apiarist`, parses args
│       ├── version.py              # __version__ string
│       │
│       ├── config.py               # config loading: apiary.yaml, apiary.secrets.yaml, env
│       ├── logging.py              # structlog setup, JSON output
│       ├── server.py               # asyncio UDS server, request dispatch
│       │
│       ├── core/
│       │   ├── __init__.py
│       │   ├── auth.py             # bearer-token loading, credential plumbing
│       │   ├── backend.py          # httpx client for hivemoot.dev
│       │   ├── ipc.py              # UDS protocol: framing, JSON, errors
│       │   └── registry.py         # feature plugin registry
│       │
│       ├── features/
│       │   ├── __init__.py
│       │   ├── tokens/             # FEATURE 1 (V1)
│       │   │   ├── __init__.py
│       │   │   ├── plugin.py       # registers `mint_token` op
│       │   │   ├── cache.py        # in-memory installation-token cache; per-installation asyncio.Lock for single-flight (NOT a global mutex)
│       │   │   └── README.md       # feature-local docs
│       │   └── spawning/           # FEATURE 2 (V2 — stub for now)
│       │       └── README.md
│       │
│       └── lib/
│           ├── __init__.py
│           ├── unix_socket.py      # asyncio UDS helpers
│           └── retry.py            # backoff, retry decorators
│
├── systemd/
│   ├── apiarist.service            # main unit
│   └── apiarist.socket             # optional socket-activation unit
│
├── deploy/
│   ├── install.sh                  # one-shot installer (creates user, copies binary, enables service)
│   └── uninstall.sh
│
├── tests/
│   ├── unit/
│   │   ├── test_config.py
│   │   ├── test_backend.py
│   │   ├── test_ipc.py
│   │   └── features/
│   │       └── test_tokens.py
│   └── integration/
│       ├── conftest.py             # fixtures: fake backend, fake socket
│       ├── test_mint_flow.py       # end-to-end: client → daemon → backend (mocked) → response
│       └── test_controller_handshake.py
│
└── examples/
    ├── apiarist_client.py          # minimal Python UDS client (vendored into monorepo agent runtime in Phase L′)
    └── client.py                   # ad-hoc CLI for ops/debug — `python -m apiarist.examples.client mint <service> <repo>`
```

## 8. IPC protocol (UDS)

**Transport:** Unix-domain socket at `/run/apiarist.sock`, mode 660,
owner `apiarist:agent`. Group `agent` is the unprivileged user that
agent containers run as (matches the existing apiary docker-run uid),
so all bind-mounted-into-container processes can read/write the socket
without granting apiarist's own user to others.

**Framing:** Length-prefixed JSON. Each message is 4 bytes big-endian
unsigned int (length N), followed by N bytes of UTF-8 JSON.

**Request shape:**

```json
{
  "op": "mint_token",
  "params": {
    "service": "foxstoria-codex-gpt-5-5-xhigh",
    "repo": "dkjazz/the-storytimes-firebase"
  },
  "request_id": "uuid-v4-string"
}
```

`service` is the agent's identity, taken from its `AGENT_SERVICE` env
(set by `apiary/deploy-apiary.sh` per service). Apiarist uses it to
look up which agent-token slot to authenticate against the backend.
`repo` is `owner/name`; apiarist forwards it to the backend, where
the token's policy decides whether the repo is in the allowed set.

**Response shape (success):**

```json
{
  "request_id": "uuid-v4-string",
  "ok": true,
  "data": {
    "token": "ghs_...",
    "expires_at": "2026-04-24T18:30:00Z",
    "installation_id": "67890",
    "permissions": {
      "contents": "read",
      "pull_requests": "write",
      "issues": "write",
      "metadata": "read"
    },
    "repositories": [
      { "full_name": "dkjazz/the-storytimes-firebase", "id": 12345 }
    ]
  }
}
```

`permissions` and `repositories` are echoed from the backend response
so the agent can verify it actually got the scope it expected.
GitHub-side narrowing means a leaked token can only access exactly
what `repositories` and `permissions` say.

**Response shape (error):**

```json
{
  "request_id": "uuid-v4-string",
  "ok": false,
  "error": {
    "code": "BACKEND_UNAUTHORIZED",
    "message": "agent token rejected by hivemoot.dev (HTTP 401)"
  }
}
```

**Error codes (V1):**

| Code | Meaning |
|---|---|
| `BAD_REQUEST` | Malformed JSON, missing required field |
| `UNKNOWN_OP` | Op not registered |
| `BACKEND_UNAUTHORIZED` | hivemoot.dev returned 401 — agent token invalid |
| `BACKEND_FORBIDDEN` | hivemoot.dev returned 403 — repo not in token's installation |
| `BACKEND_RATE_LIMITED` | hivemoot.dev returned 429 — token-creation rate limit hit |
| `BACKEND_NOT_IMPLEMENTED` | hivemoot.dev returned 501 — endpoint scaffolded but minting not yet wired (initial deploy state) |
| `BACKEND_PROTOCOL_ERROR` | hivemoot.dev returned 200 with malformed body, or `expires_at` already in the past |
| `BACKEND_UNAVAILABLE` | hivemoot.dev returned 5xx or timed out after retries |
| `INTERNAL` | Unexpected daemon-side error (logged with traceback) |

**Operations (V1):**

| Op | Params | Returns |
|---|---|---|
| `mint_token` | `service: str` (required), `repo: str` (required, for clarity & future filtering) | `token, expires_at` |
| `health` | (none) | `version, uptime_s, last_backend_roundtrip_ms, last_backend_status` |

**Future operations (V2+):**

- `spawn_agent`, `stop_agent`, `list_agents`, `reconcile_now`, ...

## 9. Configuration

Apiarist reads config from existing apiary files plus a new optional
daemon-specific file. **No new mandatory config files** for V1.

**Sources, in priority order:**

1. **CLI args:** `--config`, `--socket-path`, `--log-level`, `--backend-url`.
2. **Env vars:** `APIARIST_CONFIG`, `APIARIST_SOCKET_PATH`, `APIARIST_LOG_LEVEL`,
   `APIARIST_BACKEND_URL`. Prefix `APIARIST_` to avoid collision with apiary's
   own env.
3. **Optional config file:** `/etc/apiarist/apiarist.yaml` (or path from `--config`):
   ```yaml
   socket_path: /run/apiarist/apiarist.sock   # host path; container sees /run/apiarist.sock via bind-mount
   socket_group: agent             # group that gets read access (set by Phase J install.sh; daemon-default is "apiarist" for dev)
   backend_url: https://www.hivemoot.dev
   apiary_secrets_path: /opt/apiary/apiary.secrets.yaml
   apiary_config_path: /opt/apiary/apiary.yaml
   token_cache_safety_margin_seconds: 60    # evict at min(expires_at - 60, max_cache); matches @octokit/auth-app's 60s shave
   token_cache_max_seconds: 300             # 5 min ceiling — bursts amortize, tail exposure shrinks 10x vs full TTL
   backend_timeout_seconds: 10
   backend_retries: 3
   log_level: info
   ```
4. **Built-in defaults** (above values).

**Cache lives in apiarist process memory ONLY. No on-disk cache, no
file write of any token at any layer of the stack** — agent containers
receive tokens over UDS and hold them in their own process memory only
for the immediate API call(s).

**Cache key:** `(installation_id, repo, permissions_hash)` — NOT
installation_id alone. Two agents asking for the same installation but
different scopes (different repos within a multi-repo installation, or
different permission sets when narrowing is requested) need different
tokens, so they must hit different cache slots. Backstage's owner-only
cache key is a known footgun; this design avoids it by including the
requested scope in the key.

**Cached value:** the minted `ghs_xxx` plus its `expires_at` from the
backend response. Eviction time is
`min(expires_at - safety_margin, now + max_cache)`. The `expires_at`
from the backend is the source of truth — never assume the configured
`max_cache` matches the upstream lifetime. GitHub usually returns 1h
tokens but can return shorter ones during App permission churn; using
the response value as the floor keeps the cache from serving an
already-expired token.

**Cache TTL ceiling (`token_cache_max_seconds`) defaults to 300 (5 min)
rather than 3000 (50 min)** as a deliberate tail-exposure tradeoff:
per-installation single-flight already prevents thundering-herd, so
bursts of agent requests within 5 min still amortize to one mint;
anything sparser pays the mint cost in exchange for shorter cache
residency. If you have a heavily mint-bound deployment, raise the
ceiling — but never above the upstream `expires_at` value.

**Reading the agent token:**

Apiarist does NOT have its own copy of the agent token. It reads it at
runtime from `apiary.secrets.yaml` (`.health_token` field for V1; ideally
renamed to `agent_token` in a future cleanup). File must be readable by
the `apiarist` user (chmod 640, group `apiarist`). The deploy step (§10)
adds the apiarist user to the right group.

**Multi-token / multi-scope support (V1 contract; full schema lands
incrementally):**

The token-policy scoping model (§11) means an operator generates
multiple agent tokens — one per scope policy — and apiarist needs a
way to select the right one per service. The `apiary.secrets.yaml`
schema grows from a single `health_token` field to a keyed map; the
`apiary.yaml` repo block gains an `agent_token` selector that names
which slot to use:

```yaml
# apiary.secrets.yaml
agent_tokens:
  default: hm_xxx        # broad, used by services that don't pin one
  foxstoria-builder: hm_yyy
  foxstoria-guard: hm_zzz
```

```yaml
# apiary.yaml — service-level selector
repos:
  foxstoria:
    repo: dkjazz/the-storytimes-firebase
    refresh_token: true     # opt in to apiarist-managed token refresh
    token_env: GITHUB_TOKEN  # env var the auth subscriber populates
    agents:
      - foxstoria-dev
    overrides:
      foxstoria-dev:
        agent_token: foxstoria-builder   # which slot from secrets
```

The `refresh_token` flag is the single opt-in switch (Phase K — see
`hivemoot/apiary` PR #67 for the deploy-side schema and §12.3 for the
agent-side subscriber that consumes it). When true, the deploy script
stages no static token, mounts the apiarist socket, and the agent's
auth subscriber populates `${token_env}` from apiarist on each ACTIVE
period. When absent or false, the existing static-PAT path runs
unchanged. `apiary/deploy-apiary.sh` resolves `service → token_slot`
at deploy time and stages the mapping in the per-service env so
apiarist can look it up by `AGENT_SERVICE` on each mint request.
Phase A-B's single-token assumption stays compatible: if an
`agent_token` selector is absent, apiarist falls through to the
`default` slot (which the existing `health_token` value can populate).

## 10. Security model

**Threats considered:**

1. Container compromise (attacker gets shell in agent container).
2. Local user escalation (non-root user on Hive tries to abuse apiarist).
3. Agent-token leak (the bearer credential to hivemoot.dev).
4. Backend-to-Hive spoofing (attacker on the network impersonates hivemoot.dev).
5. Token-shaped strings ending up in logs/journal.
6. Socket-permission misconfiguration silently widening access.
7. Apiarist process memory dump exposing cached `ghs_` tokens.
8. Cross-service token theft (agent A requesting tokens scoped to agent B's repos).

**Mitigations:**

| Threat | Defense |
|---|---|
| Container compromise (`refresh_token: true` repos) | Token in container is short-lived (1h max from GitHub) and resident in `os.environ["GITHUB_TOKEN"]` only during the agent's ACTIVE period (any GitHub-touching work in flight; see §12.3). When the agent goes IDLE, the env var is cleared. Realistic ACTIVE periods are minutes to a few hours; never the container's full uptime. GitHub-side narrowing via `permissions` (and, in V1.5+, `repository_ids` — see V1 caveat row below) means a leaked token reaches only the policy-allowed scope. Container *can* reach apiarist socket (mounted into refresh_token containers) but cannot mint outside its `AGENT_SERVICE`'s token policy — apiarist looks up the policy server-side, container's request doesn't choose it. **Subprocess caveat:** subprocesses spawned during ACTIVE inherit the env at fork time and retain `GITHUB_TOKEN` until they exit; the parent's IDLE-time cleanup doesn't reach them. Short-lived `gh`/`git` invocations (the common case) are fine. Long-running spawned processes inheriting the env need to be explicitly bounded by the caller. |
| Container compromise (static-PAT repos, default until migration) | Token comes from `apiary.secrets.yaml`, is staged on disk at deploy time, and is resident in env from container boot until container exit. A compromised container leaks the static PAT in full; the only TTL bound is when the operator manually rotates the PAT (months in practice). This is today's posture for every repo without `refresh_token: true`. The apiarist migration shrinks this exposure to the ACTIVE-period model row above; until a repo is flagged, that row's defenses don't apply. |
| V1 token-policy gap (both paths, until V1.5) | The agent_token envelope in V1 doesn't carry an `allowed_repos` / `allowed_permissions` policy — `resolveTokenToInstallation` returns the installation_id only. So a leaked or cross-service agent token can mint for any repo covered by that App installation (within the V1 hard-coded permission set in `web/src/server/github-installation-token.ts`). The DESIGN.md §11 token-policy scoping model (`(request) ⊆ (token policy) ⊆ (installation grant)`) is the V1.5 target; until then the second containment ⊆ collapses to `(request) ⊆ (installation grant)`. Mitigation in V1: keep agent tokens tightly scoped to one service, audit-log every mint via the backend's `[installation-tokens] minted` log line, alert on anomalous patterns. |
| V1 short-name narrowing gap (until V1.5) | The mint endpoint passes `repositories: [<short-name>]` to GitHub rather than `repository_ids: [<numeric-id>]`. Short names are mutable (rename / transfer); a stale `apiary.yaml` requesting an old name could mint for a new repo at the same short-name slot if the installation covers all repos. V1.5 target: stand up a Redis-backed `installation:<id>:repos` cache populated by the bot's `installation.repositories.added/removed` webhooks, resolve `owner/name` → numeric `id` before the GitHub call, and fail-closed on rename (the old ID either still resolves to the renamed repo or returns a clear protocol error). Tracked in §16. |
| Cross-service token theft | An agent claiming `service: builder-claude` in its UDS request still authenticates against the **builder-claude token's policy** server-side. Apiarist trusts `AGENT_SERVICE` env (set by deploy, not by container code), and the broker→backend flow uses the bearer keyed off that. A compromised builder container cannot trick apiarist into minting against guard's token by lying about its service — apiarist's per-service policy lookup is the gate. (This does mean a fully-compromised container can mint within its OWN policy without bound — which is exactly the policy-shrink mitigation: don't grant a token broader scope than the agent legitimately needs.) |
| Apiarist process memory dump | Disable core dumps via systemd `LimitCORE=0`. Lock pages with `mlock`-equivalent (`MemoryDenyWriteExecute=true`). Restart-on-crash is already systemd's default, so a transient crash doesn't leak the cache to disk via core file. Cache TTL of 5 min (default) bounds the in-memory residency window. |
| Local user escalation | Socket is `chmod 660`, owned by `apiarist:agent`. Only members of group `agent` (the unprivileged uid the apiary docker-run gives containers) can connect. Other local users get EACCES. The daemon `chown`s the socket and asserts the configured `socket_group` exists at startup; mismatch logs loudly to stderr and refuses to start. asyncio's `start_unix_server` does NOT set group ownership automatically — explicit chown is required after bind. |
| Agent-token leak | Token already exists on the Hive today; apiarist doesn't widen the surface. File permissions: `chmod 640`, `apiary:apiarist`. Apiarist's own user can read; nothing else can. Backend enforces GitHub's documented secondary rate limits on token creation (~2,000/hr OAuth+App combined), and the broker caches per-installation tokens for their full ~1h TTL — a healthy fleet uses single-digit mints/hour. |
| Backend spoofing | All backend calls go over HTTPS. `httpx` validates certs with the system trust store. No way to disable cert validation in code. |
| Apiarist process compromise (worst case) | Worst attacker leverage is "request unbounded mint calls." GitHub's secondary rate limit on token-creation endpoints caps blast radius to ~2,000 calls/hr globally. App-level damage capped to whatever the agent token's installation grants. **Apiarist does NOT hold the App `.pem`** — that's the whole point of this architecture. |
| Tokens leaking into logs | The structured logger (Phase B) MUST redact token-shaped strings before emitting. Pattern set: `^ghs_[A-Za-z0-9]+`, `^gho_[A-Za-z0-9]+`, `^github_pat_[A-Za-z0-9_]+`, anything matching the `Authorization` header value. Phase G ships a unit test that asserts a token-shaped string fed through the logger comes out redacted. Reference pattern: `cli/tests/test_hivemoot_sanitize.py` in the agent runtime. |
| Socket permission drift | Startup self-check: the daemon refuses to start if `socket_group` doesn't exist, if the socket cannot be `chown`ed to it, or if the resulting socket is world-readable/writable (`other` bits set). All three states are loud errors to stderr, not warnings. |

**Filesystem layout, post-install:**

```
/etc/apiarist/apiarist.yaml         root:apiarist      640
/etc/apiarist/agent-token.env       root:apiarist      640  (env file with APIARIST_AGENT_TOKEN)
/var/lib/apiarist/                  apiarist:apiarist  750  (created by systemd: StateDirectory)
/run/apiarist/                      apiarist:apiarist  755  (created by systemd: RuntimeDirectory)
/run/apiarist/apiarist.sock         apiarist:agent     660  (created by daemon; chgrp'd to agent
                                                              for cross-container access — relies on
                                                              apiarist user being in the 'agent' group)
/opt/apiary/apiary.secrets.yaml     apiary:apiarist    640  (group adjusted at install time)
/usr/local/bin/apiarist             root:root          755  (compiled wheel entry point)
```

The socket lives **inside** `/run/apiarist/` rather than directly at
`/run/apiarist.sock` because the systemd unit's `ProtectSystem=strict`
denies write access to root-owned `/run/`. The
`RuntimeDirectory=apiarist` directive gives the daemon a writable
location it owns. Agent containers see the socket at `/run/apiarist.sock`
inside the container — that's the bind-mount target, not the host path.

**Process attributes** (systemd unit): see
[`apiarist/systemd/apiarist.service`](systemd/apiarist.service) for
the source of truth — that file is the deploy contract and what
`systemd-analyze security` actually measures (currently scoring
1.4/10, bordering "exemplary"). Snippets here would just drift.

Headline directives (the full set is in the unit):

| Concern | Directive |
|---|---|
| Identity | `User=apiarist`, `Group=apiarist` (member of `agent`) |
| FS isolation | `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `PrivateDevices=true` |
| Writable surface | `RuntimeDirectory=apiarist`, `StateDirectory=apiarist` (only these two dirs) |
| Privilege | `NoNewPrivileges=true`, empty `CapabilityBoundingSet=` and `AmbientCapabilities=` |
| Memory | `MemoryDenyWriteExecute=true`, `LimitCORE=0` |
| Network | `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` |
| Syscalls | `SystemCallFilter=@system-service ~@privileged`, `SystemCallErrorNumber=EPERM` |
| /proc | `ProtectProc=invisible`, `ProcSubset=pid` |
| File creation | `UMask=0077` |

## 11. Backend dependencies

Apiarist requires **one new endpoint** on hivemoot.dev:

### `POST /api/github/installation-tokens`

**Request:**

```http
POST /api/github/installation-tokens HTTP/1.1
Host: www.hivemoot.dev
Authorization: Bearer <agent_token>
Content-Type: application/json

{
  "repo": "dkjazz/the-storytimes-firebase"
}
```

`repo` is **required and verified** server-side, even though
`resolveTokenToInstallation(agent_token)` already determines which
installation is being acted on. Verification: look up the installation's
repo list (populated by GitHub `installation.repositories` webhooks) and
reject with `403` if the requested `repo` is not covered. Defense in
depth: catches apiary-side misrouting (wrong service → wrong repo)
before a valid token gets written to the wrong service's secret file,
which the fail-closed posture in §12.3 cannot detect on its own.

**Response (success):**

```json
{
  "token": "ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "expires_at": "2026-04-24T18:30:00Z",
  "installation_id": "67890",
  "permissions": {
    "contents": "read",
    "pull_requests": "write",
    "issues": "write",
    "metadata": "read"
  }
}
```

**Response (error):**

| HTTP | Cause |
|---|---|
| 400 | `repo` missing or malformed in request body |
| 401 | Bearer token invalid or revoked |
| 403 | Token valid but caller-requested `repo` not covered by installation |
| 429 | Per-token rate limit exceeded (see Rate limiting below) |
| 502 | GitHub API failure during minting (retry safe) |
| 503 | Backend overloaded, lock contention, or App misconfigured |

**Rate limiting:** GitHub's documented limits on token *creation* are the
operative ceiling — not a custom per-token bucket. Specifically: ~2,000
OAuth+App token-creation requests per hour (combined across all of an
App's installations) under the secondary-rate-limit umbrella, plus the
general ~80 content-generating requests/min secondary limit. The broker
caches each installation's token for its full ~1h TTL with single-flight
deduplication (per-installation `asyncio.Lock`), so a healthy fleet
mints single-digit times per hour even with many concurrent agent runs.
A returned `429` from the backend is reflected to the client as
`BACKEND_RATE_LIMITED` (no automatic retry within the window — the
client surfaces and waits). **Note: an earlier draft of this section
specified a "60/hr per-token bucket" — that figure was not from GitHub
docs; the documented limits above replace it.**

**Permissions narrowing:** `mintInstallationToken` MUST pass an explicit
`permissions` argument to `octokit/auth-app` matching the response
example above (`contents:read, pull_requests:write, issues:write,
metadata:read`). Do not inherit App-default permissions — that would
silently widen Hive tokens if the App's installation permissions are
ever broadened for other purposes (Queen's webhook scopes, etc.). The
narrowed scopes are the V1 contract.

**Repo identification:** The `repo` field in the request body is
`owner/name` for human readability + log auditability. Server-side, the
membership check should resolve `repo` to a numeric `repository_id`
against the `installation.repositories` webhook data and use the IDs
when calling GitHub. Repository names are mutable (rename / transfer);
IDs are immutable. Mirrors the documented gotcha from
`martinbaillie/vault-plugin-secrets-github`.

**Clock-skew baseline:** The backend's JWT signing uses `iat = now - 30s`
(matches `@octokit/auth-app` default). Apiarist's cache evicts tokens
at `min(expires_at - 60s, now + token_cache_max_seconds)` — the 60s
shave matches `@octokit/auth-app`'s 1-minute margin and absorbs both
clock skew between Hive and api.github.com plus in-flight request
latency.

**Audit hash:** Following `vault-plugin-secrets-github`'s pattern, the
backend response includes a `hashed_token` field — base64 SHA-256 of
the returned `token` — so audit logs can correlate "this token was
issued for this installation" without ever logging the secret itself.
The broker emits the hash (never the token) in its log lines.

**Revocation:** GitHub provides `DELETE /installation/token` for
explicit token revocation (the token revokes itself by presenting
itself as bearer). V1 does NOT expose a corresponding apiarist or
backend operation — the 1h TTL is the only revocation mechanism. If a
specific compromise scenario emerges, a `DELETE /api/github/installation-tokens/<token-hash>`
endpoint can be added later that wraps GitHub's revoke call.

**JWT vs token contract clarity:** Two distinct credential formats live
in this flow and they must not be confused. The **App JWT** (signed
with the App's `.pem`, ≤ 10-minute TTL, no `ghs_` prefix) is a
backend-internal artifact used to authenticate to GitHub's
`/app/installations/{id}/access_tokens` endpoint — it never appears in
the response to apiarist. The **GitHub installation access token** (the
`ghs_` value, ~1h TTL) is what apiarist receives and **holds in memory
only** until the requesting agent retrieves it over UDS. No on-disk
file is written. The `token` field in the API response is always the
latter.

**Token-policy scoping model:** Each agent token in
`apiary.secrets.yaml` is bound server-side to a policy of
`{ allowed_repos[], allowed_permissions{} }` set when the operator
generates the token via the dashboard. The backend enforces
(request scope) ⊆ (token policy) ⊆ (installation grant) on every
mint. A compromised agent token's blast radius is exactly its policy
— never the full installation. The minted `ghs_` token is then
*cryptographically* narrowed to that scope via GitHub's
`repository_ids` + `permissions` arguments, so even token leakage at
the agent process boundary is bounded by GitHub's own enforcement.

**Optional `agent_id` field (V1 audit-only):** The request body may
include an `agent_id` string. In V1 the backend logs it for
telemetry but does NOT trust it for authorization — the wire shape
exists so apiarist can populate it now without breaking when the
strong-security model lands (see "Future hardening" below). Wrong
type rejects 400; absent is fine; backend.api ignores the value for
authorization purposes.

### Future hardening: host-attested agent identity binding (V2+ candidate)

The token-policy scoping above defends against scope expansion within
a single installation. It does **not** defend against
**credential-extraction-and-replay**: if an attacker exfiltrates
`apiary.secrets.yaml`'s agent token (e.g., via host backup theft, a
container that escapes its mount namespace, or a misconfigured CI
pipeline that copies the file off-host), the bare token is sufficient
to mint within its policy from anywhere in the world.

The future hardening adds a **second factor** by binding each token
to a host-attested agent identity that the agent process itself
**does not know**:

**Threat model addressed**

| Threat | Today | Future |
|---|---|---|
| Container compromise | ❌ attacker mints within token policy | ⚠️ same — but key never reaches container, attacker must escalate to host |
| Token-file exfiltration to off-host | ❌ token usable anywhere | ✅ blocked — backend rejects without the matching agent_id |
| Cross-service token misuse on the same Hive | ⚠️ agent claims any service in UDS request | ✅ blocked — apiarist host-attests via SO_PEERCRED; agent's claim is overridden |
| Agent code reads its own identity | n/a | ✅ explicit anti-goal — agent does NOT know its agent_id |

**Design principles**

1. **The agent never knows its agent_id.** The container's
   environment may carry `AGENT_NAME`, `AGENT_ROLE`, `AGENT_SERVICE`
   — descriptive identifiers used in prompts, logs, dashboards. None
   of these are the security-binding identifier. The agent_id used
   for token authorization is a separate, opaque value (likely a
   UUID generated by the dashboard) that lives only in apiarist's
   config and the backend's token registration.
2. **The host attests, not the agent.** Apiarist determines the
   calling agent's identity via `SO_PEERCRED` on the UDS connection,
   resolves the peer PID's container name via `/proc/<pid>/cgroup`,
   then maps container → service → agent_id via apiary.yaml. The
   agent's own claims are not used for authorization (only logged
   for cross-checking).
3. **The backend verifies the binding.** Each agent token is
   registered with `{agent_id, key, allowed_repos, allowed_permissions}`.
   Mint requests include the host-attested `agent_id`; backend
   rejects 403 if `(agent_id, bearer_token)` is not a registered
   pair, even when the token by itself is valid.

**Why it's strong**

A leaked token alone is useless: the attacker would need to also
discover the matching agent_id, which:
- is never in the container's environment, file system, or any agent-
  reachable surface;
- is not the human-readable service name (no guessing from
  "builder-claude" or similar);
- is a high-entropy UUID generated server-side at agent registration;
- exists only on the host (apiarist's config) and the backend
  database.

To defeat the binding, an attacker would need either (a) host root
on the operator's Hive (already game over for many other reasons),
or (b) backend compromise (also game over). The token alone — the
historically most-likely leak vector — becomes a dead artifact.

**Implementation requirements (when this lands)**

- Backend: `agent-token` schema gains `agent_id`; registration
  endpoint generates a UUID; mint endpoint takes `agent_id` from
  request body, verifies binding, rejects 403 on mismatch.
- Apiarist:
  - SO_PEERCRED handler on the UDS server to extract caller PID.
  - `/proc/<pid>/cgroup` parser to resolve container name (Linux-
    only; non-issue since Hives are Linux).
  - Container-to-agent_id mapping in `apiary.yaml` overrides
    section, populated at deploy time.
  - Pass host-attested `agent_id` to backend on every mint.
- Apiary deploy: dashboard UI extension to register agents with
  `agent_id`; secrets file gains an `agent_ids` map alongside the
  existing `agent_tokens` map.
- Agent runtime: **NO change.** Agent doesn't know its agent_id
  and doesn't pass it. Apiarist's UDS server attests the caller
  identity from the kernel-provided peer credentials.

**Why this is V2+, not V1**

- Adds three new components (PEERCRED handler, cgroup mapping,
  backend schema) before any value lands.
- Operator UX cost (dashboard registration flow, two-secret
  management).
- The audit-only `agent_id` field in V1's request body is the
  forward-compatible bridge: when V2 lands, the field becomes
  mandatory + host-attested with no breaking wire change.
- V1's token-policy scoping already gives meaningful per-agent
  isolation; this is defense-in-depth on top.

**Implementation skeleton (TypeScript, in `web/src/app/api/github/installation-tokens/route.ts`):**

```typescript
import { resolveTokenToInstallation } from "@/server/agent-token";
import { mintInstallationToken } from "@/server/github-app";  // new helper

export async function POST(request: NextRequest) {
  const auth = extractBearer(request);
  if (!auth) return new Response(null, { status: 401 });

  const installationId = await resolveTokenToInstallation(auth, redis);
  if (!installationId) return new Response(null, { status: 401 });

  const body = await request.json().catch(() => ({}));
  if (!body.repo || typeof body.repo !== "string") {
    return new Response(null, { status: 400 });
  }

  // REQUIRED: verify body.repo is in this installation's repo list.
  // installationRepos is populated by GitHub installation.repositories
  // webhooks (already received by the bot). Resolve owner/name → id
  // and pass IDs to GitHub (immutable across renames).
  const repos = await getInstallationRepos(installationId, redis);
  const repoEntry = repos.find((r) => r.fullName === body.repo);
  if (!repoEntry) {
    return new Response(null, { status: 403 });
  }

  try {
    const minted = await mintInstallationToken(installationId, {
      // Explicit narrowing — do NOT inherit App defaults.
      repository_ids: [repoEntry.id],
      permissions: {
        contents: "read",
        pull_requests: "write",
        issues: "write",
        metadata: "read",
      },
    });
    return Response.json({
      token: minted.token,
      expires_at: minted.expires_at,
      installation_id: installationId,
      permissions: minted.permissions,
    });
  } catch (err) {
    return new Response(null, { status: 502 });
  }
}
```

**`mintInstallationToken` helper** wraps the standard GitHub App flow:
sign JWT with `APP_PRIVATE_KEY` env, POST to
`https://api.github.com/app/installations/<id>/access_tokens` with the
caller-supplied `permissions` body (narrowing scopes below the App's
defaults), parse response. ~30 lines using `octokit/auth-app` (which
takes a `permissions` argument natively) or hand-rolled with `jose`.

This endpoint is the **single backend dependency** for V1.

**Cross-stream tracking.** Per drone's PR #478 review, the backend
endpoint should have its own tracking issue in `hivemoot/hivemoot` so
the dependency is visible to anyone reading the apiarist phase plan
without having to read DESIGN.md cover-to-cover. The build session that
starts Phase C should open that issue (or confirm it exists) before
beginning, and link both directions: the apiarist Phase C PR references
the backend tracking issue, and the backend PR references this DESIGN
file.

## 12. Integration with existing apiary

Three changes to the existing apiary deployment, plus one parallel
change to the agent runtime in the monorepo. None of them write
GitHub tokens to disk.

### 12.1 `apiary.yaml`: opt-in flag per repo block + token slot per service

```yaml
repos:
  foxstoria:
    repo: dkjazz/the-storytimes-firebase
    refresh_token: true       # NEW — opts into apiarist-managed token (Phase K)
    token_env: GITHUB_TOKEN   # NEW — which env var the auth subscriber populates
    agents: [foxstoria-dev]
    overrides:
      foxstoria-dev:
        agent_token: foxstoria-builder   # which slot in apiary.secrets.yaml
    defaults:
      disable_cron: true
      watch_mentions: true
      # ...
```

When `refresh_token: true` is set, `deploy-apiary.sh` skips writing the
static PAT into the container, bind-mounts the apiarist UDS, and sets
`APIARIST_TOKEN_ENV` so the agent runtime knows which env var to
populate. The hivemoot plugin's auth subscriber (Phase L′) reads the
hivemoot.yaml `apiarist:` block emitted by deploy-apiary.sh and registers
with the engine's container lifecycle on every job.

When `refresh_token` is unset or false (the default), behavior is
unchanged. **Existing fleet services keep working without modification
during rollout.** (See `hivemoot/apiary` PR #67 for the deploy-side
schema implementation; the fields are documented in the per-repo block
schema comment at the top of `apiary.yaml`.)

### 12.2 `deploy-apiary.sh`: skip static token, bind-mount socket, set env

Implemented in `hivemoot/apiary` PR #67. Key behavior in
`stage_standing_secrets`, `write_standing_env_file`,
`write_standing_hivemoot_yaml`, and `build_standing_docker_run`:

```bash
# get_repo_refresh_token / get_repo_token_env are validating helpers
# (reject non-bool / invalid env var name) added by Phase K.
local refresh_token token_env
refresh_token="$(get_repo_refresh_token "$repo_key")"
token_env="$(get_repo_token_env "$repo_key")"

if [[ "$refresh_token" == "true" ]]; then
  # Apiarist brokers tokens — no static file, no AGENT_GITHUB_TOKEN_FILE.
  # Mount the socket; emit APIARIST_TOKEN_ENV so the runtime knows which
  # env var to populate. Fail-fast if the host socket isn't present.
  rm -f "$secrets_dir/github-token"
  if [[ ! -S /run/apiarist/apiarist.sock ]]; then
    echo "Error: refresh_token: true but apiarist daemon not running" >&2
    exit 1
  fi
  # Host-side socket lives in /run/apiarist/ (created by systemd's
  # RuntimeDirectory directive); container sees it as /run/apiarist.sock.
  docker_run="${docker_run} -v /run/apiarist/apiarist.sock:/run/apiarist.sock"
  echo "APIARIST_TOKEN_ENV=${token_env}" >> "$env_file"
else
  # Existing PAT staging path — unchanged.
  agent_github_token="$(yq ".github_tokens.\"${agent}\" // \"\"" "$SECRETS_FILE")"
  printf '%s' "$agent_github_token" > "$secrets_dir/github-token"
  chmod 600 "$secrets_dir/github-token"
fi
```

The container's effective uid (matched to the host's `agent` group, which
owns the apiarist socket) is what gates access. No additional capability
or privileged flag is needed.

### 12.3 Agent runtime change (monorepo, not apiary)

The agent runtime grows three layered pieces, with strict separation
of concerns:

1. **Engine layer**: a generic container-lifecycle FSM with a
   subscriber/event-bus pattern. Lives in `engine.py`. Knows IDLE
   and ACTIVE states. Doesn't know about auth.
2. **Subscriber interface**: a small abstract class plugins
   implement to receive lifecycle events. Generic, plugin-agnostic.
3. **Hivemoot github-auth subscriber**: implements the subscriber
   interface, owns GitHub token mint/refresh/env management.
   Lives inside the hivemoot plugin. Registers with the engine
   only for repos that opt in via per-repo config.

This separation means: the engine knows when the container is busy
or idle but nothing about auth; plugins know about the concerns
they own (auth, metrics, logging, ...) but nothing about lifecycle
internals — they just receive events and react. Auth is the first
user of this pattern; future plugins (metrics on idle/active
transitions, secret rotation, audit logging, etc.) reuse the same
subscriber surface.

**Why this layered split:** auth is a hivemoot-architecture-specific
feature (apiarist itself, the agent_token bearer, per-installation
policy on the backend, the UDS protocol). It belongs in the hivemoot
plugin. But the *trigger* for auth setup — "container is now busy,
get ready" — is a generic engine concern, not a plugin one. So the
engine owns the lifecycle FSM and emits events; the hivemoot plugin
subscribes to those events and runs its auth logic. Each layer
knows exactly what it should know and nothing more.

The github plugin (`plugins_builtin/github/`) remains a **tool
provider** — it ships `gh`/`octokit`/git wrappers that read
`GITHUB_TOKEN` from env. That contract doesn't change between the
static-PAT path and the apiarist-refresh path; only who populates
the env changes. The github plugin is **not modified** by Phase L′.

#### 12.3.1 Per-repo opt-in config

Token refresh is **opt-in per repo**, extending the existing per-repo
prefetch feature surface in `apiary.yaml`:

```yaml
repos:
  hivemoot/hivemoot:
    prefetch: true              # existing feature — unchanged
    refresh_token: true         # NEW: opt in to apiarist-managed token
    token_env: GITHUB_TOKEN     # NEW: which env var (default: GITHUB_TOKEN)

  some-non-bot-repo:
    prefetch: false
    # refresh_token absent → static PAT path; nothing changes
```

Two valid configurations for any repo:

| Config | What happens | When to use |
|---|---|---|
| `refresh_token: false` (or absent) | Static PAT path. Env populated at deploy from `apiary.secrets.yaml`. Never changes during the agent run. Subscriber not registered. | Default. Repos without the bot installed. Backwards compat. |
| `refresh_token: true` | Subscriber registered. On each ACTIVE period: mint via apiarist, set env, refresh in background, clear on IDLE. | Repos where the bot is installed and the operator has explicitly opted in. |

**Hard precondition for `refresh_token: true`:** the Hivemoot Bot
GitHub App must be installed on the target repo. Apiarist mints
installation access tokens, which by definition only exist where the
App is installed. A mint for a non-installed repo returns
`BACKEND_FORBIDDEN` (mapped from backend HTTP 403 — "repo X not
covered by the token's installation"). This fail-closes correctly
inside the subscriber's `on_active`: the lifecycle transition fails,
the triggering job fails, the runtime escalates per its retry policy.
No silent fallback to a stale token or static PAT.

Operator pre-flight: check `https://github.com/apps/<bot>` →
Configure → Repository access before flagging any repo for
`refresh_token: true`. Skipping this is the most common operational
footgun for an apiarist rollout (covered in §13 migration plan).

**V1 scope coverage:** repos that opt in get apiarist refresh; repos
that don't keep the static-PAT path. The drone pilot (V1's gate) is
a fleet-member agent on `hivemoot/hivemoot`, which has the bot
installed; flag drone's repo block with `refresh_token: true` and
the subscriber wires up automatically. Per-repo agents like
`foxstoria-builder` can opt in too if their repos have the bot
installed; nothing forces them to.

**Single-repo invariant (V1):** one subscriber per agent process,
bound to one repo. `os.environ["GITHUB_TOKEN"]` (or whatever
`token_env` names) is process-global; an agent running concurrent
work for two different repos would have the two repos' tokens stomp
each other in env, last-writer-wins. The runtime should refuse to
register a second subscriber. (Today multi-repo agents already run
as separate containers per the apiary model, so this matches
existing reality.) Future V2+ option: per-work-unit env injection
via `subprocess.run(env=...)` rather than process-global mutation.

#### 12.3.2 Engine layer — ContainerLifecycle

Lives in `agent/cli/hivemoot_agent/engine.py`. New class with five
invariants the engine guarantees:

- **I1.** When the engine dispatches a job to its plugin, every
  subscriber's `on_active` has completed and any state setup
  (env vars, network connections, etc.) is in place.
- **I2.** On full drain (last job ends), every subscriber's
  `on_idle` is awaited before the engine returns to the next idle
  iteration.
- **I3.** A subscriber raising in `on_active` rolls the active-job
  counter back to its prior value so the next job-start retries
  cleanly (no stuck count > 0 with no setup).
- **I4.** A subscriber raising in `on_idle` is logged but doesn't
  block other subscribers' cleanup; the lifecycle transition
  completes regardless.
- **I5.** Every `asyncio.create_task` in the engine and in
  subscribers uses `add_done_callback` so unhandled exceptions
  surface via the structured logger instead of being swallowed by
  asyncio's default exception handler.

**Why activity-gated (not container-startup, not per-trigger, not
always-on):**

- *Container-startup mint is wrong*: a standing-agent container can
  boot at 09:00 and sit idle until the first trigger arrives at
  11:00 — the boot-minted token would have expired before any work
  began.
- *Always-on refresh is wasteful*: a periodic agent that runs once
  a day would burn a refresh mint every ~55 min, 24 mints per
  idle day, all unused.
- *Per-trigger mint is needlessly chatty*: rapid-fire chained jobs
  (one trigger spawns another) would each mint, even though they
  could share the env value.
- *Engine-driven activity gating is the right shape*: token exists
  only while work is happening. Cost (mint + env exposure) is
  exactly aligned to actual activity. The engine is the natural
  owner of "container is busy/idle" signals; subscribers react.

**The engine class:**

```python
# Lives in agent/cli/hivemoot_agent/engine.py
import asyncio
import contextlib

class ContainerLifecycle:
    """Container-wide IDLE/ACTIVE state with subscriber events.

    The engine wires this around its job-dispatch loop: on_job_starting
    runs before the engine hands a job to its plugin, on_job_finished
    runs after. Subscribers register once at process setup and receive
    on_active/on_idle on the 0↔1 active-job-counter boundary. The
    engine awaits subscribers, so they can do async setup (e.g. mint a
    token, set env, open a connection) and the engine doesn't proceed
    until they're done.
    """

    def __init__(self) -> None:
        self._active_jobs = 0
        self._subscribers: list[LifecycleSubscriber] = []
        self._lock = asyncio.Lock()

    def subscribe(self, sub: "LifecycleSubscriber") -> None:
        """Register a subscriber.

        CONTRACT: called once per subscriber during plugin setup, before
        the engine starts dispatching jobs. NOT thread/async-safe — V1
        relies on plugin setup being single-threaded and pre-dispatch.
        Future hot-reload of subscribers would require switching to
        a copy-on-write subscribers list or wrapping append in the
        lock.
        """
        self._subscribers.append(sub)

    async def on_job_starting(self, job) -> None:
        """Engine calls before dispatching the job. On the 0→1
        transition, runs all subscribers' on_active sequentially.

        Subscriber failure semantics (invariant I3 + atomicity):
        if any subscriber raises in on_active, every PRIOR successful
        subscriber's on_idle is awaited (best-effort cleanup) so the
        engine doesn't leave half-set-up state behind, then the
        counter is rolled back and the original exception bubbles to
        the engine's job-dispatch loop which fails the triggering
        job. The runtime's normal retry path then re-attempts the
        full subscriber chain cleanly."""
        async with self._lock:
            self._active_jobs += 1
            if self._active_jobs == 1:
                # IDLE → ACTIVE — block on subscribers (invariant I1).
                # Sequential not gather() so partial-success cleanup is
                # ordered (cleanup runs in setup-order, ensures earlier
                # subscribers' state is torn down BEFORE later ones'
                # failure error is re-raised).
                completed: list[LifecycleSubscriber] = []
                try:
                    for sub in self._subscribers:
                        await sub.on_active()
                        completed.append(sub)
                except Exception:
                    # Tear down successful subscribers in reverse
                    # setup order. Each cleanup wrapped in
                    # return_exceptions equivalent so one bad cleanup
                    # doesn't mask the original setup failure.
                    for done_sub in reversed(completed):
                        try:
                            await done_sub.on_idle()
                        except Exception as cleanup_exc:
                            log.error(
                                "subscriber on_idle raised during rollback",
                                subscriber=type(done_sub).__name__,
                                exc_info=cleanup_exc,
                            )
                    # Roll back counter so next job-start retries
                    # the full chain cleanly (I3).
                    self._active_jobs -= 1
                    raise

    async def on_job_finished(self, job) -> None:
        """Engine calls after the job completes. On the 1→0
        transition, awaits all subscribers' on_idle for cleanup.
        Subscriber errors here are logged but don't propagate
        (invariant I4) — the job is done, cleanup should be
        best-effort across all subscribers."""
        async with self._lock:
            self._active_jobs = max(0, self._active_jobs - 1)
            if self._active_jobs == 0:
                # ACTIVE → IDLE — all subscribers' cleanup runs (I2, I4).
                results = await asyncio.gather(
                    *(s.on_idle() for s in self._subscribers),
                    return_exceptions=True,
                )
                for sub, result in zip(self._subscribers, results):
                    if isinstance(result, Exception):
                        log.error(
                            "subscriber on_idle raised",
                            subscriber=type(sub).__name__,
                            exc_info=result,
                        )


# Engine's job-dispatch loop becomes:
async def _run_one_job(self, job) -> None:
    await self._lifecycle.on_job_starting(job)  # awaits subscribers
    try:
        await self._dispatch_to_plugin(job)
    finally:
        await self._lifecycle.on_job_finished(job)  # awaits subscribers
```

#### 12.3.3 Subscriber interface (generic)

Lives next to `ContainerLifecycle`:

```python
class LifecycleSubscriber:
    """Plugin-agnostic contract for receiving container lifecycle
    events. Plugins implementing this register via
    ContainerLifecycle.subscribe() at plugin setup.

    Implementers should:
    - Be idempotent (subscribe might be called multiple times in
      future plugin reconfig scenarios, though not in V1).
    - Raise on critical setup failure in on_active — the engine
      cancels other subscribers in the same gather and fails the
      lifecycle transition (the triggering job fails to start, the
      runtime retries, the next attempt re-runs setup cleanly).
    - Tolerate own-errors in on_idle — best-effort cleanup; engine
      logs but doesn't propagate.
    """

    async def on_active(self) -> None:
        """Container transitioned IDLE → ACTIVE. Setup phase.
        Engine awaits this before running the triggering job."""

    async def on_idle(self) -> None:
        """Container transitioned ACTIVE → IDLE. Cleanup phase.
        Engine awaits this after the last job completes."""
```

This interface is the **only** thing the engine knows about
subscribers. Generic, reusable for future cross-cutting concerns
(metrics, logging, secret rotation, audit hooks).

#### 12.3.4 Hivemoot github-auth subscriber

Lives in `agent/cli/hivemoot_agent/plugins_builtin/hivemoot/auth/`.
Internal to the hivemoot plugin; not imported by any other plugin.

```python
# In plugins_builtin/hivemoot/auth/subscriber.py
import asyncio
import contextlib
import os
from datetime import UTC, datetime

REFRESH_SAFETY_MARGIN_SECONDS = 300

class HivemootGithubAuthSubscriber(LifecycleSubscriber):
    """Subscribes to ContainerLifecycle to keep GITHUB_TOKEN fresh
    via apiarist for opt-in repos.

    Bound to a single repo at construction (V1 single-repo invariant).
    Configured per repo in apiary.yaml — plugin only registers this
    subscriber when the repo's `refresh_token: true` flag is set.
    """

    def __init__(self, config: "RefreshConfig", apiarist_client) -> None:
        self._config = config            # repo, env_var
        self._apiarist = apiarist_client
        self._refresh_task: asyncio.Task | None = None

    async def on_active(self) -> None:
        # Engine awaits this before running the job. When this returns,
        # env is populated and the triggering job sees a valid token
        # (invariant I1). A raise here fails the transition; the engine
        # rolls the counter back and the runtime retries the job.
        token = await self._apiarist.mint_token(repo=self._config.repo)
        os.environ[self._config.env_var] = token.value
        # Background refresh: re-mint at expires_at - 5min so an ACTIVE
        # period spanning >1h doesn't hit a stale token.
        task = asyncio.create_task(self._refresh_loop(token.expires_at))
        task.add_done_callback(self._on_refresh_died)  # invariant I5
        self._refresh_task = task

    async def on_idle(self) -> None:
        if self._refresh_task is not None:
            self._refresh_task.cancel()
            # Await drain BEFORE clearing env — Task.cancel() is
            # synchronous, only requests cancellation. If the loop is
            # mid-await on mint_token, the mint return + os.environ
            # assignment both run before cancellation reaches it,
            # leaving a token in env post-IDLE without the await.
            with contextlib.suppress(asyncio.CancelledError):
                await self._refresh_task
            self._refresh_task = None
        os.environ.pop(self._config.env_var, None)

    async def _refresh_loop(self, expires_at: datetime) -> None:
        while True:
            sleep_s = (
                expires_at - datetime.now(UTC)
            ).total_seconds() - REFRESH_SAFETY_MARGIN_SECONDS
            if sleep_s > 0:
                await asyncio.sleep(sleep_s)
            new = await self._apiarist.mint_token(repo=self._config.repo)
            os.environ[self._config.env_var] = new.value
            expires_at = new.expires_at

    def _on_refresh_died(self, task: asyncio.Task) -> None:
        # Cancellation = normal on_idle path, no-op.
        if task.cancelled():
            return
        exc = task.exception()
        if exc is None:
            return  # refresh_loop is infinite; won't reach here normally
        log.error("refresh loop crashed", exc_info=exc)
        # Schedule cleanup asynchronously (callback is sync). New task
        # also gets add_done_callback (invariant I5).
        reset_task = asyncio.create_task(self._reset_after_refresh_crash())
        reset_task.add_done_callback(self._log_reset_failure)

    @staticmethod
    def _log_reset_failure(task: asyncio.Task) -> None:
        if task.cancelled() or task.exception() is None:
            return
        log.error(
            "auth subscriber reset path itself raised",
            exc_info=task.exception(),
        )

    async def _reset_after_refresh_crash(self) -> None:
        # Refresh died unexpectedly: clear env so any in-flight job's
        # next GitHub call gets 401 and the runtime retries it. The
        # retry will go through on_job_starting → on_active again
        # (since the engine doesn't know about our internal failure;
        # it sees the lifecycle as still ACTIVE). The fresh on_active
        # mints a new token and restarts the refresh loop.
        #
        # NOTE: this reset path doesn't currently trigger an engine
        # IDLE transition — that would require a callback from
        # subscriber → engine which V1 doesn't have. If a 401 storm
        # is observed in production after refresh deaths, the right
        # fix is a "subscriber-requested reset" hook in the engine.
        # Track in §16 open questions.
        self._refresh_task = None
        os.environ.pop(self._config.env_var, None)
```

#### 12.3.5 Hivemoot plugin wiring

The hivemoot plugin reads per-repo config and conditionally registers
the subscriber:

```python
# In plugins_builtin/hivemoot/__init__.py
from hivemoot_agent.engine import ContainerLifecycle, LifecycleSubscriber
from .auth.subscriber import HivemootGithubAuthSubscriber, RefreshConfig
from .auth.apiarist_client import ApiaristClient

class HivemootPlugin:
    # setup is SYNCHRONOUS — matches the existing plugin contract at
    # plugins/interfaces.py:137 and engine.py:280. The body has no
    # awaitable work (the subscriber's actual mint happens in its
    # on_active, which IS async and runs at job-start time).
    def setup(self, ctx) -> None:
        if not ctx.repo_config.refresh_token:
            # Static PAT path; nothing to do. The github plugin's
            # tooling will read whatever GITHUB_TOKEN was put in env
            # at deploy time from apiary.secrets.yaml.
            return

        subscriber = HivemootGithubAuthSubscriber(
            config=RefreshConfig(
                repo=ctx.repo_config.repo,
                env_var=ctx.repo_config.token_env or "GITHUB_TOKEN",
            ),
            apiarist_client=ApiaristClient(
                socket_path=ctx.config.apiarist_socket_path,
            ),
        )
        ctx.engine.lifecycle.subscribe(subscriber)
```

#### 12.3.5a Required github plugin change for `refresh_token: true` repos

The github plugin's current `validate()`
(`agent/cli/hivemoot_agent/plugins_builtin/github/__init__.py:131-145`)
requires a non-empty `plugins.github.token_file`, and `setup()`
(`:177-196`) reads that file and writes `GH_TOKEN`/`GITHUB_TOKEN` at
plugin-setup time. Under the static-PAT path that's exactly what we
want. Under `refresh_token: true` it's a problem: deploy-apiary.sh
omits the `token_file:` line (no static file exists), `validate()`
fails, and the agent never reaches the lifecycle subscriber that
would have populated the env.

Phase L′ MUST include a small github-plugin change to short-circuit
both `validate()` and `setup()` when the hivemoot plugin's apiarist
subsystem is enabled. Two options, in order of preference:

1. **(preferred)** github plugin's `validate()` accepts an absent
   `token_file:` if a sibling `hivemoot.apiarist.enabled: true` is
   present in the same `hivemoot.yaml`. `setup()` then becomes a
   no-op for token population (the subscriber handles env at
   on_active time). This is a one-function change.
2. **(fallback)** github plugin gets a new `token_source: subscriber`
   typed config option that explicitly opts out of the file-based
   read. deploy-apiary.sh emits this when refresh_token: true.

Phase L′'s scope therefore includes: engine `ContainerLifecycle`
+ `LifecycleSubscriber`; new hivemoot plugin `auth/` submodule with
the subscriber + apiarist client; **a small github plugin change
per the above**. The "github plugin is not modified" framing from
earlier rounds was wrong — there's a small but necessary tweak.
The framing's intent — that the github plugin's tooling-provider
role is unchanged, and the env-var contract `gh`/`git` etc. read
from doesn't change — still holds. Only the validate+setup
short-circuit is added.

#### 12.3.6 Lifecycle (showing overlapping work)

| Event | Count | State | Engine action |
|---|---|---|---|
| Container boot | 0 | IDLE | nothing |
| Job A starts (engine `on_job_starting`) | 0→1 | IDLE→ACTIVE | await all subscribers' `on_active`; auth subscriber mints, sets env, starts refresh loop |
| Engine dispatches Job A to plugin | 1 | ACTIVE | env populated; job sees valid token |
| Job B starts (overlapping) | 1→2 | ACTIVE | no transition; subscribers not called |
| Job A finishes | 2→1 | ACTIVE | no transition |
| Refresh loop fires (~55 min in) | 2 | ACTIVE | auth subscriber's loop re-mints, updates env transparently |
| Job B finishes (last) | 1→0 | ACTIVE→IDLE | await all subscribers' `on_idle`; auth subscriber cancels refresh, awaits drain, clears env |
| Long idle (5h) | 0 | IDLE | zero mints, zero env |
| Job C starts (next trigger, hours later) | 0→1 | IDLE→ACTIVE | full wake-up cycle again |
| Container exits (eventually) | — | — | process dies, env evaporates |

The "fully idle" definition is critical: the IDLE transition only
fires when the counter reaches 0. Intermediate decrements (2→1, 1→2,
etc.) don't trigger subscriber events.

#### 12.3.7 Failure modes

- *Apiarist unreachable when waking up* (or *repo not covered by an
  installation* — `BACKEND_FORBIDDEN`) → auth subscriber's
  `on_active` raises. ContainerLifecycle's gather propagates;
  `on_job_starting` rolls the counter back to 0; the triggering job
  fails to start. Runtime treats as transient and retries; next job
  triggers a fresh `on_job_starting` and re-runs the whole
  subscriber-setup phase cleanly. The most-common operational
  failure here is a misconfigured repo (operator set
  `refresh_token: true` without installing the bot); the daemon's
  error message includes the repo name so the cause is visible
  immediately.
- *Refresh fails mid-active* → auth subscriber's `_on_refresh_died`
  callback fires, logs loudly, schedules
  `_reset_after_refresh_crash` which clears env. Any in-flight job
  will see env cleared on its next GitHub call, fail with 401, and
  the runtime retries the job; the retry doesn't trigger a new
  `on_job_starting` (engine still sees us as ACTIVE), so the auth
  subscriber doesn't re-run setup automatically — the
  `_reset_after_refresh_crash` path is best-effort. If 401 storms
  are observed in production after refresh deaths, the right fix is
  a "subscriber-requested reset" hook in the engine; tracked in §16
  open questions.
- *401 mid-job* (clock skew, manual revocation via App admin UI) →
  job fails with normal HTTP error, runtime retries; refresh loop
  may have already updated env on the retry. If 401 recurs the job
  fails permanently and the runtime escalates per its retry policy.
- *Subscriber `on_idle` raises* → engine logs the error but
  continues with other subscribers' cleanup (invariant I4). The
  lifecycle transition to IDLE completes; the engine returns to its
  next idle iteration. A leaked refresh task or env from a
  partial-cleanup will be visible to operators in the journal.

**Escape hatch for jobs that genuinely span >1h** with no work-unit
boundaries: the job can call `apiarist_client.mint_token(repo)`
inline at the point it knows the env token may have aged out. The
inline mint should also update `os.environ[token_env]` if the job
expects sibling tooling (subprocesses, other libraries reading env)
to see the fresh value. Opt-in, no subscriber change required. Rare
in practice — the refresh loop covers steady-state ACTIVE periods
regardless of duration.

**Subprocess env inheritance** (V1 trust model honesty): when the
agent spawns subprocesses during ACTIVE — `gh`, `git` (via askpass),
anything else exec'd — those subprocesses receive a fork-time copy
of env including `GITHUB_TOKEN`. The token persists in the
subprocess until **the subprocess** exits, not until the parent
transitions to IDLE. Short-lived `gh`/`git` invocations are fine.
Long-running spawned processes (a watch loop, a wrapper that never
exits) need to be explicitly bounded by the caller; the parent's
`os.environ.pop` doesn't reach them.

#### 12.3.8 What this design does NOT do (intentionally)

- Mint at container startup (wrong moment — work hasn't arrived).
- Run a perpetual background refresh loop (only runs during ACTIVE).
- Reactively re-mint on 401 (refresh covers steady-state; 401
  fails the job; runtime retry path handles recovery).
- Mint per-job (chained jobs share env via the engine's lifecycle
  state; per-job mint would burn redundant mints + tear down env
  between rapid-fire triggers).
- Restrict in-process token lifetime during ACTIVE (env is
  process-global; agent code and subprocesses can read it).
- Restrict subprocess token lifetime once spawned (subprocess
  inherits env at fork; parent IDLE cleanup doesn't reach it).
- Drive auth from the github plugin (it's a tool provider, not an
  identity owner; the dependency direction is auth → tools, not
  the reverse).
- Use bare `asyncio.create_task` anywhere in the engine or auth
  subscriber (every task gets `add_done_callback`; invariant I5).
- Couple plugins to each other through auth concerns (every plugin
  that subscribes to lifecycle does so directly with the engine; no
  cross-plugin imports).

## 13. Migration plan

**Pre-flight (every phase, every repo):**

Before flagging ANY repo for apiarist auth, **verify the Hivemoot
Bot GitHub App is installed on it**. Apiarist mints installation
access tokens; without an installation, the mint returns
`BACKEND_FORBIDDEN` and the affected agent jobs fail immediately.
Check via the App admin UI (`https://github.com/apps/<bot-name>`
→ Configure → Repository access). For org-wide installs, "All
repositories" covers everything; for per-repo installs, each repo
needs to be added explicitly. Repos without the bot installed must
remain on the static-PAT path. Skipping this check is the single
most common failure mode for an apiarist rollout.

**Phase 0 — Build and shadow** (week 1)

- Implement V1 daemon (token brokering only).
- Deploy on Hive in shadow mode: daemon runs but **no service is flagged
  `refresh_token: true` yet**. Validates startup, socket creation, backend
  reachability without touching production credential flow.
- Verify backend `/api/github/installation-tokens` endpoint deployed to
  hivemoot.dev (separate but coordinated piece).

**Phase 1 — Drone pilot** (week 2)

Drone is the V1 pilot target (its existing PAT is already invalid
as of 2026-04-25, so it's broken anyway and migration won't
regress anything). Drone runs on `hivemoot/hivemoot`, which has
the Hivemoot Bot installed already.

- Confirm Hivemoot Bot is installed on `hivemoot/hivemoot` (should
  be — check via App admin UI).
- Land Phase L′: engine `ContainerLifecycle` + `LifecycleSubscriber`
  interface in `engine.py`; `HivemootGithubAuthSubscriber` in the
  hivemoot plugin's `auth/` submodule (see §12.3 for the full
  contract). The engine change adds the generic primitive future
  cross-cutting concerns reuse; the subscriber implements the
  apiarist-specific logic.
- Flag drone's repo block in `apiary.yaml` with `refresh_token: true`.
- Deploy and observe one full review cycle. Audit logs should show
  exactly one token mint per ACTIVE period, ≤1h TTL, scoped to
  `hivemoot/hivemoot`.

**Phase 1.5 — Foxstoria** (week 2-3)

Foxstoria is a per-repo agent (triggered by github plugin's
PR-watcher, not hivemoot.tasks). Under the V1 engine-lifecycle +
hivemoot-subscriber architecture, foxstoria works exactly the same
way fleet members do: any work the engine dispatches (whether the
github plugin's PR-watcher or hivemoot.tasks) calls
`on_job_starting` → subscribers run. So foxstoria can opt in to
`refresh_token: true` once Phase L′ ships, with no additional
runtime work. Until Phase L′ lands, keep foxstoria on static PAT
in `apiary.secrets.yaml`.

**Phase 2 — Validate, document, train** (week 3)

- Write ops runbook: how to debug a failed mint, how to rotate the agent
  token, how to revoke an installation.
- Capture metrics: mint latency p50/p99, backend error rate, cache hit
  rate.

**Phase 3 — Migrate fleet** (week 4+)

- One repo at a time, flag `refresh_token: true` in apiary.yaml. Observe
  for one full cron cycle before moving to the next.
- After all services migrated, the corresponding `github_tokens.<agent>`
  classic PATs in `apiary.secrets.yaml` can be revoked. **Don't delete
  the YAML field until backend has accepted token-less requests for at
  least 7 days** (rollback safety).

**Phase 4 — V2 design begins** (week 5+)

- With apiarist in production for token brokering, the IPC patterns and
  daemon architecture are validated. Begin designing the agent-spawning
  feature (separate design doc, `apiarist/SPAWNING-DESIGN.md`).

## 14. Implementation phases (V1, ordered)

| Phase | Task | Effort | Dependencies |
|---|---|---|---|
| **A.** Project skeleton | `pyproject.toml`, package layout, `__main__`, version, basic CLI | 0.5d | — |
| **B.** Config & logging | `config.py` (CLI/env/file/defaults), `logging.py` (structlog JSON, with token-shape redaction per §10) | 0.5d | A |
| **B+.** CI workflow | `.github/workflows/apiarist-ci.yml` path-scoped to `apiarist/**`: `pip install -e '.[dev]'`, `ruff check src tests`, `mypy src` (strict), `pytest -v`. Pin Python 3.11 for the matrix initially. **Must land with or before Phase B** per guard's PR #478 review — Phase A's tooling promises (ruff/mypy/pytest green) are not yet enforced by any workflow. | 0.25d | A |
| **C.** Backend client | `core/backend.py` — httpx, retries, error mapping | 0.5d | B, **backend endpoint stub deployed** |
| **D.** IPC server skeleton | `server.py` + `core/ipc.py` — UDS bind, framing, dispatch | 1d | B |
| **E.** Token feature | `features/tokens/{plugin,cache}.py` — wires C+D, `mint_token` op | 0.5d | C, D |
| **F.** Health op | trivial dispatch on `health` op | 0.25d | D |
| **G.** Tests — unit | pytest for config, ipc framing, cache, backend client (mocked) | 1d | C, D, E |
| **H.** Tests — integration | fake backend + real socket, full mint flow | 1d | E, G |
| **I.** Systemd unit | `apiarist.service` with hardening attrs (§10) | 0.25d | E |
| **J.** Install script | `deploy/install.sh`: create user, copy files, enable unit | 0.5d | I |
| **K.** Apiary integration — deploy script | `apiary/deploy-apiary.sh` patch (§12.2): when `refresh_token: true`, skip static token staging, bind-mount `/run/apiarist/apiarist.sock` (host) → `/run/apiarist.sock` (container), emit `APIARIST_TOKEN_ENV=<env_var>`, omit github plugin's `token_file:` line, emit a new `hivemoot.apiarist:` block (enabled, socket_path, repo, env_var) for Phase L′ to consume. Two new validating helpers (`get_repo_refresh_token`, `get_repo_token_env`) reject malformed inputs at parse time. Fail-fast deploy if the host apiarist socket isn't present. PR opened against `hivemoot/apiary` (no fleet review there, self-merge per CLAUDE.md memory). **Shipped** in `hivemoot/apiary` PR #67. | 0.5d | — (parallel) |
| **L′.** Engine lifecycle FSM + hivemoot auth subscriber | Three layered changes: (a) **engine.py** gains `ContainerLifecycle` (generic IDLE/ACTIVE FSM with subscriber pattern) and a `LifecycleSubscriber` interface, with engine's job-dispatch loop calling `on_job_starting`/`on_job_finished` around each job; (b) new `plugins_builtin/hivemoot/auth/` submodule with `HivemootGithubAuthSubscriber` (implements `LifecycleSubscriber`, owns mint/refresh/env management) and `apiarist_client.py` (~50 LOC UDS client); (c) hivemoot plugin's `setup` reads per-repo config (`refresh_token: true`, `token_env: GITHUB_TOKEN`) and conditionally registers the subscriber. Engine knows lifecycle, doesn't know auth. Auth subscriber knows auth, doesn't know lifecycle internals. github plugin is **not touched**. **Hard precondition for opt-in: target repo must have the Hivemoot Bot GitHub App installed** — non-installed repos stay on static-PAT (the default). | 2d | D, E |
| **M.** Shadow deploy on Hive | rsync, install, verify socket creation, exercise via examples/client.py without flagging any service. | 0.5d | J, K, L′ |
| **N.** Drone pilot | The V1 pilot is **drone**, not foxstoria — drone is a fleet member on `hivemoot/hivemoot` (which already has the bot installed) AND its existing PAT is invalid as of 2026-04-25 so migrating it can't regress anything. Flag drone's repo block (`hivemoot:` in `apiary.yaml`) with `refresh_token: true`, deploy, observe one full review cycle. Verify a `ghs_` token reaches GitHub successfully and zero token files appear on disk. Foxstoria opt-in is deferred to Phase 1.5 (see §13) — it works under the engine-lifecycle architecture but is shipped after the drone pilot validates the path. | 0.5d | M, **backend endpoint live** |
| **O.** Runbook + metrics | `apiarist/README.md` ops guide. Document `journalctl -u apiarist`, common failure modes, how to validate a service is using App auth vs PAT. | 0.5d | N |

**Total V1 estimate:** ~8 days of focused work, plus ~2 days for the
backend endpoint (separate work stream on hivemoot.dev). Realistic
calendar: 2-3 weeks with normal interruptions, code review, and
cross-repo coordination.

## 15. Testing strategy

**Unit tests** (pytest, `tests/unit/`):

- Config loading: precedence, missing fields, malformed YAML.
- IPC framing: short reads, oversized payloads, malformed JSON.
- Backend client: 200/401/403/5xx mapping, retry behavior, timeout.
- Token cache: hit, miss, expiry boundary.

**Integration tests** (pytest, `tests/integration/`, fixtures spin up a
fake backend HTTP server + a real UDS):

- End-to-end mint: client connects → request → daemon calls fake backend
  → returns token. Verify exact JSON shapes and timing.
- Cache reuse: second request within TTL doesn't hit backend.
- Backend down: client gets `BACKEND_UNAVAILABLE`, no panic, daemon
  stays alive.
- Concurrent requests for same service: only one upstream call (verifies
  per-installation `asyncio.Lock`, not a global mutex — concurrent
  requests for *different* services must run in parallel).
- Concurrent requests for different services: parallel upstream calls.
- Daemon SIGTERM during in-flight request: request completes before exit.

**Adversarial integration cases** (most likely to surface first in
production, cheapest to test now):

- Backend returns `200 OK` with malformed JSON body → client gets
  `BACKEND_UNAVAILABLE` (or a more specific `BACKEND_PROTOCOL_ERROR`),
  no crash, no cache poisoning.
- Backend returns a valid token whose `expires_at` is already in the
  past → cache rejects on insert (does not store), client gets fresh
  mint on next request rather than serving expired data.
- Clock skew / safety margin: apiarist cannot observe downstream
  GitHub 401s in V1 (the agent container talks to GitHub directly with
  the minted token; apiarist sees no feedback path). Defense is
  conservative *eviction*, not reactive retry. Test with mocked clock
  that the cache evicts at `expires_at - safety_margin` even when the
  Hive wall clock thinks the token is still well within its lifetime;
  the `safety_margin` (default 600s) is the explicit budget for
  Hive↔GitHub clock skew plus in-flight request latency. If a
  feedback path from agent containers back to apiarist is ever added
  (out of V1 scope), reactive eviction on observed 401 becomes
  possible — until then, conservative eviction is the only defense
  apiarist itself can enforce.
- Backend returns `429` (rate limit) → client surfaces
  `BACKEND_RATE_LIMITED`, does not retry within the window, does not
  serve stale cached value as a fallback.

**Manual / e2e tests** (`apiarist/examples/client.py`):

- Small Python client to manually fire requests and inspect responses
  during development.

**No real GitHub or hivemoot.dev calls in CI.** Backend client is mocked
with httpx's `MockTransport`. Real e2e validation happens in shadow mode
on Hive (Phase 0).

## 16. Open questions (decide during implementation)

1. **Multi-installation schema in apiary.** Foxstoria pilot requires a
   second agent token. Either (a) extend `apiary.secrets.yaml` schema now
   (`agent_tokens: {default: ..., foxstoria: ...}`) or (b) ship V1 with
   single-token assumption and add multi-token in a quick V1.1. Leaning
   toward (a) because foxstoria is the motivating use case; not worth
   shipping V1 without it.
2. **Should apiarist also mint for the existing `/api/agent-health` and
   `/api/tasks/*` calls?** Currently those are made directly by the
   runtime hivemoot plugin using the same agent token. Could centralize
   them through apiarist, but that's a bigger refactor with no
   immediate security benefit. **Defer.**
3. **Cache eviction strategy.** In-memory hashmap with TTL is fine for
   V1. If apiarist restarts, cache is lost — first request after restart
   is a backend roundtrip. Acceptable. Persistent cache adds complexity
   (file or sqlite) for marginal benefit; defer until/unless we see
   restart thrashing.
4. **Socket activation vs daemon-managed socket.** systemd socket
   activation has nice properties (zero-downtime reloads, lazy start)
   but adds setup complexity. V1 ships with daemon-managed socket
   (simpler); add socket activation in V1.1 if useful.
5. **macOS support.** Not strictly required (Hive is Linux). But if
   developers want to run apiarist locally for testing, a launchd plist
   would help. **Defer**; Linux first.
6. **Telemetry.** Emit logs only in V1. Add Prometheus metrics endpoint
   when (a) we deploy multiple Hives and want fleet-wide visibility, or
   (b) we have a Prometheus scraper anywhere. **Neither today.**
7. **Subscriber-requested-reset hook in `ContainerLifecycle`.** §12.3.4
   notes that the hivemoot auth subscriber's `_reset_after_refresh_crash`
   path doesn't trigger an engine IDLE transition — that would require
   a callback from subscriber → engine which V1 doesn't have. If
   401-storms are observed in production after refresh-task crashes
   (subscriber clears env but engine still thinks it's ACTIVE so no
   re-wake on next job-start), V1.1 adds a `subscriber.request_reset()`
   API that triggers a forced ACTIVE→IDLE→ACTIVE cycle. Defer until
   we have telemetry evidence the gap matters in practice.
8. **Token-policy scoping in agent-token envelope.** §10's "V1
   token-policy gap" row tracks this: the envelope today carries only
   the installation_id, so a leaked token can mint for any repo in the
   installation grant. V1.5 target: extend the agent-token envelope
   with `allowed_repos: string[]` and `allowed_permissions: Record<string, string>`,
   enforce `(request) ⊆ (token policy) ⊆ (installation grant)` in the
   mint endpoint, and surface the policy in the dashboard's token
   creation UI. Required before broader fleet rollout (drone pilot
   acceptable risk because it's a single agent on one repo).
9. **`repository_ids` narrowing + install-repos cache.** §10's "V1
   short-name narrowing gap" row tracks this: we pass repo short names
   to GitHub rather than numeric IDs, so a rename + recreate at the
   same slot inside an "all repositories" installation could mint for
   the new repo. V1.5 target: stand up a Redis-backed
   `installation:<id>:repos` cache populated by the bot's webhook
   handlers (`installation.repositories.added/removed`), resolve
   `owner/name` → numeric `id` in the mint endpoint, narrow with
   `repository_ids: [<id>]`. Pairs with #8 because the
   policy-enforcement check uses the same lookup.

## 17. Anti-goals

To keep V1 honest and avoid scope creep:

- ❌ Apiarist is not a generic IPC framework. The IPC protocol is
  intentionally minimal and specific to apiarist's needs.
- ❌ Apiarist is not a service mesh. It mediates a few specific calls,
  not arbitrary traffic.
- ❌ Apiarist is not a config server. The agent containers don't get
  arbitrary config from it; they get a token. Future features (spawning,
  config sync) will be additive features, not a generic "ask apiarist for
  anything" model.
- ❌ Apiarist does not run agent jobs or wrap the agent runtime.
  `hivemoot-agent run` (in long-running containers) is the trigger
  source and the workload; apiarist is a service it consults via
  UDS for short-lived GitHub credentials.
- ❌ Apiarist does not implement its own GitHub auth. All App-auth flow
  happens server-side at hivemoot.dev. Apiarist is a thin client.

## 18. Glossary

| Term | Meaning |
|---|---|
| **Hive** | A single physical or virtual host running the apiary fleet. |
| **Operator** | A person who runs a Hive (you, today; potentially others later). |
| **Apiarist** | This daemon. |
| **Agent token** | The bearer credential that authenticates a Hive to hivemoot.dev. Same value as `health_token` in `apiary.secrets.yaml`. Bound server-side to one GitHub App installation. |
| **Installation token** | Short-lived (≤1h) GitHub credential minted from the App's private key, scoped to one installation's repos and permissions. The `ghs_xxx` value. |
| **App private key** | RSA private key controlling the Hivemoot Bot GitHub App. Lives only in Vercel env vars at hivemoot.dev. |
| **Service** | One systemd unit in apiary, e.g., `hivemoot-claude-opus-4-7`, `foxstoria-codex-gpt-5-5-xhigh`. Each service is one (repo × engine) pair. |
| **Standing agent** | An agent run on a recurring or event-driven cadence per `apiary.yaml`. (Contrast with dispatch agent.) |
| **Broker** | Generic term for a service that mints/proxies short-lived credentials. Apiarist is one. |

---

**End of design document.** Implementation tracked in
`apiarist/IMPLEMENTATION.md` (created when build begins).
