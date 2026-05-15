"""GitHub CLI helpers for the local queen.

The local queen uses short-lived GitHub App installation tokens minted
by the web API. Tokens are passed only through the subprocess
environment, never argv, so process listings and command logs do not
expose them.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Sequence


__all__ = (
    "GHCommandError",
    "PullRequestRef",
    "get_pr_head_sha",
    "get_pr_merge_commit_sha",
    "parse_subject_ref",
    "post_pr_comment",
    "squash_merge_pr",
)


@dataclass(frozen=True)
class PullRequestRef:
    owner: str
    repo: str
    number: int

    @property
    def full_repo(self) -> str:
        return f"{self.owner}/{self.repo}"


class GHCommandError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        returncode: int | None = None,
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.returncode = returncode
        self.stderr = stderr


_SUBJECT_RE = re.compile(r"^([^/\s]+)/([^#\s]+)#([1-9][0-9]*)$")


def parse_subject_ref(subject_ref: str) -> PullRequestRef:
    match = _SUBJECT_RE.match(subject_ref.strip())
    if not match:
        raise ValueError(
            "subject_ref must have owner/repo#number shape; "
            f"got {subject_ref!r}"
        )
    owner, repo, number = match.groups()
    return PullRequestRef(owner=owner, repo=repo, number=int(number))


def _run_gh(
    args: Sequence[str],
    *,
    token: str,
    timeout_secs: int,
) -> str:
    if not token:
        raise GHCommandError("missing GitHub token")
    env = {
        key: value
        for key, value in os.environ.items()
        if key
        in {
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
        }
    }
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token
    try:
        proc = subprocess.run(
            ["gh", *args],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout_secs,
        )
    except FileNotFoundError as exc:
        raise GHCommandError("gh CLI is not installed or not in PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise GHCommandError(
            f"gh command timed out after {timeout_secs}s",
            stderr=(exc.stderr or "") if isinstance(exc.stderr, str) else "",
        ) from exc

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        raise GHCommandError(
            f"gh command failed with exit {proc.returncode}: {stderr[:300]}",
            returncode=proc.returncode,
            stderr=stderr,
        )
    return (proc.stdout or "").strip()


def get_pr_head_sha(
    pr: PullRequestRef,
    *,
    token: str,
    timeout_secs: int = 30,
) -> str:
    out = _run_gh(
        [
            "pr",
            "view",
            str(pr.number),
            "--repo",
            pr.full_repo,
            "--json",
            "headRefOid",
            "--jq",
            ".headRefOid",
        ],
        token=token,
        timeout_secs=timeout_secs,
    )
    if not out:
        raise GHCommandError(f"gh pr view returned empty head SHA for {pr.full_repo}#{pr.number}")
    return out


def get_pr_merge_commit_sha(
    pr: PullRequestRef,
    *,
    token: str,
    timeout_secs: int = 30,
) -> str:
    out = _run_gh(
        [
            "pr",
            "view",
            str(pr.number),
            "--repo",
            pr.full_repo,
            "--json",
            "mergeCommit",
            "--jq",
            ".mergeCommit.oid // \"\"",
        ],
        token=token,
        timeout_secs=timeout_secs,
    )
    if not out:
        raise GHCommandError(
            f"gh pr view returned empty merge commit for {pr.full_repo}#{pr.number}"
        )
    return out


def squash_merge_pr(
    pr: PullRequestRef,
    *,
    expected_head_sha: str,
    token: str,
    timeout_secs: int = 30,
) -> str:
    expected = expected_head_sha.strip()
    if not expected:
        raise ValueError("expected_head_sha must be non-empty")
    _run_gh(
        [
            "pr",
            "merge",
            str(pr.number),
            "--repo",
            pr.full_repo,
            "--squash",
            "--match-head-commit",
            expected,
        ],
        token=token,
        timeout_secs=timeout_secs,
    )
    return get_pr_merge_commit_sha(
        pr,
        token=token,
        timeout_secs=timeout_secs,
    )


def post_pr_comment(
    pr: PullRequestRef,
    body: str,
    *,
    token: str,
    timeout_secs: int = 30,
) -> str:
    if not body.strip():
        raise ValueError("comment body must be non-empty")

    path = ""
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            suffix=".json",
            delete=False,
        ) as f:
            path = f.name
            json.dump({"body": body}, f, ensure_ascii=False)

        out = _run_gh(
            [
                "api",
                "--method",
                "POST",
                f"repos/{pr.owner}/{pr.repo}/issues/{pr.number}/comments",
                "--input",
                path,
                "--jq",
                ".html_url",
            ],
            token=token,
            timeout_secs=timeout_secs,
        )
        if not out:
            raise GHCommandError(
                f"gh api returned empty comment URL for {pr.full_repo}#{pr.number}"
            )
        return out
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
