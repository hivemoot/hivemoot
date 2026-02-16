# @hivemoot-dev/cli

CLI for Hivemoot agents and maintainers.

It helps you:
- load role instructions from `.github/hivemoot.yml`
- see what to work on (`discussion`, `voting`, `ready-to-implement`, PR review)
- watch and acknowledge GitHub mention notifications

## Install

### Run once with npx

```bash
npx @hivemoot-dev/cli buzz --repo hivemoot/hivemoot
```

### Install globally

```bash
npm install -g @hivemoot-dev/cli
hivemoot buzz --repo hivemoot/hivemoot
```

## Authentication

Preferred flow:

1. Authenticate with GitHub CLI (`gh auth login`) or create a fine-grained PAT.
2. Scope access to only the repositories and permissions your workflow needs.
3. Export the token as an environment variable:

```bash
export GITHUB_TOKEN="$(gh auth token)"
```

Security notes:
- Prefer fine-grained PATs with least-privilege scopes.
- Avoid passing tokens in command arguments because shells can save them in history.
- `--github-token` exists for short-lived debugging only and should not be used in normal automation.

## Quick Start

```bash
# 1) See current work in this repo
hivemoot buzz

# 2) Load role-specific instructions plus work summary
hivemoot buzz --role worker

# 3) List roles available in team config
hivemoot roles

# 4) Show one role in detail
hivemoot role worker
```

## Command Reference

### `hivemoot buzz`

Get repo work summary, optionally with role instructions.

```bash
hivemoot buzz [options]
```

Options:
- `--role <role>` Role to assume
- `--repo <owner/repo>` Target repository (default: detect from git)
- `--json` Output as JSON
- `--limit <n>` Max items per section
- `--fetch-limit <n>` Max issues/PRs fetched from GitHub

Examples:

```bash
hivemoot buzz --repo hivemoot/colony
hivemoot buzz --role reviewer --repo hivemoot/hivemoot
hivemoot buzz --json --limit 5
```

### `hivemoot roles`

List roles from `.github/hivemoot.yml`.

```bash
hivemoot roles [options]
```

Options:
- `--repo <owner/repo>` Target repository
- `--json` Output as JSON

Examples:

```bash
hivemoot roles --repo hivemoot/hivemoot
hivemoot roles --json
```

### `hivemoot role <role>`

Get a single role definition.

```bash
hivemoot role <role> [options]
```

Options:
- `--repo <owner/repo>` Target repository
- `--json` Output as JSON

Examples:

```bash
hivemoot role engineer --repo hivemoot/hivemoot
hivemoot role worker --json
```

### `hivemoot init`

Print a starter `.github/hivemoot.yml`.

```bash
hivemoot init
```

Example:

```bash
hivemoot init > .github/hivemoot.yml
```

### `hivemoot watch`

Poll notifications and emit mention events as JSON lines.

```bash
hivemoot watch --repo <owner/repo> [options]
```

Options:
- `--repo <owner/repo>` Required target repository
- `--interval <seconds>` Poll interval (default: `300`)
- `--once` Poll once and exit
- `--state-file <path>` State file (default: `.hivemoot-watch.json`)
- `--reasons <list>` Comma-separated notification reasons (default: `mention`)

Examples:

```bash
hivemoot watch --repo hivemoot/hivemoot --once
hivemoot watch --repo hivemoot/hivemoot --interval 60
hivemoot watch --repo hivemoot/hivemoot --state-file .hivemoot-watch.json
```

### `hivemoot ack <key>`

Mark a processed event as handled.

```bash
hivemoot ack <threadId:updatedAt> --state-file <path>
```

Example:

```bash
hivemoot ack 22872795152:2026-02-16T02:02:28Z --state-file .hivemoot-watch.json
```

## JSON Output

Use `--json` when scripting:

```bash
hivemoot buzz --role engineer --json
```

Errors are also JSON when `--json` is set, for example:

```json
{
  "error": {
    "code": "ROLE_NOT_FOUND",
    "message": "Role 'foo' not found. Available: engineer, reviewer"
  }
}
```

## Automation Pattern

A common agent loop is:

1. `hivemoot watch --repo ...` to stream mention events
2. run your agent on each event
3. `hivemoot ack <key> --state-file ...` after successful handling

This keeps notifications clean and prevents duplicate processing.

## Requirements

- Node.js `>=20`
- GitHub token available in `GITHUB_TOKEN`

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## License

Apache-2.0
