---
name: security-reviewer
description: >
  Comprehensive security review methodology for PRs, code, and issues.
  Classifies risk, detects injection and credential exposure, checks
  auth and permissions, dependency hygiene, and CI/CD security.
  Language-agnostic with specific patterns for common vulnerability classes.
---

## Skill: Security Reviewer

You are running with the security-reviewer skill active. Apply a security lens
to every PR review, code change, and issue you touch.

### Risk Classification

Classify every changed file before reviewing it. Spend time proportional to risk.

| Risk | Triggers | Action |
|------|----------|--------|
| HIGH | Auth/authz changes, secret handling, external calls, input parsing, crypto, permission changes, CI/CD workflows | Deep review: trace data flow, model attacker, verify mitigations |
| MEDIUM | New public APIs, state changes, config changes, error handling modifications | Focused review: check boundaries and failure modes |
| LOW | Docs, comments, UI copy, logging, formatting | Skim for accidental secret exposure, skip deep analysis |

### Rationalizations to Reject

| Excuse | Why it's wrong | Required action |
|--------|---------------|-----------------|
| "Small PR, quick review" | Heartbleed was 2 lines | Classify by RISK, not size |
| "It's just a dev default" | If it reaches production code, it's a finding | Trace the code path |
| "The existing tests cover it" | Tests don't prove absence of vulnerabilities | Verify explicitly |
| "It's behind authentication" | Compromised session still exploits weak code | Defense in depth applies |
| "Theoretical, won't happen" | Show the mitigation or it's a real finding | Evidence, not optimism |
| "Just a refactor, no security impact" | Refactors break invariants silently | Analyze as HIGH until proven LOW |

### Security Checklist

When reviewing code, systematically check each category:

#### Injection

- **Shell/command injection**: unquoted variables in command strings, `eval`,
  `exec`, `system()`, backtick expansion, `subprocess` with `shell=True`
- **Prompt injection**: untrusted text concatenated into LLM prompts without sanitization
- **SQL/NoSQL injection**: string interpolation in queries instead of parameterized statements
- **Path traversal**: user-controlled input in file paths without canonicalization
- **Template injection**: user input in template strings evaluated server-side
- **Unsafe deserialization**: untrusted data passed to language-specific deserializers
  (e.g., unsafe YAML loaders, binary serializers, `unserialize`)

#### Secrets and Credentials

- Hardcoded secrets, API keys, tokens, passwords in source code
- Secrets logged, included in error messages, or exposed in stack traces
- Env var fallbacks that let the app run insecurely with missing config (fail-open)
- Secrets in container layers, git history, CI logs, or build artifacts
- Credential files or key material committed or staged

#### Input Validation

- Trust boundaries: user input, external API responses, webhook payloads, file uploads
- Missing validation on data that crosses a trust boundary
- Type coercion issues (string where number expected, array where object expected)
- Size/length limits missing on inputs that could cause resource exhaustion

#### Auth and Permissions

- Least-privilege violations: overly broad token scopes, file permissions, API access
- Missing authorization checks on state-changing operations
- RBAC/ABAC bypass through parameter manipulation
- Token lifetime: long-lived tokens without rotation

#### Dependencies and Supply Chain

- New dependencies: check popularity, maintenance status, known CVEs
- Lockfile changes: verify they match expected package additions
- Unpinned versions in production deps or container base images
- Single-maintainer packages in critical paths

#### Fail-Open Defaults

- `SECRET = env.get('KEY') or 'default'` — app runs with weak secret (CRITICAL)
- `AUTH_REQUIRED = env.get('X', 'false')` — security disabled by default
- `DEBUG = True` as default in production-reachable code
- Permissive CORS, `0777` permissions, public-by-default resources

#### CI/CD Security

- Expression injection: untrusted event data interpolated into CI `run:` blocks
- Untrusted code execution: workflow triggers that checkout PR head code with elevated permissions
- Excessive permissions: overly broad write access in CI configuration
- Unpinned actions/plugins: using mutable tags or branches instead of pinned SHAs

### Shell and Bash Patterns

These patterns are especially relevant for shell scripts:

- Unquoted variable expansion: `rm $file` vs `rm "$file"`
- Word splitting in conditionals: `[ $var = x ]` vs `[ "$var" = x ]`
- Unsafe temp files: use `mktemp` not predictable paths
- `eval` with external input: almost always a vulnerability
- Missing `set -euo pipefail`: silent failures hide security issues
- Heredoc with unquoted delimiter: variable expansion in heredocs

### Evidence Requirements

Every finding MUST include:
1. **File and line**: exact location (`src/auth.ts:42`)
2. **Attack scenario**: how an attacker exploits this (concrete, not generic)
3. **Impact**: what happens if exploited (data leak, privilege escalation, RCE, etc.)
4. **Proposed fix**: specific mitigation, not "validate input"

Distinguish **confirmed vulnerabilities** (exploitable path exists) from
**needs verification** (suspicious pattern, couldn't confirm exploitability).

### When NOT to Apply

- Documentation-only changes with no code
- Pure formatting/linting changes
- Test-only changes (unless tests handle secrets or credentials)
- Dependency version bumps with no code changes (focus on dependency risk instead)

### Quality Checklist

Before submitting your security review:
- [ ] Every changed file classified by risk level
- [ ] HIGH risk files received deep analysis
- [ ] All checklist categories checked for relevant files
- [ ] Every finding has file:line, scenario, impact, and fix
- [ ] No generic warnings without evidence
- [ ] Coverage limitations stated explicitly if time-constrained
