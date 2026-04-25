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
| IPC socket | `/run/apiarist.sock` |
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
  (no `auth: github-app` flag in their repo block) are unaffected.
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
- **Tokens NEVER touch disk.** Apiarist holds them in process memory
  for a short cache window (default 5 min); the agent receives them
  over the socket and holds them in process memory for the duration
  of one or a few GitHub API calls, then they're garbage-collected.
  No on-disk file at any layer.
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
   socket_path: /run/apiarist.sock
   socket_group: apiarist          # group that gets read access
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
    auth: github-app
    agents:
      - foxstoria-dev
    overrides:
      foxstoria-dev:
        agent_token: foxstoria-builder   # which slot from secrets
```

`apiary/deploy-apiary.sh` resolves `service → token_slot` at deploy
time and stages the mapping in the per-service env so apiarist can
look it up by `AGENT_SERVICE` on each mint request. Phase A-B's
single-token assumption stays compatible: if an `agent_token`
selector is absent, apiarist falls through to the `default` slot
(which the existing `health_token` value can populate).

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
| Container compromise | Token in container is short-lived (1h max from GitHub, but only resident in agent process memory while in active use — typically seconds). GitHub-side narrowing via `repository_ids` + `permissions` means even a leaked token reaches only the policy-allowed scope. Container *can* reach apiarist socket (mounted into all containers using App auth) but cannot mint outside its `AGENT_SERVICE`'s token policy — apiarist looks up the policy server-side, container's request doesn't choose it. |
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
/etc/apiarist/apiarist.yaml         apiary:apiarist  640
/var/lib/apiarist/                  apiarist:apiarist  750
/run/apiarist.sock                  apiarist:apiarist  660  (created by daemon at startup)
/opt/apiary/apiary.secrets.yaml     apiary:apiarist    640  (group adjusted at install time)
/usr/local/bin/apiarist             root:root          755  (compiled wheel entry point)
```

**Process attributes** (systemd unit):

```ini
User=apiarist
Group=apiarist
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/run /var/lib/apiarist
ReadOnlyPaths=/opt/apiary
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
```

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
    auth: github-app          # NEW — opts into apiarist-brokered tokens
    agents: [foxstoria-dev]
    overrides:
      foxstoria-dev:
        agent_token: foxstoria-builder   # which slot in apiary.secrets.yaml
    defaults:
      disable_cron: true
      watch_mentions: true
      # ...
```

When `auth: github-app` is set, `deploy-apiary.sh` skips writing the
static PAT into the container, bind-mounts the apiarist UDS, and sets
the `AGENT_SERVICE` + `AGENT_TOKEN_SLOT` env vars so the agent runtime
knows its identity and apiarist knows which agent-token to use.

When `auth:` is unset (default `pat`), behavior is unchanged.
**Existing fleet services keep working without modification during
rollout.**

### 12.2 `deploy-apiary.sh`: skip static token, bind-mount socket, set env

In the per-service docker-run construction (around line 890 of
`stage_standing_secrets` and around line 1295 of `build_standing_docker_run`):

```bash
local repo_auth
repo_auth=$(yq ".repos.${repo_key}.auth // \"pat\"" "$CONFIG_FILE")
if [[ "$repo_auth" == "github-app" ]]; then
  # Apiarist brokers tokens — no static file, no env. Mount the
  # socket and tell the agent its identity.
  rm -f "$secrets_dir/github-token"
  docker_run="${docker_run} -v /run/apiarist.sock:/run/apiarist.sock"
  docker_run="${docker_run} -e AGENT_SERVICE=${service_name}"
  docker_run="${docker_run} -e AGENT_TOKEN_SLOT=${agent_token_slot}"
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

In `agent/cli/hivemoot_agent/plugins_builtin/.../github` (Phase L′
PR against `hivemoot/hivemoot`): wherever the agent currently reads
`GH_TOKEN` from env or a file, branch on the presence of
`AGENT_SERVICE` (set by apiary deploy when App auth is on). When
present, replace the static token read with a UDS round-trip to
`/run/apiarist.sock`:

```python
# pseudocode — actual implementation lands in Phase L′
def get_github_token(repo: str) -> str:
    if os.environ.get("AGENT_SERVICE"):
        return apiarist_client.mint_token(
            service=os.environ["AGENT_SERVICE"],
            repo=repo,
        ).token
    return os.environ["GH_TOKEN"]  # legacy PAT path
```

The token returned is held in agent process memory only for the
duration of the immediate API call(s); no caching at the agent
layer (apiarist's cache is the right place for that).

Failure modes (apiarist unreachable, mint rejected, token expired
mid-job): fail-closed — surface the error to the trigger and
abort the job rather than fall back to a stale or wrong-scope token.

## 13. Migration plan

**Phase 0 — Build and shadow** (week 1)

- Implement V1 daemon (token brokering only).
- Deploy on Hive in shadow mode: daemon runs but **no service is flagged
  `auth: github-app` yet**. Validates startup, socket creation, backend
  reachability without touching production credential flow.
- Verify backend `/api/github/installation-tokens` endpoint deployed to
  hivemoot.dev (separate but coordinated piece).

**Phase 1 — Foxstoria first** (week 2)

- Install Hivemoot Bot App on `dkjazz/the-storytimes-firebase`.
- Verify a *separate* agent token is generated for that installation
  (requires multi-installation apiary schema, §9 future bullet).
- Flag `foxstoria` repo block with `auth: github-app`.
- Deploy and observe one full review cycle. Audit logs show exactly one
  token mint per agent run, ≤1h TTL, scoped to `dkjazz/the-storytimes-firebase`.

**Phase 2 — Validate, document, train** (week 3)

- Write ops runbook: how to debug a failed mint, how to rotate the agent
  token, how to revoke an installation.
- Capture metrics: mint latency p50/p99, backend error rate, cache hit
  rate.

**Phase 3 — Migrate fleet** (week 4+)

- One service at a time, flag `auth: github-app`. Observe for one full
  cron cycle before moving to the next.
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
| **K.** Apiary integration — deploy script | `apiary/deploy-apiary.sh` patch (§12.2): when `auth: github-app`, skip static token, bind-mount `/run/apiarist.sock`, set `AGENT_SERVICE` + `AGENT_TOKEN_SLOT` env. PR opened against `hivemoot/apiary` (no fleet review there, self-merge per CLAUDE.md memory). | 0.5d | — (parallel) |
| **L′.** Agent runtime — UDS-based mint | In `agent/cli/hivemoot_agent/plugins_builtin/.../github` (monorepo, opened as separate PR against `hivemoot/hivemoot`, fleet-reviewed): branch on `AGENT_SERVICE` env; when present, replace static `GH_TOKEN` reads with mint-via-UDS. Tiny apiarist Python client lib (~50 lines) lives in monorepo so the agent can import it. | 1.5d | D, E |
| **M.** Shadow deploy on Hive | rsync, install, verify socket creation, exercise via examples/client.py without flagging any service. | 0.5d | J, K, L′ |
| **N.** Foxstoria pilot | flag foxstoria's repo block with `auth: github-app` + `agent_token: foxstoria-builder`, deploy, observe one full agent run cycle. Verify ghs_ token reaches GitHub successfully and zero token files appear on disk. | 0.5d | M, **backend endpoint live** |
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
