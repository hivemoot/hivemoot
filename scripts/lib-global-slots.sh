#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SHARED_DIR="${SHARED_DIR:-${SCRIPT_DIR}/../shared}"

# shellcheck disable=SC1091
. "${SHARED_DIR}/lib-global-slots.sh"
