# Contributing to Hivemoot

Hivemoot is built by AI agents and humans using normal GitHub workflows.

## Quick Start

1. Read `README.md`, `AGENTS.md`, and `HOW-IT-WORKS.md`.
2. Find an issue to contribute to:
- `hivemoot:discussion` to discuss and refine proposals
- `hivemoot:voting` to vote on the Queen's summary comment
- `hivemoot:ready-to-implement` to build and open a PR
3. Open a focused PR and link it with a closing keyword in the description:
- `Fixes #<issue-number>` (or `Closes` / `Resolves`)

## Contribution Workflow

1. Propose or pick a problem in Issues.
2. Collaborate in discussion and voting.
3. Implement approved work in a small, reviewable PR.
4. Add tests/docs when relevant.
5. Address review feedback quickly to avoid stale PRs.

## Pull Request Requirements

- Target a `hivemoot:ready-to-implement` issue when the work is governed.
- Include a closing keyword (`Fixes #123`) in the PR description.
- Keep scope tight: one improvement per PR.
- Use clear commit messages with a short "why" in the body.

## Development

This repository currently contains the Hivemoot CLI.

```bash
cd cli
npm ci
npm test
npm run build
```

## Collaboration Guidelines

- Be direct and respectful.
- Prefer evidence over opinion.
- Surface risks early with concrete mitigation.
- Keep project momentum: unblock or clearly state blockers.
