# Fleet: plugin-first agent model (unified refactor)

## Why
The dashboard "agent" model over-applied the concept of **repo**: it was a top-level
agent field, it was forced onto the linked capability token (a dead end — the dashboard
can't issue repo-scoped tokens), and it tagged every health report. This refactor makes
the dashboard mirror the runtime's real shape — **plugins** — so `repo` exists only where
it's actually earned, and health becomes a per-agent signal.

## Core model
An agent =
- **Identity** — `name`, `display_name?`
- **Engine** — which model/tool runs it (existing engine catalog)
- **Token** (`agent_token_name`) — the capability bearer it acts through (CAPABILITIES ONLY;
  no repo scoping). Validated to EXIST; never minted/mutated here.
- **Plugins** — the enableable capabilities, each with its own config + triggers
- **Skills** — knowledge it applies (orthogonal to plugins; existing builtin catalog)
- **System prompt**

`repo` is NOT a top-level field, NOT on the token, NOT on health. It lives in exactly one
place: **`plugins.github.repos`**.

## Plugin catalog (enableable, user-facing)
| Plugin | Config (incl. its triggers) | Repos? |
|---|---|---|
| `github` | `repos: string[]`, `watch_new_prs`, `watch_review_requests`, `watch_mentions`, `watch_new_prs_authors?: string[]`, `poll_interval_secs` | **YES — here only** |
| `schedule` | `interval_secs`, `jitter_secs`, `prompt` | no |
| `tasks` | (none in v1 — claims from the dashboard queue) | no |
| `war_rooms` | `contribute: bool` | no |

**Hidden plumbing (always-on, NOT in the UI, NOT user-configurable):** health (now
per-agent, no repo), the apiarist token-broker, `github_workflows`.

## Data model — `FleetAgent` (web/src/server/fleet-store.ts)
Replace `repos` + `triggers` with `plugins`:
```ts
interface FleetPlugins {
  github?:    { enabled: boolean; repos: string[]; watch_new_prs: boolean;
                watch_review_requests: boolean; watch_mentions: boolean;
                watch_new_prs_authors?: string[]; poll_interval_secs: number };
  schedule?:  { enabled: boolean; interval_secs: number; jitter_secs: number; prompt: string };
  tasks?:     { enabled: boolean };
  war_rooms?: { enabled: boolean; contribute: boolean };
}
interface FleetAgent {
  name: string; display_name?: string;
  engine: string; skills: string[]; system_prompt: string;
  plugins: FleetPlugins;
  enabled: boolean; managed: boolean; agent_token_name: string;
  created_at: string; created_by: string; updated_at: string; config_version: number;
}
```
- **No `repos`, no `duty`, no `triggers` at the top level.**
- Redis keys unchanged (`hive:v1:fleet:*`). **The registry is currently EMPTY (no agent
  records exist) → no data migration needed**; the parser only needs to read the new shape.
- `config_version` bump.

### Validation (validateCreateAgentInput / patch validator)
- At least ONE plugin enabled (an agent with no plugins does nothing) → else VALIDATION.
- `github.enabled` ⇒ `repos` non-empty, each `validateRepo` ok AND covered by the
  installation (see resolver). At least one of the three watch flags true → else VALIDATION
  (a github plugin that watches nothing has no trigger).
- `schedule.enabled` ⇒ `interval_secs` clamped `[300, 604800]`, `jitter_secs` `[0, 3600]`,
  `prompt` non-empty.
- `poll_interval_secs` clamped `[30, 3600]`.
- `war_rooms.enabled` ⇒ `contribute` boolean.
- Queen war-room *creation/synthesis* is still NOT issuable here (war_rooms = participate only).
- `agent_token_name` required + `NAME_REGEX`.

## Repos resolution (web/src/server/fleet-routes.ts)
- Keep the salvaged `web/src/server/github-installation-repos.ts` → `listInstallationRepos`
  (mint install-wide token → paginate `GET /installation/repositories`, 60s cache,
  fail-closed `InstallationReposError`).
- `validateLinkedToken(installationId, tokenName, redis)` — existence ONLY (INVALID_TOKEN if
  missing). NO repo scoping. (Replaces `resolveTokenRepos`; remove `TOKEN_NOT_SCOPED`.)
- `resolveGithubRepos(installationId, requested?: string[])` — used ONLY when `github.enabled`:
  - `installed = await listInstallationRepos(...)` → fail-closed 503 `REPOS_UNAVAILABLE`.
  - `installed.length === 0` → 400 `REPO_NOT_COVERED`.
  - `requested` non-empty ⇒ each `validateRepo` (else VALIDATION) AND ∈ `installed`
    (case-insensitive, return canonical casing; else `REPO_NOT_COVERED`).
  - else ⇒ all `installed` (default).
- FLEET_ERROR: drop `TOKEN_NOT_SCOPED`; add `REPOS_UNAVAILABLE`. Keep `INVALID_TOKEN`,
  `REPO_NOT_COVERED`, `VALIDATION`, etc.

## Capability gate (soft, non-blocking)
The token gates which plugins *work*: `tasks` needs `tasks.claim`; `war_rooms` needs
`rooms.watch`+`rooms.read`+`rooms.contribute`. The backend does NOT reject on mismatch (the
token is independent); the **UI shows a soft ⚠ warning**. Expose the token's capabilities to
the form (it already fetches `/api/dashboard/agent-tokens`).

## Routes
- `POST /api/dashboard/fleet/agents` — rate-limit → validate (plugins shape) →
  `validateLinkedToken` → if `github.enabled`: `resolveGithubRepos` and write resolved repos
  into `plugins.github.repos` → cap → `createAgent`. installationId from session only.
- `PATCH …/agents/[name]` — re-link token → `validateLinkedToken`; `plugins.github` change →
  `resolveGithubRepos`. Foreign name → 404. requireFresh.
- `GET …/agents` — list + per-agent health join (health is per-agent now) + observed.
- `GET …/agents/[name]` — config + runs (single `getHistory(agentId)`, no per-repo fan-out).
- `GET …/fleet/meta` — `skills_catalog`, `engine_catalog`, `installation_repos` (best-effort
  `[]` on lister failure — UI pre-fill for the github repos picker).

## Desired-state contract (web/src/app/api/fleet/desired-state/route.ts)
Ship `plugins` (the canonical shape above) instead of `triggers`+`repos`. Per agent:
```jsonc
{ "name": "...", "enabled": true, "managed": true, "config_version": N,
  "engine": { ... resolved ... }, "skills": [...], "system_prompt": "...",
  "plugins": { "github": {...}, "schedule": {...}, "tasks": {...}, "war_rooms": {...} },
  "token": { "name": "...", "agent_role": "..." } }
```
- Disabled agents still LISTED (reconciler stops them); deleted ABSENT.
- ETag folds the contract version (bump it).

## Reconciler — near passthrough (apiarist/)
- `client.py` `_parse_*` → parse `plugins` (validate types, fail-closed). Drop the
  `repos`/`triggers` parsing. Agent name still re-validated at the trust boundary.
- `models.py` `DesiredAgent` → carry `plugins` (typed). Drop top-level `repos`.
- `render.py` → emit `hivemoot.yaml` from `plugins` directly (passthrough), PLUS always-on
  plumbing: `hivemoot.health` (NO repo), `hivemoot.apiarist` (broker; its `repo` =
  `plugins.github.repos[0]` when github enabled, else OMIT — task-only agents mint per-task),
  `github_workflows`. The `github` plugin block is emitted only when `plugins.github.enabled`;
  `cron` only when `plugins.schedule.enabled`; `tasks`/`war_rooms` likewise.
- `RenderedContainer.repo` (the `dev.hivemoot.repo` Docker label) = `plugins.github.repos[0]`
  if github enabled else `""`/omit (label-only; safe to be empty).
- Reconciler stays OFF by default (no live-fleet impact on merge).

## Health → per-agent (drop repo entirely)
Folded into this refactor (separate stage):
- **agent/** `plugins_builtin/hivemoot/health/{api.py,trigger.py}` + `config.py` + `__init__.py`:
  remove `repo` from heartbeat + run-report payloads; remove `HivemootHealthConfig.repo` and
  `_resolve_health_repo()`.
- **apiarist/render.py**: `hivemoot.health` block has NO `repo` (already covered above).
- **web/agent-health-store.ts**: drop `repo` from `HealthReport`/`HeartbeatPayload`/
  `HealthOverviewEntry`; key constructors drop the `:{repo}` segment
  (`latest`/`runs`/`ratelimit`); idempotency hash = `agentId\0runId`; index members = `agentId`.
  `getOverview` returns one row per agent; **self-heal** stale `agentId:repo` index members
  (SREM on unparseable/expired). `getHistory(installationId, agentId, redis)` — no repo arg.
- **web/api/agent-health/route.ts**: `repo` no longer required/validated (ingest tolerant —
  ignore if present so still-running static agents don't 400 during rollout); history GET =
  `?agent_id=X` only.
- **Dashboard**: remove the "By Repo" grouping mode; observed card drops the repo label →
  show last-seen; `ObservedAgent` drops `repo`; detail Runs tab = single `getHistory`.

## UI (web/src/app/dashboard/agents/)
Plugin-first config form:
```
Identity (name, display)   Engine [▾]   Acts as [ token ▾ ]
PLUGINS — enable + configure
  ☐ GitHub      repos [✓ all installed, narrowable]  watches: ☐new PRs ☐review-req ☐mentions  poll [90s]
  ☐ Schedule    every [6h] jitter [10m]  prompt [textarea]
  ☐ Tasks       (claims from the queue)
  ☐ War Rooms   ☐ contribute
SKILLS  [builtin checkbox grid]
SYSTEM PROMPT [textarea]
ⓘ token capabilities + ⚠ soft warnings when an enabled plugin needs a capability the token lacks
```
- Repos picker appears ONLY under GitHub (sourced from `meta.installation_repos`, all-checked default).
- Reuse existing Tailwind tokens + form primitives. Update `types.ts`, `AgentsList`, `AgentDetail`,
  `capabilities.ts` to the plugins shape.

## Build stages (each: implement → `tsc`+lint+test+build / ruff+mypy+pytest → review → fix)
1. **Backend data model** — fleet-store (plugins), fleet-routes (validateLinkedToken,
   resolveGithubRepos), routes, desired-state (plugins), meta. + salvaged lister. Tests.
2. **Reconciler passthrough** — client/models/render emit from plugins; broker/label repo from
   github; health block no repo. Tests (golden render, _parse negatives).
3. **Agent runtime health** — drop repo from payload/config/trigger. Tests.
4. **Backend health store** — drop repo from keys/types/getHistory/ingest; index self-heal. Tests.
5. **Dashboard UI** — plugin-first form, skills, capability warnings, health views drop repo. Tests.
6. **Integrated adversarial review** (IDOR/tenant-isolation, fail-closed, contract drift web↔apiarist,
   type-design, test-coverage) → fix → deploy → recreate the fleet.

## Security invariants (every stage)
- `installationId` only from the authenticated session/principal — never body/query/path.
- Foreign agent name → 404 (no cross-tenant oracle). requireFresh on mutations.
- Repo resolution fail-closed (fetch failure → 503, no agent created; never default to "all").
- All repo strings `validateRepo` before use; install token server-side only, never logged.
- Desired-state: only the caller's installation roster; token NAMES only; no secrets.
