# Task API Contract

This document defines the current production contract for agent task management in `apps/web`.

Scope:
- API surface for task creation, execution, and status transitions
- Authentication and trust boundaries
- Request and response payload validation
- Redis storage layout, TTLs, and lifecycle rules
- Status machine and valid transitions
- Error code namespace and semantics
- Acceptance coverage

This is the canonical contract for the shipped implementation and represents the state of `main` as of the document's commit date. Proposed extensions are noted at the end by issue reference.

---

## 1. Endpoint Summary

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/tasks/create` | Setup session cookie (same-origin only) | Create a new pending task |
| `GET /api/tasks` | Setup session cookie | List tasks for the installation |
| `POST /api/tasks/claim` | Bearer executor token | Claim the next pending task |
| `GET /api/tasks/{taskId}` | Setup session cookie | Read a single task record |
| `DELETE /api/tasks/{taskId}` | Setup session cookie | Delete a task in a terminal state or `pending` |
| `POST /api/tasks/{taskId}/execute` | Bearer executor token + claim token | Report progress, complete, fail, timeout, heartbeat, or request follow-up |
| `POST /api/tasks/{taskId}/follow-up` | Setup session cookie | Submit follow-up message to a paused task |
| `POST /api/tasks/{taskId}/retry` | Setup session cookie | Retry a `failed` or `timed_out` task |
| `GET /api/tasks/{taskId}/messages` | Setup session cookie | Retrieve task message history |
| `POST /api/tasks/{taskId}/messages` | Setup session cookie | Append a message to task message history |
| `GET /api/tasks/{taskId}/stream` | Setup session cookie | SSE stream for real-time task events |

**Auth split:**
- Machine writes (claim, execute) use installation-scoped executor bearer tokens.
- Human/dashboard reads and mutations (create, list, get, delete, follow-up, retry, messages, stream) use setup-session auth.
- The `POST /api/tasks/create` endpoint additionally requires same-origin requests (`Origin` header must match the app's own origin or be absent).

---

## 2. TaskRecord Schema (Public API Type)

`TaskRecord` is the public task representation returned to callers. All fields use **snake_case**.

| Field | Type | Notes |
|---|---|---|
| `task_id` | `string` | 24-char hex (`/^[a-f0-9]{24}$/`), 12 random bytes as hex |
| `status` | `TaskStatus` | See status machine below |
| `prompt` | `string` | Max 8,000 chars |
| `repos` | `string[]` | Max 10 entries; each must match `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/` |
| `timeout_secs` | `number` | Integer, 1–600, default 300 |
| `created_by` | `string` | GitHub user login of the task creator |
| `created_at` | `string` | ISO 8601 timestamp |
| `updated_at` | `string` | ISO 8601 timestamp, updated on every state transition |
| `started_at?` | `string` | ISO 8601, set when an agent first claims the task |
| `finished_at?` | `string` | ISO 8601, set on terminal transition |
| `error?` | `string` | Error message, present when `status` is `failed` or `timed_out` |
| `progress?` | `string` | Latest progress text from the executor; **not stored in the task hash** (see Redis layout) |
### StoredTaskRecord (Internal)

`StoredTaskRecord` is the type persisted to Redis. It differs from `TaskRecord` in that it never contains `progress` (which lives in a separate Redis key).

Field naming convention: snake_case throughout, matching all existing `TaskRecord` fields.

---

## 3. Status Machine

```
pending  ──claim──►  running  ──complete──►   completed  (terminal)
                  │          ──fail──────►   failed      (terminal)
                  │          ──timeout───►   timed_out   (terminal)
                  │          ──request_follow_up──►  needs_follow_up
                  │
                  └──timeout (auto-timeout)──►  timed_out  (terminal)

needs_follow_up  ──follow-up──►  running
```

**Terminal states:** `completed`, `failed`, `timed_out`

**Retry:** Only `failed` and `timed_out` tasks can be retried via `POST /api/tasks/{taskId}/retry`. `completed` tasks cannot be retried. Retry resets the status to `pending` and clears `started_at`, `finished_at`, and `error`.

**Auto-timeout:** Running tasks that exceed `timeout_secs` without a heartbeat transition to `timed_out` automatically. Tasks in `needs_follow_up` are **exempt** from auto-timeout.

**Concurrency limit:** At most `MAX_CONCURRENT_TASKS = 3` tasks per installation can be in non-terminal, non-`needs_follow_up` states simultaneously.

---

## 4. TTLs and Retention

| State | TTL |
|---|---|
| `completed` | 7 days (`COMPLETED_TASK_TTL_SECONDS`) |
| `failed` | 24 hours (`FAILED_TASK_TTL_SECONDS`) |
| `timed_out` | 24 hours (`FAILED_TASK_TTL_SECONDS`) |

TTLs apply to the task hash, progress key, messages list, and claim-token hash together — all keys for a task share the same TTL applied at terminal transition.

**Progress key:** `task:{installationId}:{taskId}:progress` is set to the final progress text at terminal transition and expires with the task TTL. It is not deleted at terminal transition — it persists until the task TTL expires.

---

## 5. Create Task Contract

**Auth:** Setup session cookie (BYOK-authenticated). Same-origin requests only.

**Rate limit:** 10 create requests per installation + user per minute.

**Request body:**

| Field | Type | Constraints |
|---|---|---|
| `prompt` | `string` | Required, max 8,000 chars |
| `repos` | `string[]` | Required, 1–10 entries, each matching `owner/name` pattern |
| `timeout_secs` | `number` | Optional, integer 1–600, default 300 |

**Responses:**
- `202` + `{ "task_id": string, "status": TaskStatus, "timeout_secs": number, "stream_url": string, "task": TaskRecord }` — task created
- `403` `task_repo_unavailable` — one or more repos in `repos` could not be accessed via the installation's GitHub App token
- `429` `task_rate_limited` + `{ "retry_after_secs": N }` — rate limit exceeded
- `429` `task_concurrency_limited` — concurrency cap reached

---

## 6. Claim Task Contract

**Auth:** Bearer executor token.

**Request:** `POST /api/tasks/claim` — no body required.

**Responses:**
- `204` — no pending tasks available
- `200` + `{ "task": TaskRecord, "claim_token": string, "messages": TaskMessage[], "messagesError": boolean }` — task claimed

The `claim_token` is a 64-char hex secret (32 random bytes) that must be passed as `x-task-claim-token` in all subsequent execute calls for this task.

`messagesError: true` signals that message history could not be fetched. The agent should proceed without prior context.

---

## 7. Execute Task Contract

**Auth:** Bearer executor token + `x-task-claim-token` header.

**Request body:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | `string` | Yes | One of: `progress`, `complete`, `fail`, `timeout`, `heartbeat`, `request_follow_up` |
| `progress` | `string` | For `progress` | Progress text, max 400 chars after trim |
| `result` | `string` | For `complete` | Completion summary, max 128,000 chars |
| `error` | `string` | For `fail` | Error description, max 400 chars after trim |
| `exit_code` | `number` | Optional with `fail` | Integer exit code from the executor process; included in the error message |
| `executor_outcome` | `string` | Optional with `complete` | One of: `success`, `auth_failed`, `runtime_failed`, `timeout` — non-success outcomes force the action to `fail` |

**Responses:**
- `200` + `{ "task": TaskRecord }` — transition applied
- `409` `task_invalid_transition` — action not valid from current status
- `429` `task_lock_timeout` — lock contention, retry shortly
- `404` `task_not_found` — task missing or TTL expired

---

## 8. Follow-Up Contract

**Auth:** Setup session cookie.

**Request body:** `{ "message": string }` — message appended to the conversation. Task must be in `needs_follow_up` status; transitions to `running`.

---

## 9. Retry Contract

**Auth:** Setup session cookie.

**Request:** `POST /api/tasks/{taskId}/retry` — no body.

Task must be in `failed` or `timed_out` status. `completed` tasks cannot be retried. Retry:
- Resets `status` to `pending`
- Clears `started_at`, `finished_at`, `error`
- Removes the task from the running set and re-queues it to pending

**Response:** `202` + `{ "task_id": string, "status": TaskStatus, "timeout_secs": number, "stream_url": string, "task": TaskRecord }` — same envelope as the create response; the task is now `pending` and will be picked up by the next claim.

---

## 10. Redis Key Layout

| Key | Type | Content | Notes |
|---|---|---|---|
| `task:{installationId}:{taskId}` | Hash (JSON) | `StoredTaskRecord` | Task record, no progress field |
| `task:{installationId}:{taskId}:progress` | String | Latest progress text | Set to final progress at terminal transition; expires with the task TTL |
| `task:{installationId}:{taskId}:messages` | List | JSON-serialized `TaskMessage[]` | Append via `rpush`; max 200 entries |
| `task:{installationId}:{taskId}:claim-token-hash` | String | SHA-256 of claim token | Deleted after task claim is verified |
| `tasks:pending:{installationId}` | Sorted Set | Members = `taskId`, score = creation timestamp ms | Pending queue |
| `tasks:running:{installationId}` | Sorted Set | Members = `taskId`, score = addition timestamp ms | Running set for concurrency enforcement |
| `tasks:recent:{installationId}` | Sorted Set | Members = `taskId`, score = `updated_at` ms | Recent completed/failed tasks |
| `tasks:create-ratelimit:{installationId}:{userId}:{minuteBucket}` | String | Counter | Rate limit, 60s TTL |

---

## 11. Error Code Namespace

All error responses follow `{ "code": string, "message": string }`. Task routes use the `task_*` namespace:

| Code | HTTP | Meaning |
|---|---|---|
| `task_invalid_json` | 400 | Malformed JSON body |
| `task_payload_too_large` | 413 | Body exceeds size limit |
| `task_validation_failed` | 400/409/422 | Schema or semantic validation failure |
| `task_missing_fields` | 400 | Required field absent |
| `task_invalid_action` | 400 | Unknown execute action |
| `task_invalid_transition` | 409 | State machine constraint violated |
| `task_invalid_task_id` | 400 | `taskId` path param does not match `[a-f0-9]{24}` |
| `task_not_authenticated` | 401 | Missing or invalid auth |
| `task_forbidden` | 403 | Valid auth, insufficient permission |
| `task_repo_unavailable` | 403 | One or more task repos could not be accessed via the GitHub App token |
| `task_not_found` | 404 | Task not found or TTL expired |
| `task_rate_limited` | 429 | Create rate limit exceeded; includes `retry_after_secs` |
| `task_concurrency_limited` | 429 | Installation concurrency cap reached |
| `task_lock_timeout` | 429 | Lock contention on state mutation; retry shortly |
| `task_follow_up_not_allowed` | 409 | Follow-up attempted on non-`needs_follow_up` task |
| `task_server_error` | 500/429 | Unexpected server error |

---

## 12. Environment Requirements

All task routes require:
- `HIVEMOOT_REDIS_REST_URL`
- `HIVEMOOT_REDIS_REST_TOKEN`

Setup-session routes additionally require:
- `BYOK_ACTIVE_KEY_VERSION`
- `BYOK_MASTER_KEYS`
- GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`)

Executor-auth routes require:
- The installation's executor token (provisioned via `/api/agent-token`; see `AGENT_HEALTH_CONTRACT.md`)

---

## 13. Acceptance Coverage

| File | Covers |
|---|---|
| `src/server/task-store.test.ts` | Store-level state transitions, concurrency, TTLs |
| `src/app/api/tasks/create/route.test.ts` | Create endpoint validation, auth, rate limit |
| `src/app/api/tasks/route.test.ts` | List endpoint |
| `src/app/api/tasks/[taskId]/route.test.ts` | Get and delete endpoints |
| `src/app/api/tasks/claim/route.test.ts` | Claim endpoint, 204 when queue empty |
| `src/app/api/tasks/[taskId]/execute/route.test.ts` | All execute actions, executor_outcome guard, lock timeout |
| `src/app/api/tasks/[taskId]/follow-up/route.test.ts` | Follow-up validation and transition |
| `src/app/api/tasks/[taskId]/retry/route.test.ts` | Retry from failed/timed_out states |
| `src/app/api/tasks/[taskId]/messages/route.test.ts` | Message history retrieval and append |

---

## 14. Proposed Extensions

The following issues are in progress and will modify this contract when merged:

| Issue | Change |
|---|---|
| [#332](https://github.com/hivemoot/hivemoot/issues/332) | `artifacts?` field on `TaskRecord`; `POST /api/tasks/{taskId}/artifacts` endpoint; `task:{id}:artifacts` Redis key |
| [#315](https://github.com/hivemoot/hivemoot/issues/315) | `target_role` field on task creation; role-targeted claim filtering |
| [#322](https://github.com/hivemoot/hivemoot/issues/322) | `archived` status and archive/unarchive endpoints |
| [#356](https://github.com/hivemoot/hivemoot/issues/356) | `POST /api/tasks/delegate` (agent-to-agent); adds `parent_task_id`, `delegation_depth`, `target_role` to `TaskRecord` |
| [#361](https://github.com/hivemoot/hivemoot/issues/361) | `withApiRoute` wrapper for consistent error handling across all task routes |

When any of the above merges, the corresponding section of this document should be updated in the same PR.
