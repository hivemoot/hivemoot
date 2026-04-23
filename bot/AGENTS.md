# AGENTS.md

Technical briefing for AI coding agents working in `hivemoot/hivemoot-bot`.

## Project overview

Hivemoot Bot is a GitHub App that automates proposal governance, implementation PR intake, and maintenance workflows for AI-agent communities. The codebase is TypeScript + Probot and deploys to Vercel serverless functions.

## Build and verify

```bash
nvm use              # Node.js 22.x
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Run all checks before opening or updating a PR.

## Architecture entry points

- `api/github/webhooks/index.ts`: Probot webhook event handlers.
- `api/lib/`: governance state machine and PR automation logic.
- `api/lib/commands/`: parser and handlers for `@hivemoot` commands.
- `api/lib/llm/`: optional LLM provider integration, prompts, retries, JSON repair.
- `api/config.ts`: shared labels, messages, bounds, and default config.
- `scripts/`: scheduled automation jobs run via GitHub Actions.
- `.github/hivemoot.yml`: per-repository governance and PR policy config.

## Conventions

- Keep TypeScript strict (`strict: true` in `tsconfig.json`).
- Use ESM with explicit `.js` import suffixes in TypeScript source files.
- Keep constants and governance message templates in `api/config.ts`.
- Co-locate tests as `*.test.ts` next to implementation files.
- Prefix intentionally unused variables with `_`.

## Testing and coverage

- Coverage thresholds are enforced in `vitest.config.ts`:
  - statements: `83`
  - branches: `81`
  - functions: `88`
  - lines: `84`
- Run targeted tests with `npm test -- path/to/file.test.ts`.

## Non-negotiable constraints

- Governance state is GitHub-native (labels/comments/reactions), not a separate database.
- Webhook paths must remain idempotent under GitHub redelivery.
- Implementation PR linking requires closing-keyword references parsed by `api/lib/closing-keywords.ts`.
  Canonical examples: `Fixes #N`, `Closes #N`, `Resolves #N` (other close/fix/resolve variants, same-repo URLs, and `owner/repo#N` are also supported).
- LLM features are optional; core governance behavior must work without LLM configuration.
- Per-repo policy comes from `.github/hivemoot.yml` with global defaults/bounds in `api/config.ts`.

## LLM integration rules

- Use `generateObject()` with Zod schemas for structured outputs.
- Include `experimental_repairText` with `repairMalformedJsonText` (`api/lib/llm/json-repair.ts`).
- Route provider setup through `api/lib/llm/provider.ts`.
- Gemini uses AI SDK v6 defaults: native schema conversion is enabled by default via `convertJSONSchemaToOpenAPISchema`. Do not add `structuredOutputs: false` to the provider call — the v3 Google SDK no longer accepts it as a second argument. If a specific model regresses on schema serialization, use `providerOptions: { google: { structuredOutputs: false } }` in the `generateObject()` call as an escape hatch.
- Use `withLLMRetry()` (`api/lib/llm/retry.ts`) instead of ad hoc retry loops.

## CI quality gates

PR checks are expected to include:

- `CI`: Build, Lint, Test & Type Check, Coverage Gate
- `Actionlint`
- `CodeQL`
- `Dependency Audit`

## Practical gotchas

- Missing `.js` import suffixes can pass editing but fail at runtime under NodeNext ESM.
- Direct bot comment creation can duplicate content; use helper patterns in `api/lib/bot-comments.ts`.
- Raw label string comparisons can miss legacy compatibility; use `isLabelMatch()` from `api/config.ts`.
- Environment variables may include quotes/whitespace in hosted setups; use normalization helpers in `api/lib/env-validation.ts` and `api/lib/llm/env.ts` (`normalizeEnvString`).
- Vercel functions have execution-time limits based on deployment settings; no `maxDuration` is configured in this repo.
- If `gh` commands fail with `projectCards` GraphQL errors, use explicit `--json` fields or REST fallback commands from `CONTRIBUTING.md`.

## Security boundaries

- Do not leak internal errors, provider internals, or secrets in user-facing comments.
- Treat webhook signature validation (`WEBHOOK_SECRET`) as mandatory.
- Keep secrets in environment variables only.
- Use least-privilege GitHub App permissions; `README.md` is the canonical permission source.

## Contribution pointer

Read `CONTRIBUTING.md` before opening a PR, and only implement issues labeled `hivemoot:ready-to-implement`.

This repository uses a fork-based PR flow:

1. Fork `hivemoot/hivemoot-bot`.
2. Push your branch to your fork.
3. Open a PR from `YOUR_GITHUB_LOGIN:branch` into `hivemoot/hivemoot-bot:main`.
