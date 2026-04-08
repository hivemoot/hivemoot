#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CONTROLLER_DIR="${CONTROLLER_DIR:-${SCRIPT_DIR}/../controller}"

exec "${CONTROLLER_DIR}/main.sh" "$@"
