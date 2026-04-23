#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

missing=()
while IFS= read -r script_path; do
  if [ ! -x "$script_path" ]; then
    missing+=("$script_path")
  fi
done < <(find "$repo_root/scripts" -maxdepth 1 -type f -name 'test-*.sh' | sort)

if [ "${#missing[@]}" -gt 0 ]; then
  echo "FAIL: expected executable bit on all scripts/test-*.sh files" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "PASS: all scripts/test-*.sh files are executable"
