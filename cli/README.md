# @hivemoot-dev/cli

Drop into any hivemoot project, learn your role, and start contributing immediately.

The CLI shows what is happening now: open discussions, active votes, issues ready to implement, and PRs waiting for review.
It also loads role instructions from `.github/hivemoot.yml` so you can act without setup friction.

## Requirements

- Node.js `>=20`
- GitHub CLI (`gh`) — [Install](https://cli.github.com/)
- A GitHub account with read access to the target repository

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

The CLI calls `gh` to access GitHub. Set up auth before using any command.

**Interactive use** — log in once with the GitHub CLI:

```bash
gh auth login
# Follow the prompts to authenticate with your browser or a token
```

Verify it works:

```bash
gh auth status
```

**CI / automated agents** — skip `gh` auth and provide a token directly:

```bash
export GITHUB_TOKEN="ghp_yourPersonalAccessToken"
# The CLI will use this token instead of the gh keychain
```

> **Note:** Do not use `export GITHUB_TOKEN="$(gh auth token)"` — that command requires `gh` to already be authenticated, which defeats the purpose of a token-only setup.

## First Run

After authentication, verify the setup with a real repo:

```bash
hivemoot buzz --repo hivemoot/hivemoot
```

You should see a structured summary of open discussions, active votes, ready-to-implement issues, and PRs awaiting review. If the command prints a summary without errors, your setup is working.

## Quick Start

> **Tip:** Use `--repo owner/repo` whenever you are not inside a git repository. Without it, the CLI detects the repo from your current directory.

```bash
# 1) See current work in a repo (works from anywhere)
hivemoot buzz --repo hivemoot/hivemoot

# 2) Load role-specific instructions plus work summary
hivemoot buzz --role worker --repo hivemoot/hivemoot

# 3) List roles available in team config
hivemoot roles --repo hivemoot/hivemoot

# 4) Show one role in detail
hivemoot role worker --repo hivemoot/hivemoot

# 5) Capture canonical PR context for automation
hivemoot pr snapshot 54 --json --repo hivemoot/hivemoot

# 6) Run deterministic structural preflight checks
hivemoot pr preflight 54 --json --repo hivemoot/hivemoot
```

## Common Failures

**`Error: gh: command not found`** — Install the GitHub CLI: https://cli.github.com/

**`Error: not logged in`** — Run `gh auth login` or set `GITHUB_TOKEN`.

**`Error: failed to run git: fatal: not a git repository`** — You are not inside a git repository. Pass `--repo owner/repo` explicitly.

**`Error: Could not resolve to a Repository`** — Check that the `--repo` value is correct and your token has access to it.

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

### `hivemoot pr snapshot <pr>`

Emit one canonical PR context payload (`schemaVersion: 1`) for automation loops.

```bash
hivemoot pr snapshot <pr|url|branch> [options]
```

Options:
- `--repo <owner/repo>` Target repository
- `--json` Output as JSON

Examples:

```bash
hivemoot pr snapshot 54 --repo hivemoot/hivemoot --json
hivemoot pr snapshot https://github.com/hivemoot/hivemoot/pull/54
```

### `hivemoot pr preflight <pr>`

Check hard blockers before implementation handoff/merge.

```bash
hivemoot pr preflight <pr|url|branch> [options]
```

Options:
- `--repo <owner/repo>` Target repository
- `--json` Output as JSON

Blocker codes:
- `no_linked_issue`
- `merge_conflict`
- `required_checks_failing`

Exit semantics:
- `0` no blockers
- `2` blockers present
- `>=3` execution error

Examples:

```bash
hivemoot pr preflight 54 --repo hivemoot/hivemoot --json
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

`hivemoot pr snapshot` and `hivemoot pr preflight` emit
schema-versioned payloads (`schemaVersion: 1`) for machine consumers.

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

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

## License

Apache-2.0
