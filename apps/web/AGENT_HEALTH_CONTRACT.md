# Agent Health Contract

This document defines the current production contract for agent health ingestion and dashboard retrieval in `apps/web`.

Scope:
- API surface (`/api/agent-health`, `/api/agent-token`)
- Authentication and trust boundaries
- Payload validation and response semantics
- Redis storage layout, TTL, retention, and status derivation
- Operational requirements and acceptance coverage

This is the canonical contract for the shipped implementation and supersedes the early GitHub-user-token design discussed in issue #169.

## 1. Endpoint Summary

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/agent-health` | `Authorization: Bearer <agent-token>` | Ingest one agent run report |
| `GET /api/agent-health` | Setup session cookie | Read dashboard overview or run history |
| `POST /api/agent-token` | Setup session cookie | Generate or rotate an installation agent token |
| `GET /api/agent-token` | Setup session cookie | Retrieve current plaintext token and metadata |
| `DELETE /api/agent-token` | Setup session cookie | Revoke current token |

Auth split is intentional:
- Machine writes (`POST /api/agent-health`) use installation-scoped agent tokens.
- Human/admin reads and token lifecycle operations use setup-session auth.

## 2. POST /api/agent-health Contract

Each POST represents one run for one `agent_id` + `repo`.

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
| `trigger` | string | `scheduled` \| `mention` \| `manual` |
| `token_usage` | object or `null` | Exact nested schema below; when present as an object, required scalar fields must be present even if their value is `null` |

#### `token_usage` object shape

When `token_usage` is an object, these top-level fields are accepted:

| Field | Type | Constraints |
|---|---|---|
| `input_tokens` | integer | Required, non-negative |
| `output_tokens` | integer | Required, non-negative |
| `cache_read_input_tokens` | integer or `null` | Required, non-negative when not `null` |
| `cache_creation_input_tokens` | integer or `null` | Required, non-negative when not `null` |
| `cost_usd` | number or `null` | Required, non-negative when not `null` |
| `num_turns` | integer | Required, non-negative |
| `model_breakdown` | object or `null` | Optional; keys must match `[a-zA-Z0-9._:/-]+` |

`model_breakdown`, when present as an object, must map model ids to objects with this shape:

| Field | Type | Constraints |
|---|---|---|
| `input_tokens` | integer | Required, non-negative |
| `output_tokens` | integer | Required, non-negative |
| `cache_read_input_tokens` | integer or `null` | Required, non-negative when not `null` |
| `cache_creation_input_tokens` | integer or `null` | Required, non-negative when not `null` |
| `cost_usd` | number or `null` | Required, non-negative when not `null` |

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
- `ok`: all other successful states.

Read behavior:
- Overview is sorted by `received_at` descending.
- History is fetched newest-first and capped at 1440 entries (~24h at one report/minute).

## 5. Agent Token Contract

Token format and storage:
- Raw token is 64-char hex (32 random bytes).
- Exactly one active token per installation.
- On rotate, old token is revoked atomically.

Security model:
- Raw token is encrypted with BYOK keyring and stored at `hive:agent-token:{installationId}`.
- A SHA-256 hash reverse index is stored at `agent-token-hash:{hash}` -> `{ installationId }`.
- `POST /api/agent-health` resolves installation by hash lookup (O(1)); no GitHub `/user` call on write path.

Operational note:
- `GET /api/agent-token` intentionally returns plaintext token for admin recovery/copy flows. Treat this route as sensitive and setup-session protected.

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
- `agent_health_idempotency_conflict`
- `agent_health_idempotency_pending`
- `agent_health_rate_limited`
- `agent_health_validation_failed`

## 9. Acceptance Coverage

Primary coverage:
- `apps/web/src/app/api/agent-health/route.test.ts`
- `apps/web/src/app/api/agent-token/route.test.ts`
- `apps/web/src/server/agent-health-auth.test.ts`
- `apps/web/src/server/agent-health-store.test.ts`
- `apps/web/src/server/agent-token.test.ts`

Related BYOK/session coverage:
- `apps/web/src/server/byok-auth.test.ts`
- `apps/web/src/server/byok-contract-acceptance.test.ts`
