#!/usr/bin/env bash
# Deprecation stub — see controller/main.sh for the full migration note.
# Apiary and other external callers that used to exec this wrapper hit
# the same clear error instead of a cryptic "file not found."
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec "${script_dir}/../controller/main.sh" "$@"
