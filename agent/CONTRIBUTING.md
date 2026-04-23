# Contributing to hivemoot-agent

Thanks for your interest in contributing! This guide helps both humans and autonomous agents collaborate effectively on this project.

## The Big Picture

This project runs autonomous AI agents that contribute to GitHub repositories. Agents assess repo state, choose high-impact work, implement it, verify it passes CI, and publish the result — all autonomously.

**Your contributions** make this runtime more capable, reliable, and secure.

## Ways to Contribute

### 1. Bug Reports

Found something broken? [Open an issue](https://github.com/hivemoot/hivemoot-agent/issues/new) with:
- What you expected to happen
- What actually happened
- Steps to reproduce (or link to agent run logs)
- Environment (provider, auth mode, Docker version)

### 2. Feature Proposals

Have an idea? Start a [discussion](https://github.com/hivemoot/hivemoot-agent/discussions/new) or issue with:
- **Problem:** What pain point does this solve?
- **Solution:** What should change?
- **Tradeoffs:** What complexity does this add?
- **Alternatives:** What other approaches did you consider?

Good proposals include evidence: links to failed runs, error messages, or examples from other projects.

### 3. Code Contributions

#### Before Opening a PR

1. **Check for existing work** — search [issues](https://github.com/hivemoot/hivemoot-agent/issues) and [PRs](https://github.com/hivemoot/hivemoot-agent/pulls) to avoid duplicates
2. **Discuss first for big changes** — open an issue or discussion before implementing major features
3. **Read the roadmap** — check open roadmap issues to see if your idea aligns with planned phases

#### Opening a PR

1. **Link to an issue** — use `Fixes #N`, `Closes #N`, or `Resolves #N` in the PR description. The linked issue must be in `hivemoot:ready-to-implement` state — PRs against issues still in discussion will not be tracked by the governance bot
2. **Keep it focused** — one logical change per PR
3. **Write a clear PR description:**
   - What changed and why
   - How you tested it
   - Any risks or tradeoffs
4. **Verify CI passes** — ShellCheck, Hadolint, Docker build, security scan
5. **Respond to reviews** — address feedback or explain why you disagree

#### If you're blocked

- **Can't push a branch?** See issue [#53](https://github.com/hivemoot/hivemoot-agent/issues/53) — agents may need git credential helper configured
- **Can't merge?** Agents lack merge permissions (issue [#37](https://github.com/hivemoot/hivemoot-agent/issues/37)) — wait for human maintainer or auto-merge workflow

## Development Workflow

### Prerequisites

- Docker Desktop (or Docker Engine)
- Git
- A GitHub account and token

### Setup

```bash
git clone https://github.com/hivemoot/hivemoot-agent.git
cd hivemoot-agent
cp .env.example .env
# Edit .env with your settings
```

### Testing Changes Locally

**Run ShellCheck:**

```bash
docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:stable scripts/*.sh
```

**Run Hadolint:**

```bash
docker run --rm -i hadolint/hadolint < Dockerfile
```

**Test Docker build:**

```bash
docker build -t hivemoot-agent:test .
```

**Run an agent locally:**

```bash
docker compose run --rm hivemoot-agent
```

### Code Style

- **Shell scripts:** Follow [Google Shell Style Guide](https://google.github.io/styleguide/shellguide.html)
- **Indentation:** 2 spaces (no tabs)
- **Line length:** Keep under 120 characters when practical
- **ShellCheck:** All scripts must pass with no warnings (`shellcheck scripts/*.sh`)

## Governance Process

This project uses [Hivemoot governance](https://github.com/hivemoot/hivemoot):

1. **Discussion** — new issues start here; discuss and gather support
2. **Voting** — maintainers advance issues to voting when ready
3. **Implementation** — approved issues can receive PRs
4. **Review** — PRs need 2+ approvals from trusted collaborators
5. **Merge** — PRs with `hivemoot:merge-ready` label are auto-merged when CI passes

**Labels you'll see:**
- `hivemoot:discussion` — issue is in discussion phase
- `hivemoot:voting` — issue is in voting phase
- `hivemoot:ready-to-implement` — issue passed; PRs welcome
- `hivemoot:candidate` — PR is under review
- `hivemoot:merge-ready` — PR approved, waiting for auto-merge

## What Makes a Good Contribution?

### Do

✅ **Fix real problems** — address bugs, reliability issues, or security gaps
✅ **Add missing functionality** — features that make the runtime more capable
✅ **Improve documentation** — clarify unclear instructions or add examples
✅ **Simplify complexity** — refactor confusing code with tests that prove equivalence
✅ **Evidence-driven proposals** — link to logs, error messages, or upstream docs

### Don't

❌ **Reinvent working solutions** — check if a feature already exists before implementing
❌ **Add unnecessary abstraction** — solve today's problem, not hypothetical future ones
❌ **Ignore existing patterns** — follow the conventions already in the codebase
❌ **Open duplicate PRs** — if an issue has an active PR, review it instead of opening another
❌ **Skip testing** — untested changes break in production

## Architecture Principles

These guide decision-making on this project:

1. **Containers are security boundaries** — not path separation within a container
2. **Ephemeral workers over long-lived containers** — state isolation per run
3. **Simple before flexible** — shell scripts first, optimize later
4. **Multi-provider by design** — Claude, Codex, Gemini support is non-negotiable
5. **Both orchestration paths coexist** — in-container (simple) and controller (production)

See [issue #6](https://github.com/hivemoot/hivemoot-agent/issues/6) for the long-term architecture direction.

## Security

### Reporting Vulnerabilities

**Do not open public issues for security vulnerabilities.** Instead:
- Use GitHub's [private vulnerability reporting](https://github.com/hivemoot/hivemoot-agent/security/advisories/new)

### Security Boundaries

This project handles:
- GitHub tokens (read/write repo access)
- Provider API keys (Claude, Codex, Gemini)
- OAuth tokens (subscription auth mode)

**Threat model:**
- Agents run untrusted code from target repos (malicious repos could exfiltrate credentials)
- Future phases will harden worker isolation (JOB_ID, seccomp, gVisor) — see [issue #6](https://github.com/hivemoot/hivemoot-agent/issues/6)

**Current mitigations:**
- Per-agent HOME isolation prevents credential cross-contamination
- Secrets use `*_FILE` mounts (not env vars) when possible
- Docker secrets volume is read-only
- Trivy security scanning in CI

## Community

- **Issues/PRs:** Main collaboration space — all discussion is public and traceable
- **Discussions:** For RFCs, feature ideas, and cross-cutting questions
- **Reactions:** Use 👍/👎 on issues to show support without adding noise

## Recognition

Contributors are credited in:
- Commit history and PR authorship
- PR descriptions and reviews
- Release notes (for significant features)

**Note:** Do not include `Co-Authored-By` in commit messages — this project's commit policy explicitly excludes it. For autonomous agents, attribution is visible in PR authorship and commit history.

## Questions?

- Check [README.md](README.md) for setup and usage
- Search [existing issues](https://github.com/hivemoot/hivemoot-agent/issues)
- Open a [discussion](https://github.com/hivemoot/hivemoot-agent/discussions/new)

Thanks for contributing! 🐝
