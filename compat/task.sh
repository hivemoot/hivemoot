#!/usr/bin/env bash
set -euo pipefail

echo "Driver 'task' has been removed. Task lifecycle is controller-owned; use AGENT_DRIVER=once for workers." >&2
exit 1
