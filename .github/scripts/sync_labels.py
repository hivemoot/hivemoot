#!/usr/bin/env python3
"""
Sync GitHub labels from .github/labels.yml.

Reads label definitions from the YAML file and upserts them via the GitHub
REST API: creates labels that don't exist, updates labels whose color or
description has drifted. Labels not in the YAML are left alone (no deletions).

Exits 0 on success, 1 if any label operation failed.

Usage (in CI):
    python3 .github/scripts/sync_labels.py

Required environment variables:
    GH_TOKEN   — GitHub token with `issues: write` permission
    REPO       — owner/repo slug (e.g. "hivemoot/hivemoot")
    LABELS_FILE (optional) — path to labels YAML, default .github/labels.yml
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    import yaml  # type: ignore
except ImportError:
    # Fallback: install pyyaml then re-import
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pyyaml", "--quiet"])
    import yaml  # type: ignore


def load_labels(path: str) -> list[dict]:
    with open(path) as f:
        data = yaml.safe_load(f)
    labels = data.get("labels", [])
    if not isinstance(labels, list):
        raise ValueError(f"labels.yml 'labels' key must be a list, got {type(labels)}")
    return labels


def api_request(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "hivemoot-sync-labels/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def get_existing_labels(repo: str, token: str) -> dict[str, dict]:
    """Return {name: label_data} for all existing repo labels (paginated)."""
    existing: dict[str, dict] = {}
    page = 1
    while True:
        url = f"https://api.github.com/repos/{repo}/labels?per_page=100&page={page}"
        status, data = api_request("GET", url, token)
        if status != 200:
            raise RuntimeError(f"Failed to list labels: HTTP {status} — {data}")
        if not data:
            break
        for label in data:
            existing[label["name"]] = label
        if len(data) < 100:
            break
        page += 1
    return existing


def upsert_label(repo: str, token: str, name: str, color: str, description: str, existing: dict) -> bool:
    """Create or update a label. Returns True on success."""
    base_url = f"https://api.github.com/repos/{repo}/labels"

    if name in existing:
        current = existing[name]
        # Skip if nothing changed
        if current.get("color") == color and current.get("description", "") == description:
            print(f"  skip  {name!r} (no change)")
            return True
        # Update
        status, data = api_request(
            "PATCH",
            f"{base_url}/{urllib.parse.quote(name, safe='')}",
            token,
            {"color": color, "description": description},
        )
        if status in (200, 201):
            print(f"  update {name!r}")
            return True
        print(f"  ERROR updating {name!r}: HTTP {status} — {data}", file=sys.stderr)
        return False
    else:
        # Create
        status, data = api_request(
            "POST",
            base_url,
            token,
            {"name": name, "color": color, "description": description},
        )
        if status in (200, 201):
            print(f"  create {name!r}")
            return True
        print(f"  ERROR creating {name!r}: HTTP {status} — {data}", file=sys.stderr)
        return False


def main() -> int:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        print("ERROR: GH_TOKEN or GITHUB_TOKEN environment variable is required", file=sys.stderr)
        return 1

    repo = os.environ.get("REPO") or os.environ.get("GITHUB_REPOSITORY")
    if not repo:
        print("ERROR: REPO or GITHUB_REPOSITORY environment variable is required", file=sys.stderr)
        return 1

    labels_file = os.environ.get("LABELS_FILE", ".github/labels.yml")

    try:
        desired = load_labels(labels_file)
    except Exception as e:
        print(f"ERROR: Failed to load {labels_file}: {e}", file=sys.stderr)
        return 1

    print(f"Syncing {len(desired)} labels to {repo}")

    try:
        existing = get_existing_labels(repo, token)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    errors = 0
    for label in desired:
        name = label.get("name", "").strip()
        color = label.get("color", "").lstrip("#").strip()
        description = label.get("description", "").strip()
        if not name or not color:
            print(f"  SKIP malformed entry (missing name or color): {label}", file=sys.stderr)
            errors += 1
            continue
        if not upsert_label(repo, token, name, color, description, existing):
            errors += 1

    if errors:
        print(f"\n{errors} label(s) failed to sync.", file=sys.stderr)
        return 1

    print(f"\nAll labels synced successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
