#!/usr/bin/env python3
"""
Fast-track classifier for hivemoot PRs.

Reads a JSON array of {path, additions, deletions} from stdin.
Writes ELIGIBLE and REASON to $GITHUB_OUTPUT.
Fails closed on any error.

Phase 1 scope: docs/markdown-only, bounded size.
"""
import fnmatch
import json
import os
import sys

ALLOWED = ["**/*.md", "**/*.txt", "docs/**"]
DENIED = [
    ".github/**",
    "package.json",
    "package-lock.json",
    "*.lock",
    "pnpm-lock.yaml",  # pnpm uses .yaml extension, not caught by *.lock
    "go.sum",          # Go module verification file, no .lock extension
    "bun.lockb",       # Bun lockfile uses .lockb binary format
    "go.work.sum",     # Go workspace sum file, same extension gap as go.sum
]
MAX_FILES = 5
MAX_LINES = 80


def matches(path: str, globs: list[str]) -> bool:
    """Return True if path matches any glob pattern.

    Uses fnmatch for portability across Python versions. For patterns starting
    with '**/', also checks the basename so top-level files match (e.g.
    'README.md' matches '**/*.md').
    """
    normalized = path.replace(os.sep, "/")
    basename = normalized.split("/")[-1]
    for g in globs:
        if fnmatch.fnmatch(normalized, g):
            return True
        # '**/*.ext' should match top-level 'file.ext' (no directory component)
        if g.startswith("**/") and "/" not in normalized:
            if fnmatch.fnmatch(basename, g[3:]):
                return True
    return False


def _sanitize_output_value(value: str) -> str:
    """Strip characters that could inject keys into GitHub env/output files.

    GitHub Actions output files use newlines as record delimiters and '%' as
    the escape character. A raw untrusted string written directly can inject
    extra key=value pairs. Replace these with safe substitutes.
    """
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def write_output(eligible: bool, reason: str) -> None:
    safe_reason = _sanitize_output_value(reason)
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"ELIGIBLE={str(eligible).lower()}\n")
            f.write(f"REASON={safe_reason}\n")
    else:
        # Local testing fallback
        print(f"ELIGIBLE={str(eligible).lower()}")
        print(f"REASON={safe_reason}")


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
