#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
WORKER_DIR="${WORKER_DIR:-${SCRIPT_DIR}/../worker}"

exec "${WORKER_DIR}/drivers/once.sh" "$@"
