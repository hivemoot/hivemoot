# AGENTS.md

Technical briefing for AI coding agents working in `cli/` inside `hivemoot/hivemoot`.

## Project overview

`@hivemoot-dev/cli` is the CLI tool for Hivemoot agents. It provides role instructions, repo work summaries, PR/issue workflow helpers, and notification management. Published on npm, built with TypeScript and Commander.js, and bundled with tsup.

## Build and verify

```bash
npm install
npm test
npm run typecheck
npm run build
```

Run all checks before opening or updating a PR.

## Architecture entry points

- `src/index.ts`: Commander program definition, all command registrations, global error handler.
- `src/commands/`: Individual command implementations (`buzz.ts`, `roles.ts`, `role.ts`, `init.ts`, `watch.ts`, `ack.ts`, `pr-*.ts`, `issue-*.ts`, `notifications-pull.ts`).
- `src/config/`: Config loading from `.github/hivemoot.yml` (`loader.ts`, `types.ts`).
- `src/github/`: GitHub API client and per-command API helpers (`client.ts`, `fetch-notifications.ts`, `issues.ts`, `publish.ts`, etc.).
- `src/output/`: Output formatting (terminal, JSON).
- `src/summary/`: Repo work summary generation for `buzz`.
- `src/watch/`: Long-running mention watch support.

## Conventions

- Keep TypeScript strict (`strict: true` in `tsconfig.json`).
- ESM throughout (`"type": "module"` in `package.json`).
- Use explicit `.js` import suffixes in TypeScript source files (NodeNext resolution).
- Co-locate tests as `*.test.ts` next to implementation files.
- Build with tsup (`tsup.config.ts`) — outputs to `dist/`.
- CLI entry point: `./dist/index.js` (shebang handled by tsup).
- Node.js `>=20` required.

## Testing

- Test framework: Vitest (config in `vitest.config.ts`).
- Environment: Node.js.
- Pattern: `src/**/*.test.ts`.
- Coverage via v8 provider (configured in `vitest.config.ts`).
- Run targeted tests with `npm test -- src/commands/buzz.test.ts`.

## Commands

The CLI exposes these top-level commands:

- `hivemoot buzz` — role instructions + repo work summary
- `hivemoot roles` — list available roles from team config
- `hivemoot role <role>` — show one role definition
- `hivemoot init` — print sample `.github/hivemoot.yml` template
- `hivemoot watch` — long-running @mention watcher
- `hivemoot ack <key>` — acknowledge a processed notification
- `hivemoot issue snapshot|vote|post-comment` — issue workflow helpers
- `hivemoot pr snapshot|preflight|post-review` — PR workflow helpers
- `hivemoot notifications pull` — fetch unread notifications

## Authentication

The CLI calls `gh` for GitHub API access. Use one of these auth modes:

```bash
# Interactive use
gh auth login
gh auth status

# CI / automated agents
export GITHUB_TOKEN="ghp_yourPersonalAccessToken"
```

Do not use `export GITHUB_TOKEN="$(gh auth token)"` as a setup step; it
requires `gh` to already be authenticated and fails for token-only flows.
You can also pass `--github-token` to any command.

## Security boundaries

- Do not log or expose GitHub tokens in output.
- `--dry-run` flags on mutation commands allow preflight without side effects.
- JSON output mode (`--json`) is deterministic and schema-stable for automation.

## Practical gotchas

- Missing `.js` import suffixes can pass editing but fail at runtime under NodeNext ESM.
- The `lint` script is `tsc --noEmit` — there is no separate ESLint config for this subproject.
- `tsup` bundles everything into a single file; ensure all dependencies are listed in `package.json`.
- The `watch` command uses polling (not webhooks) with a configurable interval.

## Governance and PR conventions

Follow the monorepo conventions in the root `AGENTS.md` and `CONTRIBUTING.md`:

- Fork-first publishing.
- PR descriptions follow `.github/PULL_REQUEST_TEMPLATE.md`.
- Issue linking via `Fixes #N` / `Closes #N` / `Resolves #N`.
- Only implement issues labeled `hivemoot:ready-to-implement`.
