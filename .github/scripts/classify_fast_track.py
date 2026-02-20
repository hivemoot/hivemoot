#!/usr/bin/env python3
"""
Fast-track classifier for hivemoot PRs.

Reads a JSON array of {path, additions, deletions} from stdin.
Writes ELIGIBLE and REASON to $GITHUB_OUTPUT.
Fails closed on any error.

Phase 1 scope: docs/markdown-only, bounded size.

Requires Python 3.12+ (uses PurePosixPath.match with ** support).
The workflow pins python-version: '3.12'.
"""
import json
import os
import sys
from pathlib import PurePosixPath

ALLOWED = ["**/*.md", "**/*.txt", "docs/**"]
DENIED = [".github/**", "package.json", "package-lock.json", "*.lock"]
MAX_FILES = 5
MAX_LINES = 80


def matches(path: str, globs: list[str]) -> bool:
    """Return True if path matches any glob pattern.

    Uses PurePosixPath.match, which supports ** as a multi-segment wildcard
    (requires Python 3.12+).
    """
    p = PurePosixPath(path)
    return any(p.match(g) for g in globs)


def write_output(eligible: bool, reason: str) -> None:
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"ELIGIBLE={str(eligible).lower()}\n")
            f.write(f"REASON={reason}\n")
    else:
        # Local testing fallback
        print(f"ELIGIBLE={str(eligible).lower()}")
        print(f"REASON={reason}")


def classify(files: list[dict]) -> tuple[bool, str]:
    file_count = len(files)
    total_lines = sum(f["additions"] + f["deletions"] for f in files)

    if file_count > MAX_FILES:
        return False, f"denied:size file_count={file_count} > {MAX_FILES}"
    if total_lines > MAX_LINES:
        return False, f"denied:size total_lines={total_lines} > {MAX_LINES}"

    for f in files:
        p = f["path"]
        if matches(p, DENIED):
            return False, f"denied:denylist path={p}"
        if not matches(p, ALLOWED):
            return False, f"denied:allowlist path={p}"

    return True, "eligible"


def main() -> None:
    try:
        files = json.load(sys.stdin)
        eligible, reason = classify(files)
        write_output(eligible, reason)
    except Exception as e:
        write_output(False, f"fallback:error {e}")


if __name__ == "__main__":
    main()
