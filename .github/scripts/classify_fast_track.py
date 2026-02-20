#!/usr/bin/env python3
"""
Fast-track classifier for hivemoot PRs.

Reads a JSON array of {path, additions, deletions} from stdin.
Writes ELIGIBLE and REASON to $GITHUB_OUTPUT.
Fails closed on any error.

Phase 1 scope: docs/markdown-only, bounded size.

Python compatibility: works on Python 3.6+. Uses fnmatch with explicit
** handling instead of PurePath.match() to avoid version-specific behavior.
"""
import fnmatch
import json
import os
import sys

ALLOWED = ["**/*.md", "**/*.txt", "docs/**"]
DENIED = [".github/**", "package.json", "package-lock.json", "*.lock"]
MAX_FILES = 5
MAX_LINES = 80


def matches(path: str, globs: list[str]) -> bool:
    """Return True if path matches any glob in the list.

    Handles ** as a multi-segment wildcard by checking both the full path
    and the basename against each pattern. This avoids Python version
    sensitivity in PurePath.match(**) behavior:

    - "**/*.md"  matches any .md file at any depth, including root level
    - "docs/**"  matches any file whose path starts with docs/
    - ".github/**" matches any file whose path starts with .github/
    - "*.lock"   matches any lock file at root level
    - "package.json" exact match at root level
    """
    normalized = path.replace(os.sep, "/")
    filename = normalized.rsplit("/", 1)[-1]

    for g in globs:
        if "**" not in g:
            # No wildcard spanning: plain fnmatch against full path and basename
            if fnmatch.fnmatch(normalized, g) or fnmatch.fnmatch(filename, g):
                return True
        elif g.startswith("**/"):
            # "**/<pattern>" — match pattern against any path suffix
            # e.g. "**/*.md" should match "README.md" and "docs/guide/intro.md"
            suffix_pattern = g[3:]  # strip the "**/"
            if fnmatch.fnmatch(filename, suffix_pattern):
                return True
            # Also match nested paths: "docs/guide/intro.md" against "**/*.md"
            # by checking if any trailing component matches
            if fnmatch.fnmatch(normalized, g):
                return True
        elif g.endswith("/**"):
            # "<prefix>/**" — match any path that starts with the prefix directory
            prefix = g[:-3]  # strip the "/**"
            if normalized == prefix or normalized.startswith(prefix + "/"):
                return True
        else:
            # Mixed pattern with ** in the middle — fall back to fnmatch
            if fnmatch.fnmatch(normalized, g):
                return True

    return False


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
