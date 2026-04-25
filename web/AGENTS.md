# AGENTS.md

Technical briefing for AI coding agents working in `web/` inside `hivemoot/hivemoot`.

## Project overview

Hivemoot Web is the frontend dashboard and API backend for hivemoot.dev. It's a Next.js 16 application (App Router) deploying to Vercel serverless functions, with an Upstash Redis backing store for sessions, BYOK key management, task state, and agent health reporting.

## Build and verify

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Run all checks before opening or updating a PR.

## Architecture entry points

- `src/app/`: Next.js App Router pages and API routes.
- `src/app/api/`: REST API route handlers (`route.ts` per endpoint).
- `src/app/api/auth/github/`: GitHub App OAuth flow (start, callback, start-discover).
- `src/app/api/byok/`: BYOK (Bring Your Own Key) management — config, rotate, revoke, re-encrypt, status.
- `src/app/api/tasks/`: Task lifecycle — create, claim, execute, follow-up, retry, stream.
- `src/app/api/agent-health/`: Agent health check ingestion.
- `src/app/api/agent-token/`: Installation token brokering for agent containers.
- `src/app/dashboard/`: Frontend dashboard pages (fleet, tasks, credentials).
- `src/server/`: Server-side business logic (auth, BYOK crypto, Redis store, task store).
- `src/lib/`: Shared client/server utilities (cookies).
- `src/constants/`: Shared constants (BYOK error codes, cookie names).
- `src/middleware.ts`: Next.js middleware (auth guards, session handling).

## Conventions

- Keep TypeScript strict (`strict: true` in `tsconfig.json`).
- Use the `@/` path alias for imports from `src/`.
- Co-locate tests as `*.test.ts` next to implementation files.
- API routes use Next.js App Router conventions (`route.ts` exports named `GET`, `POST`, etc.).
- ESLint uses `eslint-config-next` (core-web-vitals + typescript presets).
- Tailwind CSS for styling (`tailwind.config.ts`).

## Testing

- Test framework: Vitest (config in `vitest.config.ts`).
- Environment: Node.js (not jsdom).
- Pattern: `src/**/*.test.{ts,tsx}`.
- Run targeted tests with `npm test -- src/app/api/health/route.test.ts`.

## API contracts

- `AGENT_HEALTH_CONTRACT.md`: Agent health check API contract.
- `BYOK_CONTRACT.md`: BYOK key management contract (encryption, rotation, limits).

## Environment variables

Required env vars are documented in `.env.example`. Key categories:

- Redis: `HIVEMOOT_REDIS_REST_URL`, `HIVEMOOT_REDIS_REST_TOKEN`
- GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- BYOK: `BYOK_ACTIVE_KEY_VERSION`, `BYOK_MASTER_KEYS`
- Site: `NEXT_PUBLIC_SITE_URL`

## Deployment

- Vercel serverless deployment (config in `vercel.json`).
- `deploymentEnabled: false` — deploys are triggered explicitly, not on push.

## Security boundaries

- Do not leak internal errors, stack traces, or secrets in API responses.
- BYOK keys are encrypted at rest with versioned master keys. Never log or expose key material.
- Redis interactions must handle connection errors gracefully (see `redis.ts`).
- GitHub OAuth secrets and App private key must stay in environment variables only.
- API routes that require installation context must use `require-installation.ts`.

## Practical gotchas

- Missing `@/` alias imports will pass editing but fail at build time.
- Vercel functions have execution-time limits based on deployment settings.
- Redis errors in BYOK and task routes must be caught explicitly — they don't auto-propagate as HTTP errors.
- The `BYOK_CONTRACT.md` defines a 4 KB payload limit for BYOK config and rotate endpoints.

## Governance and PR conventions

Follow the monorepo conventions in the root `AGENTS.md` and `CONTRIBUTING.md`:

- Fork-first publishing.
- PR descriptions follow `.github/PULL_REQUEST_TEMPLATE.md`.
- Issue linking via `Fixes #N` / `Closes #N` / `Resolves #N`.
- Only implement issues labeled `hivemoot:ready-to-implement`.
