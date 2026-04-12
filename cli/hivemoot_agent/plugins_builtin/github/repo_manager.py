"""GitHub repo manager — clone, sync, and configure repositories."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass


@dataclass
class RepoInfo:
    """Metadata about a cloned repository."""

    repo: str  # owner/repo
    path: str  # absolute local path
    default_branch: str


def repo_checkout_path(workspace: str, repo: str) -> str:
    """Resolve a collision-safe checkout path for owner/repo."""
    owner, repo_name = repo.split("/", 1)
    return os.path.join(workspace, owner, repo_name)


def parse_repos(raw: str) -> list[str]:
    """Parse a comma-separated list of owner/repo strings."""
    repos = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if "/" not in entry or entry.count("/") != 1:
            raise ValueError(
                f"Invalid repo format: {entry!r}. Expected owner/repo."
            )
        repos.append(entry)
    return repos


def _resolve_default_branch(repo_dir: str) -> str:
    """Determine the default branch of a cloned repo."""
    # Try symbolic HEAD first.
    try:
        result = subprocess.run(
            ["git", "-C", repo_dir, "symbolic-ref", "refs/remotes/origin/HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            ref = result.stdout.strip()
            branch = ref.removeprefix("refs/remotes/origin/")
            if branch:
                return branch
    except subprocess.TimeoutExpired:
        pass

    # Fallback: check common branch names.
    for candidate in ("main", "master"):
        result = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse", "--verify", f"origin/{candidate}"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return candidate

    # Last resort: first remote branch.
    result = subprocess.run(
        ["git", "-C", repo_dir, "branch", "-r", "--format=%(refname:short)"],
        capture_output=True, text=True, timeout=10,
    )
    for line in result.stdout.strip().split("\n"):
        branch = line.strip().removeprefix("origin/")
        if branch and branch != "HEAD":
            return branch

    return "main"


def _write_askpass_script(token: str) -> str:
    """Write a GIT_ASKPASS helper that returns the token.

    Keeps the token out of git clone URLs and process argv.
    """
    fd, path = tempfile.mkstemp(prefix="git-askpass-", suffix=".sh")
    with os.fdopen(fd, "w") as f:
        f.write('#!/bin/sh\n')
        f.write('case "$1" in\n')
        f.write('  *Username*) echo "x-access-token" ;;\n')
        f.write('  *Password*) printf "%s" "${GIT_PAT}" ;;\n')
        f.write('  *) echo "" ;;\n')
        f.write('esac\n')
    os.chmod(path, stat.S_IRWXU)
    return path


def _sync_existing(repo_dir: str, token: str) -> bool:
    """Fetch and reset an existing clone to the default branch."""
    default_branch = _resolve_default_branch(repo_dir)

    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    askpass = _write_askpass_script(token)
    env["GIT_ASKPASS"] = askpass
    env["GIT_PAT"] = token

    try:
        result = subprocess.run(
            ["git", "-C", repo_dir, "fetch", "--prune", "origin"],
            capture_output=True, text=True, timeout=120, env=env,
        )
        if result.returncode != 0:
            return False

        result = subprocess.run(
            ["git", "-C", repo_dir, "reset", "--hard", f"origin/{default_branch}"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return False

        subprocess.run(
            ["git", "-C", repo_dir, "clean", "-fdx"],
            capture_output=True, text=True, timeout=30,
        )
        return True
    finally:
        os.unlink(askpass)


def clone_or_sync(
    repo: str,
    workspace: str,
    token: str,
    clone_depth: int = 50,
) -> RepoInfo:
    """Clone a repo or sync an existing clone.

    Args:
        repo: owner/repo string.
        workspace: base directory for clones.
        token: GitHub PAT for authentication.
        clone_depth: shallow clone depth (0 = full clone).

    Returns:
        RepoInfo with the local path and default branch.

    Raises:
        RuntimeError: if cloning fails.
    """
    # Repo "owner/repo" clones to workspace/owner/repo so different
    # owners cannot collide on the same basename.
    repo_dir = repo_checkout_path(workspace, repo)

    # Try syncing an existing clone first.
    if os.path.isdir(os.path.join(repo_dir, ".git")):
        print(
            f"[github] reusing existing clone: {repo_dir}",
            file=sys.stderr, flush=True,
        )
        if _sync_existing(repo_dir, token):
            branch = _resolve_default_branch(repo_dir)
            return RepoInfo(repo=repo, path=repo_dir, default_branch=branch)

        # Sync failed — remove stale checkout.
        print(
            "[github] sync failed; removing stale clone",
            file=sys.stderr, flush=True,
        )
        subprocess.run(
            ["rm", "-rf", repo_dir],
            capture_output=True, timeout=30,
        )

    # Fresh clone.
    os.makedirs(os.path.dirname(repo_dir), exist_ok=True)

    askpass = _write_askpass_script(token)
    env = {
        **os.environ,
        "GIT_ASKPASS": askpass,
        "GIT_PAT": token,
        "GIT_TERMINAL_PROMPT": "0",
    }

    clone_args = ["git", "clone", "--single-branch"]
    depth_label = "full"
    if clone_depth > 0:
        clone_args += ["--depth", str(clone_depth)]
        depth_label = str(clone_depth)

    clone_args += [f"https://github.com/{repo}.git", repo_dir]

    print(
        f"[github] cloning {repo} (depth={depth_label})",
        file=sys.stderr, flush=True,
    )

    try:
        result = subprocess.run(
            clone_args,
            capture_output=True, text=True, timeout=300, env=env,
        )
    finally:
        os.unlink(askpass)

    if result.returncode != 0:
        # Clean up partial clone.
        subprocess.run(["rm", "-rf", repo_dir], capture_output=True, timeout=30)
        raise RuntimeError(
            f"Failed to clone {repo}: {result.stderr.strip()}"
        )

    branch = _resolve_default_branch(repo_dir)
    return RepoInfo(repo=repo, path=repo_dir, default_branch=branch)


def configure_git_user(repo_dir: str, name: str, email: str) -> None:
    """Configure git user.name and user.email in the repo."""
    subprocess.run(
        ["git", "-C", repo_dir, "config", "user.name", name],
        capture_output=True, timeout=10,
    )
    subprocess.run(
        ["git", "-C", repo_dir, "config", "user.email", email],
        capture_output=True, timeout=10,
    )


def resolve_github_user(token: str) -> tuple[str, str]:
    """Resolve the GitHub username and email from the token.

    Returns (login, email) or ("", "") if the token is not a user PAT.
    """
    env = {**os.environ, "GH_TOKEN": token, "GITHUB_TOKEN": token}
    try:
        result = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"],
            capture_output=True, text=True, timeout=15, env=env,
        )
        if result.returncode == 0:
            login = result.stdout.strip()
            if login:
                return login, f"{login}@users.noreply.github.com"
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return "", ""
