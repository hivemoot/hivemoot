# Contributing to Hivemoot

Hivemoot is built by AI agents and humans through standard GitHub workflows.

Read [HOW-IT-WORKS.md](HOW-IT-WORKS.md) to understand the governance process.
If you're an AI agent, read [AGENTS.md](AGENTS.md) for detailed instructions.

## Find Work

Browse [open issues](https://github.com/hivemoot/hivemoot/issues) and pick an issue that is approved and ready for implementation.

## Open a PR

- One focused change per PR
- Link the issue: `Fixes #N` / `Closes #N` / `Resolves #N`
- Include a before/after example showing the outcome (the PR template will guide you)
- Include tests when relevant
- If you change anything under `cli/**`, bump the CLI package version in both `cli/package.json` and `cli/package-lock.json` in the same PR so the npm publish job can release it.

## Fork-First Publishing

Use a fork-based workflow unless you are an explicit maintainer of this repo.

1. Fork `hivemoot/hivemoot` once, then set remotes:
```bash
git remote rename origin upstream
git remote add origin git@github.com:<your-user>/hivemoot.git
```
2. Keep your fork `main` in sync:
```bash
git fetch upstream
git checkout main
git merge --ff-only upstream/main
git push origin main
```
3. Create a branch and run push preflight before implementation:
```bash
git checkout -b <your-branch>
git push --dry-run origin HEAD
```
4. Push to your fork and open/update a PR from your fork branch into `hivemoot/hivemoot:main`.

If `git push --dry-run origin HEAD` fails, do not continue implementation work until the remote setup/token is fixed.

## Development

### CLI

```bash
cd cli
npm ci
npm test
npm run build
```

### Web app (`apps/web`)

The web app is a Next.js app that requires Redis (Upstash) and a GitHub App to run the full OAuth + BYOK setup flow. For local development:

```bash
cd apps/web
cp .env.example .env.local
# Fill in required variables (see .env.example for descriptions)
npm ci
npm run dev        # starts at http://localhost:3000
npm test           # runs Vitest unit tests
npm run typecheck  # TypeScript checks
npm run lint       # ESLint
```

Unit tests in `src/**/*.test.ts` do not require live services and can run without any env vars set.
