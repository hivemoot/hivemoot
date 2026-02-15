#!/usr/bin/env bash
set -euo pipefail

ignore_file="${1:-.trivyignore}"
report_file="${2:-trivy-report.json}"

if [ ! -f "$ignore_file" ]; then
  echo "Ignore file not found: $ignore_file" >&2
  exit 1
fi

if [ ! -f "$report_file" ]; then
  echo "Trivy report not found: $report_file" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for stale-ignore validation" >&2
  exit 1
fi

ignored_cves="$({
  grep -Eo 'CVE-[0-9]{4}-[0-9]+' "$ignore_file" || true
} | sort -u)"

if [ -z "$ignored_cves" ]; then
  echo "No CVEs listed in $ignore_file"
  exit 0
fi

present_cves="$(jq -r '
  ..
  | objects
  | select(has("VulnerabilityID"))
  | .VulnerabilityID
' "$report_file" \
  | grep -E '^CVE-[0-9]{4}-[0-9]+$' || true \
  | sort -u)"

stale_cves="$(comm -23 \
  <(printf '%s\n' "$ignored_cves") \
  <(printf '%s\n' "$present_cves"))"

if [ -n "$stale_cves" ]; then
  echo "Stale CVE suppressions found in $ignore_file:" >&2
  while IFS= read -r cve; do
    [ -n "$cve" ] || continue
    echo "  - $cve" >&2
  done <<< "$stale_cves"
  echo "Remove stale entries or rerun Trivy if the report is outdated." >&2
  exit 1
fi

echo "All CVEs in $ignore_file are present in $report_file"
