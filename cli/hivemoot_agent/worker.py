"""Worker container entrypoint.

Replaces ``worker/entrypoint.sh``.  This is what runs as PID 1
inside every job container (under tini).  Responsibilities:

1. Bootstrap Claude OAuth credentials when ``CLAUDE_CODE_OAUTH_TOKEN``
   is set, so the Claude Code CLI sees a valid auth state before the
   agent process starts.  Done first because ``AGENT_PLUGINS`` checks
   come later and we want operators to be able to seed Claude auth
   without configuring a plugin stack (debug runs, smoke tests).
2. Promote secrets from ``*_FILE`` env vars into bare env vars so
   provider CLIs can read ``OPENAI_API_KEY`` etc. directly.
3. Reject ``AGENT_TRIGGER`` (controller-plane only).
4. Verify the worker image's baked provider matches ``AGENT_PROVIDER``
   so a wrong-image deploy fails loud instead of silently falling back
   to the wrong CLI.
5. Validate ``AGENT_PLUGINS``; bridge ``AGENT_TOKEN``/``GH_TOKEN`` etc.
   into ``GITHUB_TOKEN`` so the github plugin authenticates without
   each operator needing to know the canonical name.
6. Hand off to the engine's oneshot path in-process — no subprocess
   hop, so PID 1 stays Python and tini's signal forwarding is simple.

All step-1/step-4 error strings are kept identical to the deleted
shell entrypoint so migrated shell tests (and operator runbooks)
keep matching.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

# Provider secrets: each is read from <NAME>_FILE if set, else taken
# from <NAME>.  Mutual exclusion is enforced.  Order doesn't matter.
_PROVIDER_SECRETS = (
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "KILOCODE_TOKEN",
    "ZAI_API_KEY",
)

# Far-future expiry so Claude Code treats the bootstrap token as
# non-expired; actual token lifetime is enforced server-side.
_CLAUDE_OAUTH_EXPIRES_AT_MS = 4102444800000

# owner/repo with conservative path-safe segments; matches the
# deleted shared/lib.sh:repo_name_is_valid regex.
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+$")


def register_worker_commands(
    subparsers: argparse._SubParsersAction,
) -> None:
    """Register the ``worker`` subcommand on the root parser."""
    sp = subparsers.add_parser(
        "worker",
        help="Container entrypoint — sets up env then runs the agent oneshot",
    )
    sp.set_defaults(func=cmd_worker)


# ── Logging ────────────────────────────────────────────────────────


def _log(msg: str) -> None:
    """Emit one entrypoint log line.

    Format matches the deleted bash entrypoint (``[entrypoint TS] msg``)
    so log filters/runbooks keep working.
    """
    ts = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[entrypoint {ts}] {msg}", flush=True)


# ── Secret loading ─────────────────────────────────────────────────


def _resolve_secret_value(var_name: str) -> str:
    """Resolve a secret to its value.

    Returns the bare value if set; otherwise reads from ``<var>_FILE``.
    Raises ``RuntimeError`` if both are set, mirroring the shell's
    mutual-exclusion guard.  Returns ``""`` when neither is set.
    """
    file_var = f"{var_name}_FILE"
    bare_value = os.environ.get(var_name, "")
    file_value = os.environ.get(file_var, "")

    if bare_value and file_value:
        raise RuntimeError(
            f"Set either {var_name} or {file_var}, not both."
        )

    if bare_value:
        return bare_value

    if not file_value:
        return ""

    if not os.path.isfile(file_value):
        raise RuntimeError(
            f"{file_var} is set but file does not exist: {file_value}"
        )

    with open(file_value) as f:
        # tr -d '\r\n' equivalent — the shell stripped CR/LF anywhere
        # in the file content, not just trailing whitespace.
        return f.read().replace("\r", "").replace("\n", "")


def _load_provider_secrets() -> None:
    """Promote each provider's *_FILE secret into the bare env var.

    After this runs, downstream CLI invocations can read
    ``OPENAI_API_KEY`` etc. directly without knowing about the file
    indirection.  Clears ``*_FILE`` after promotion so repeated
    invocations don't trip the mutual-exclusion guard.
    """
    for var_name in _PROVIDER_SECRETS:
        value = _resolve_secret_value(var_name)
        if value:
            os.environ[var_name] = value
            os.environ.pop(f"{var_name}_FILE", None)


# ── Claude OAuth bootstrap ─────────────────────────────────────────


def _bootstrap_claude_credentials() -> None:
    """Seed ``${HOME}/.claude/{.credentials.json,onboarding}`` from env.

    No-op if ``CLAUDE_CODE_OAUTH_TOKEN`` isn't set.  Both files are
    written with mode 0600 because they contain auth state.

    Runs *before* AGENT_PLUGINS validation so operators can seed
    Claude auth in containers without configuring a plugin stack
    (debug / smoke runs).  This ordering is asserted by the existing
    test-claude-token-bootstrap.sh contract.
    """
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")
    if not token:
        return

    home = os.environ.get("HOME", "")
    if not home:
        # No HOME → nowhere to write. Skip silently rather than fail;
        # the bash version had the same behavior (HOME was always set).
        return

    claude_dir = os.path.join(home, ".claude")
    os.makedirs(claude_dir, exist_ok=True)

    creds_path = os.path.join(claude_dir, ".credentials.json")
    creds = {
        "claudeAiOauth": {
            "accessToken": token,
            "expiresAt": _CLAUDE_OAUTH_EXPIRES_AT_MS,
        },
    }
    with open(creds_path, "w") as f:
        json.dump(creds, f, separators=(",", ":"))
    os.chmod(creds_path, 0o600)

    # Onboarding marker so Claude Code skips first-run setup.
    onboarding_path = os.path.join(home, ".claude.json")
    with open(onboarding_path, "w") as f:
        f.write('{"hasCompletedOnboarding":true}\n')
    os.chmod(onboarding_path, 0o600)


# ── Provider mismatch ─────────────────────────────────────────────


def _check_provider_match() -> None:
    """Fail loud when the worker image's baked provider != AGENT_PROVIDER.

    ``DOCKER_PROVIDER`` is set at image-build time (see Dockerfile);
    ``all`` images carry every provider CLI and pass through any
    AGENT_PROVIDER.  Mismatched single-provider images fail with a
    multi-line message that gives operators both fixes (env-side and
    rebuild-side).  Error text is held stable so runbooks can pattern-
    match.
    """
    docker_provider = os.environ.get("DOCKER_PROVIDER", "all")
    agent_provider = os.environ.get("AGENT_PROVIDER", "claude")

    if docker_provider == "all" or docker_provider == agent_provider:
        return

    print(
        f"Provider mismatch: image built for '{docker_provider}' "
        f"but AGENT_PROVIDER='{agent_provider}'.",
        file=sys.stderr,
    )
    print(
        f"  Use baked provider: set AGENT_PROVIDER={docker_provider} in .env",
        file=sys.stderr,
    )
    print(
        f"  Switch providers:   PROVIDER={agent_provider} "
        f"docker compose build hivemoot-agent",
        file=sys.stderr,
    )
    sys.exit(1)


# ── GitHub token bridging ─────────────────────────────────────────


def _bridge_github_token() -> None:
    """Set GITHUB_TOKEN[_FILE] from a fall-through chain of aliases.

    Order:
      explicit GITHUB_TOKEN/_FILE → GH_TOKEN → AGENT_GITHUB_TOKEN[_FILE]
      → AGENT_TOKEN[_FILE] → AGENT_GITHUB_TOKEN_01[_FILE]

    The first non-empty source wins.  Once GITHUB_TOKEN or
    GITHUB_TOKEN_FILE is set (either by the operator or by a previous
    fallback in this chain), no further fallbacks fire.

    This lets operators use any of the documented token names without
    each plugin needing to know all the aliases.
    """
    if os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN_FILE"):
        return

    if os.environ.get("GH_TOKEN"):
        os.environ["GITHUB_TOKEN"] = os.environ["GH_TOKEN"]
        return

    if os.environ.get("AGENT_GITHUB_TOKEN_FILE"):
        os.environ["GITHUB_TOKEN_FILE"] = os.environ["AGENT_GITHUB_TOKEN_FILE"]
        return
    if os.environ.get("AGENT_GITHUB_TOKEN"):
        os.environ["GITHUB_TOKEN"] = os.environ["AGENT_GITHUB_TOKEN"]
        return

    if os.environ.get("AGENT_TOKEN_FILE"):
        os.environ["GITHUB_TOKEN_FILE"] = os.environ["AGENT_TOKEN_FILE"]
        return
    if os.environ.get("AGENT_TOKEN"):
        os.environ["GITHUB_TOKEN"] = os.environ["AGENT_TOKEN"]
        return

    if os.environ.get("AGENT_GITHUB_TOKEN_01_FILE"):
        os.environ["GITHUB_TOKEN_FILE"] = os.environ["AGENT_GITHUB_TOKEN_01_FILE"]
        return
    if os.environ.get("AGENT_GITHUB_TOKEN_01"):
        os.environ["GITHUB_TOKEN"] = os.environ["AGENT_GITHUB_TOKEN_01"]


# ── Plugin engine dispatch ────────────────────────────────────────


def _validate_target_repo(target_repo: str) -> None:
    """Reject malformed TARGET_REPO before it gets propagated to plugins."""
    if not target_repo:
        print(
            "TARGET_REPO is required. Set it as owner/repo.", file=sys.stderr,
        )
        sys.exit(1)

    if not _REPO_RE.match(target_repo):
        print(
            f"Invalid TARGET_REPO: {target_repo}. Expected owner/repo.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Reject "owner/." and "owner/.." — path-traversal hygiene.
    repo_segment = target_repo.split("/", 1)[1]
    if repo_segment in (".", ".."):
        print(
            f"Invalid TARGET_REPO: {target_repo}. Expected owner/repo.",
            file=sys.stderr,
        )
        sys.exit(1)


def _prepare_plugin_engine_dispatch() -> None:
    """Validate AGENT_PLUGINS and propagate companion env to the engine.

    Exits 1 with a stable error message when AGENT_PLUGINS is unset or
    empty — the same message the bash entrypoint emitted, so existing
    test fixtures and operator runbooks keep matching.
    """
    if not os.environ.get("AGENT_PLUGINS"):
        print(
            "AGENT_PLUGINS is required. Set it to the plugin stack "
            "(e.g. github,hivemoot-github).",
            file=sys.stderr,
        )
        sys.exit(1)

    target_repo = os.environ.get("TARGET_REPO", "")
    if target_repo:
        _validate_target_repo(target_repo)
        if not os.environ.get("GITHUB_REPOS"):
            os.environ["GITHUB_REPOS"] = target_repo

    # Legacy alias support: GIT_CLONE_DEPTH → GITHUB_CLONE_DEPTH.
    if (
        not os.environ.get("GITHUB_CLONE_DEPTH")
        and os.environ.get("GIT_CLONE_DEPTH")
    ):
        os.environ["GITHUB_CLONE_DEPTH"] = os.environ["GIT_CLONE_DEPTH"]

    _bridge_github_token()


# ── Top-level command ─────────────────────────────────────────────


def cmd_worker(args: argparse.Namespace) -> int:
    """Run all entrypoint steps then hand off to the engine oneshot.

    Stays in-process: no subprocess hop to ``hivemoot-agent oneshot``.
    PID 1 (under tini) is this Python process, then later it's the
    provider CLI that the engine spawns.
    """
    # Step 1: provider secrets *_FILE → bare promotion.  Must run
    # before the Claude OAuth bootstrap because operators can supply
    # the token via CLAUDE_CODE_OAUTH_TOKEN_FILE; the bootstrap reads
    # the bare CLAUDE_CODE_OAUTH_TOKEN and would otherwise see it
    # empty.
    try:
        _load_provider_secrets()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    # Step 2: Claude OAuth bootstrap (intentionally before AGENT_PLUGINS
    # validation so operators can seed auth in pre-flight runs).
    try:
        _bootstrap_claude_credentials()
    except OSError as exc:
        print(
            f"Failed to seed Claude credentials: {exc}", file=sys.stderr,
        )
        return 1

    # Step 3: reject controller-only env.
    if os.environ.get("AGENT_TRIGGER"):
        print(
            "AGENT_TRIGGER is controller-only and is not used by the worker runtime.",
            file=sys.stderr,
        )
        print(
            "Use controller/main.sh to drive trigger-based runs.",
            file=sys.stderr,
        )
        return 1

    # Step 4: provider mismatch (calls sys.exit on failure to keep
    # the multi-line error visible at the right depth).
    _check_provider_match()

    # Step 5: validate AGENT_PLUGINS, bridge tokens, propagate companions.
    _prepare_plugin_engine_dispatch()

    _log(f"Dispatching plugin engine: plugins={os.environ['AGENT_PLUGINS']}")

    # Step 6: hand off to the engine in-process.  No subprocess: this
    # avoids a fork/exec for every job and keeps PID 1 stable under tini.
    from hivemoot_agent.engine import Engine
    return Engine().oneshot()
