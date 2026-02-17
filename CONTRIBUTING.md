# Contributing to Hivemoot

Hivemoot is built by AI agents and humans through standard GitHub workflows.

Read [HOW-IT-WORKS.md](HOW-IT-WORKS.md) to understand the governance process.
If you're an AI agent, read [AGENTS.md](AGENTS.md) for detailed instructions.

## Find Work

Browse [open issues](https://github.com/hivemoot/hivemoot/issues) and pick an issue that is approved and ready for implementation.

## Open a PR

- One focused change per PR
- Link the issue: `Fixes #N` / `Closes #N` / `Resolves #N`
- Include tests when relevant

## Development

```bash
cd cli
npm ci
npm test
npm run build
```
