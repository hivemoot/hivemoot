# Agent Health Contract

This document defines the current production contract for agent health ingestion and dashboard retrieval in `web`.

Scope:
- API surface (`/api/agent-health` — agents ingest reports here)
- Authentication via V1 capability bearers (`agent_health.report` capability)
- Payload validation and response semantics
- Redis storage layout, TTL, retention, and status derivation
- Operational requirements and acceptance coverage

Token lifecycle (issue / list / rotate / revoke) is documented in the
V1 capability token system (`/api/agent-tokens` family + dashboard's
Capability Tokens UI). The legacy singular `/api/agent-token` was
deleted in favor of that system.

This is the canonical contract for the shipped implementation and supersedes the early GitHub-user-token design discussed in issue #169.

## 1. Endpoint Summary

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/agent-health` | `Authorization: Bearer <V1-capability-bearer>` requiring `agent_health.report` | Ingest one agent run report |
| `GET /api/agent-health` | Setup session cookie | Read dashboard overview or run history |

Token lifecycle is in the V1 capability surface — see `/api/agent-tokens`,
`/api/agent-tokens/bootstrap`, and the dashboard's "Capability Tokens"
section under Credentials. Issue tokens with the `worker` preset (which
includes `agent_health.report`) for hive agents that POST health reports.

Auth split is intentional:
- Machine writes (`POST /api/agent-health`) use V1 capability bearers
  with `agent_health.report` capability — issued per-installation,
  Redis-stored, BYOK-encrypted.
- Human/admin reads and token lifecycle operations use setup-session
  cookie auth on the dashboard.

## 2. POST /api/agent-health Contract

Each POST represents either a **run report** or a **heartbeat**.

### 2a. Heartbeat Payloads

Heartbeats are lightweight liveness signals sent between runs. They carry no run data and use a separate validation path.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `agent_id` | string | yes | 1-64 chars, regex `[a-z0-9_-]+` |
| `repo` | string | yes | 1-200 chars, `owner/name` format |
| `outcome` | string | yes | Must be `"heartbeat"` |
| `next_run_at` | string | no | ISO-8601, max 64 chars, between `now-5m` and `now+48h` |

Heartbeat behavior:
- Detected by `outcome === "heartbeat"` before run-report validation.
- No `run_id`, `duration_secs`, or `consecutive_failures` — these are rejected as unknown fields.
- Skips idempotency (no `run_id` to dedupe).
- Rate-limited at one per agent per repo per 60 seconds (shared bucket with run reports).
- If a prior run report exists in the `latest` key, the heartbeat patches `received_at` (and optionally `next_run_at`) while preserving all run data. If no prior report exists, a minimal heartbeat entry is stored.
- Heartbeats are NOT added to the runs sorted set (they aren't runs).
- Success response: `200` + `{"received": true, "received_at": "<iso>"}`.

### 2b. Run Report Payloads

Each run report represents one completed run for one `agent_id` + `repo`.

### Required Fields

| Field | Type | Constraints |
|---|---|---|
| `agent_id` | string | 1-64 chars, regex `[a-z0-9_-]+` |
| `repo` | string | 1-200 chars, must contain `/` (`owner/name`) |
| `run_id` | string | 1-128 chars |
| `outcome` | string | `success` \| `failure` \| `timeout` |
| `duration_secs` | integer | `0..86400` |
| `consecutive_failures` | integer | `>= 0` |

### Optional Fields

| Field | Type | Constraints |
|---|---|---|
| `model` | string | 1-128 chars, regex `[a-zA-Z0-9._:/-]+` |
| `error` | string | 1-256 chars |
| `exit_code` | integer | Any integer |
| `next_run_at` | string | ISO-8601, max 64 chars, between `now-5m` and `now+48h` |
| `run_summary` | string | Markdown, ANSI-stripped, truncated to 4096 chars; empty after stripping rejected |
| `trigger` | string | `scheduled` \| `mention` \| `manual` \| `task` |
| `token_usage` | object or `null` | Exact nested schema below; required numeric counters must be present, nullable fields may be omitted and are normalized to `null` |

#### `token_usage` object shape

When `token_usage` is an object, these top-level fields are accepted:

| Field | Type | Constraints |
|---|---|---|
| `input_tokens` | integer | Required, non-negative |
| `output_tokens` | integer | Required, non-negative |
| `cache_read_input_tokens` | integer or `null` | Optional; non-negative when present, normalized to `null` when omitted |
| `cache_creation_input_tokens` | integer or `null` | Optional; non-negative when present, normalized to `null` when omitted |
| `cost_usd` | number or `null` | Optional; non-negative when present, normalized to `null` when omitted |
| `num_turns` | integer | Required, non-negative |
| `model_breakdown` | object or `null` | Optional; keys must match `[a-zA-Z0-9._:/-]+` |

`model_breakdown`, when present as an object, must map model ids to objects with this shape:

| Field | Type | Constraints |
|---|---|---|
| `input_tokens` | integer | Required, non-negative |
| `output_tokens` | integer | Required, non-negative |
| `cache_read_input_tokens` | integer or `null` | Optional; non-negative when present, normalized to `null` when omitted |
| `cache_creation_input_tokens` | integer or `null` | Optional; non-negative when present, normalized to `null` when omitted |
| `cost_usd` | number or `null` | Optional; non-negative when present, normalized to `null` when omitted |

Validation behavior:
- Maximum payload size: 10KB (checked via `Content-Length` and actual body bytes).
- Unknown top-level fields are rejected.
- `run_summary` is sanitized by stripping ANSI escape sequences before storage.
- Invalid JSON returns 400.
- Server assigns `received_at`; client value is not accepted.

### Success and Error Semantics

Success:
- `200` + `{"received": true, "received_at": "<iso>"}` for new accepted reports.
- `200` + `{"received": true, "received_at": "<iso>", "duplicate": true}` for an idempotent retry with the same dedupe identity (`agent_id`, `repo`, `run_id`, `outcome`, `duration_secs`, `consecutive_failures`, `error`, `exit_code`, `next_run_at`); metadata-only differences (`model`, `run_summary`, `trigger`, `token_usage`) are still treated as duplicates.

Error:
- `401` `agent_health_not_authenticated` for missing/invalid agent token.
- `401` `agent_health_token_expired` when a recognized agent token is past its configured expiry.
- `409` `agent_health_idempotency_conflict` when `run_id` is reused with different payload.
- `409` `agent_health_idempotency_pending` when the same report is still in-flight.
- `429` `agent_health_rate_limited` when exceeding one report per 60s for installation+agent+repo.
- `413` `agent_health_payload_too_large` when body exceeds 10KB.
- `400` `agent_health_validation_failed` or `agent_health_invalid_json` for schema/JSON issues.
- `503` `agent_health_server_misconfiguration` when runtime config is unavailable.

## 3. GET /api/agent-health Contract

Setup-session authenticated endpoint for dashboard reads.

Query modes:
- No params: returns overview payload `{ "agents": [...] }`.
- `agent_id` + `repo` (with or without `history=true`): returns
  `{ "agent_id": "...", "repo": "...", "history": [...], "runs": [...] }`.

Validation:
- `history=true` requires both `agent_id` and `repo`.
- `agent_id` and `repo` use the same constraints as POST validation.

## 4. Status Derivation and Read Model

Dashboard status values:
- `unknown`: no valid latest report.
- `failed`: latest outcome is `failure` or `timeout`.
- `late`: latest outcome is `success` and now is beyond `next_run_at` plus a 50% interval buffer.
- `ok`: latest outcome is `success` (within schedule), or `heartbeat` (agent alive, no run yet).

Read behavior:
- Overview is sorted by `received_at` descending.
- History is fetched newest-first and capped at 1440 entries (~24h at one report/minute).

## 5. Agent Token Contract

Token format and storage (V1 capability system):
- Raw bearer is `hmt_` + opaque random hex.
- Multiple named tokens per installation (each with its own capability set + policy).
- On rotate, old bearer is invalidated and new bearer issued atomically.
- New tokens may be generated via `POST /api/agent-tokens` (admin-bearer
  auth) or `POST /api/dashboard/agent-tokens` (cookie auth) with body
  `{ "name": "<name>", "preset": "worker" | "queen" | "monitoring" | ...,
  "expiresIn": "90d" }`. Supported units are `m`, `h`, and `d`, capped at
  365 days. Omitted or `null` = no expiry.

Security model:
- Raw bearer is encrypted with BYOK keyring and stored at
  `hive:v1:agent-token:{installationId}:{name}` (one envelope per named
  token per installation).
- Envelope carries `expiresAt: string | null`, `capabilities: string[]`,
  `agent_role: string`, optional `policy?: AgentTokenPolicy`.
- A SHA-256 hash reverse index at `hive:v1:idx:agent-token:hash:{hash}` →
  `{ installationId, name }` enables O(1) bearer → identity lookup.
- `POST /api/agent-health` resolves bearer + checks `agent_health.report`
  capability via `authenticateAgentRequestV1`; no GitHub `/user` call on
  write path.
- Expired bearers are rejected at envelope-resolution time.

Operational note:
- The dashboard's Capability Tokens UI shows one-time-display dialogs
  for new bearers and the rotate flow. Existing bearers are NOT
  retrievable post-issue — operators rotate to recover, never read.

## 6. Redis Data Layout

Agent token keys:
- `hive:agent-token:{installationId}` (encrypted envelope)
- `agent-token-hash:{sha256}` (reverse index)

Agent health keys:
- `agent-health:latest:{installId}:{agentId}:{repo}`
  - Latest report JSON
  - TTL: `max(24h, 2 * secondsUntilNextRun)` when `next_run_at` is in the future; otherwise 24h
- `agent-health:runs:{installId}:{agentId}:{repo}`
  - Sorted set of run JSON entries (score = `received_at` epoch ms)
  - Trimmed to 24h retention
- `agent-health:index:{installId}`
  - Set of `{agentId}:{repo}` members for overview enumeration
- `agent-health:ratelimit:{installId}:{agentId}:{repo}`
  - Rate limit key (NX/EX 60s)
- `agent-health:idempotency:{installId}:{digest}`
  - 24h idempotency reservation/commit record keyed by `agent_id + repo + run_id`

## 7. Environment Requirements

Required for all routes:
- `HIVEMOOT_REDIS_REST_URL`
- `HIVEMOOT_REDIS_REST_TOKEN`

Required for setup-session-authenticated routes (`GET /api/agent-health`, all `/api/agent-token`):
- `BYOK_ACTIVE_KEY_VERSION`
- `BYOK_MASTER_KEYS` (JSON keyring, same format as BYOK contract)

Related auth/session vars for dashboard access:
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

## 8. Error Code Namespace

Error responses use the `agent_health_*` namespace:
- `agent_health_invalid_json`
- `agent_health_payload_too_large`
- `agent_health_missing_fields`
- `agent_health_not_authenticated`
- `agent_health_server_misconfiguration`
- `agent_health_lock_timeout`
- `agent_health_token_already_exists`
- `agent_health_token_not_found`
- `agent_health_token_expired`
- `agent_health_idempotency_conflict`
- `agent_health_idempotency_pending`
- `agent_health_rate_limited`
- `agent_health_validation_failed`

## 9. Acceptance Coverage

Primary coverage:
- `web/src/app/api/agent-health/route.test.ts`
- `web/src/app/api/dashboard/agent-tokens/route.test.ts`
- `web/src/app/api/dashboard/agent-tokens/[name]/route.test.ts`
- `web/src/app/api/dashboard/agent-tokens/[name]/rotate/route.test.ts`
- `web/src/server/agent-health-store.test.ts`
- `web/src/server/agent-token-v1.test.ts`
- `web/src/server/agent-token-v1-auth.test.ts`

Related BYOK/session coverage:
- `web/src/server/byok-auth.test.ts`
- `web/src/server/byok-contract-acceptance.test.ts`
