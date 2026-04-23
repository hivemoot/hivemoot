---
name: dep-auditor
description: >
  Supply chain and dependency risk assessment. Evaluates new dependencies
  before adoption, audits lockfile changes, checks for known CVEs and
  maintenance risks, and enforces version pinning discipline. Covers all
  major ecosystems (npm, pip, cargo, go, Maven, gems, etc.), Docker
  images, and CI/CD actions.
---

## Skill: Dependency Auditor

You are running with the dep-auditor skill active. Evaluate dependency
changes for supply chain risk, maintenance health, and security.

### Before Adding a Dependency

Ask these questions before introducing any new package:

1. **Is it necessary?** Can the standard library, built-in APIs, or existing deps
   do the job? The best dependency is the one you don't add.
2. **Is it maintained?** Check: last release date, open issue response time,
   number of maintainers. Single-maintainer packages on critical paths are risky.
3. **Is it popular?** Low download counts + few dependents = higher supply chain risk.
   Not disqualifying, but warrants closer inspection.
4. **Is it secure?** Check for known CVEs via the ecosystem's audit tool
   (e.g., `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`),
   GitHub advisories, or Snyk. Unpatched known vulnerabilities are blocking.
5. **Is the license compatible?** Verify the license allows your use case.
   Watch for copyleft licenses (GPL, AGPL) in permissively-licensed projects.
6. **Is the scope proportional?** Don't add a large framework for one utility function.

### Lockfile Review

When a PR modifies any lockfile, apply these checks:

| Ecosystem | Lockfile(s) |
|-----------|-------------|
| Node.js | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` |
| Python | `requirements.txt`, `poetry.lock`, `Pipfile.lock`, `uv.lock` |
| Rust | `Cargo.lock` |
| Go | `go.sum` |
| Ruby | `Gemfile.lock` |
| Java/Kotlin | `gradle.lockfile`, `pom.xml` (effective POM) |
| .NET | `packages.lock.json` |

For all ecosystems:

- **Verify expected changes**: lockfile diff should match declared dependency changes.
  Phantom entries (packages appearing without a manifest change) need explanation.
- **Check version jumps**: major version bumps in transitive deps may introduce breaking changes.
- **Flag new transitive deps**: a single package addition can pull in dozens of transitive
  dependencies. Note significant additions.
- **Watch for integrity hash changes** on packages that weren't updated — could indicate
  registry compromise or a republished package.

### Version Pinning

| Context | Policy |
|---------|--------|
| Production dependencies | Prefer exact versions or narrow ranges |
| Dev dependencies | Ranges acceptable (`^`, `~`, `>=x,<y`) |
| Docker base images | Pin to digest (`sha256:...`) for reproducibility |
| CI/CD actions (GitHub Actions, etc.) | Pin to full commit SHA, not tag or branch |
| CI tool versions | Pin explicitly (e.g., `node: '22.12.0'`, `python: '3.12.4'`) |

### Red Flags

Immediately flag these in any dependency change:

- **Typosquatting**: package name suspiciously similar to a popular package
- **Install scripts**: pre/post-install hooks in new dependencies (common malware vector)
- **Excessive permissions**: package requests capabilities beyond its stated purpose
- **Abandoned maintenance**: no commits in 12+ months with open security issues
- **Ownership transfer**: recent registry ownership change on an established package
- **No security contact**: missing `SECURITY.md` or equivalent reporting path

### When Reviewing PRs

- Check that the new dependency is actually imported and used in the code
- Verify the stated reason for adding it (does the PR description explain why?)
- If the dep replaces an existing one, confirm the old one is removed
- For Docker base image changes, check the image source and verify it's official

### When NOT to Apply

- Code-only changes with no dependency modifications
- Internal package version bumps within a monorepo
- Test fixture data that happens to mention package names

### Rationalizations to Reject

| Excuse | Why it's wrong | Required action |
|--------|---------------|-----------------|
| "Everyone uses this package" | Popularity doesn't guarantee safety | Check CVEs and maintenance |
| "It's just a dev dependency" | Dev deps execute during build; supply chain risk applies | Same scrutiny as prod deps |
| "The lockfile is too big to review" | Diff the relevant sections, don't skip | Focus on new additions |
| "It's from a trusted org" | Orgs get compromised; packages get transferred | Verify the specific version |
