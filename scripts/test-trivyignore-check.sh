#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
check_script="$repo_root/scripts/check-trivyignore.sh"
today_utc="$(date -u +%Y-%m-%d)"
tomorrow_utc="$(date -u -d 'tomorrow' +%Y-%m-%d)"
yesterday_utc="$(date -u -d 'yesterday' +%Y-%m-%d)"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

write_report() {
  local output_file="$1"
  shift

  {
    printf '{\n'
    printf '  "Results": [\n'
    printf '    {\n'
    printf '      "Vulnerabilities": [\n'
    local first=1
    local cve
    for cve in "$@"; do
      if [ "$first" -eq 0 ]; then
        printf ',\n'
      fi
      printf '        {"VulnerabilityID":"%s"}' "$cve"
      first=0
    done
    printf '\n'
    printf '      ]\n'
    printf '    }\n'
    printf '  ]\n'
    printf '}\n'
  } > "$output_file"
}

expect_pass() {
  local name="$1"
  local ignore_file="$2"
  local report_file="$3"
  if ! "$check_script" "$ignore_file" "$report_file" >/dev/null 2>&1; then
    echo "FAIL: $name (expected pass)"
    "$check_script" "$ignore_file" "$report_file" || true
    exit 1
  fi
  echo "PASS: $name"
}

expect_fail() {
  local name="$1"
  local ignore_file="$2"
  local report_file="$3"
  if "$check_script" "$ignore_file" "$report_file" >/dev/null 2>&1; then
    echo "FAIL: $name (expected failure)"
    exit 1
  fi
  echo "PASS: $name"
}

report_file="$tmpdir/report.json"
write_report "$report_file" \
  "CVE-2025-10001" \
  "CVE-2025-10002" \
  "CVE-2025-10003" \
  "CVE-2025-10004"

ignore_plain="$tmpdir/plain.trivyignore"
cat > "$ignore_plain" <<'EOF'
CVE-2025-10001
EOF
expect_pass "plain entry without expiry" "$ignore_plain" "$report_file"

ignore_future="$tmpdir/future.trivyignore"
cat > "$ignore_future" <<EOF
# exp:$tomorrow_utc - validate after next scheduled dependency refresh
CVE-2025-10001
EOF
expect_pass "future expiry" "$ignore_future" "$report_file"

ignore_same_day="$tmpdir/same-day.trivyignore"
cat > "$ignore_same_day" <<EOF
# exp:$today_utc - same-day expiry should still pass
CVE-2025-10001
EOF
expect_pass "same-day expiry" "$ignore_same_day" "$report_file"

ignore_expired="$tmpdir/expired.trivyignore"
cat > "$ignore_expired" <<EOF
# exp:$yesterday_utc - should fail once expired
CVE-2025-10001
EOF
expect_fail "expired entry" "$ignore_expired" "$report_file"

ignore_stale="$tmpdir/stale.trivyignore"
cat > "$ignore_stale" <<'EOF'
CVE-2025-99999
EOF
expect_fail "stale suppression not found in report" "$ignore_stale" "$report_file"

ignore_mixed="$tmpdir/mixed.trivyignore"
cat > "$ignore_mixed" <<EOF
# exp:$tomorrow_utc
CVE-2025-10001
# exp:$yesterday_utc
CVE-2025-10002
EOF
expect_fail "multiple entries with one expired" "$ignore_mixed" "$report_file"

ignore_malformed="$tmpdir/malformed-expiry.trivyignore"
cat > "$ignore_malformed" <<'EOF'
# exp:2026-2-01 - malformed month must fail
CVE-2025-10001
EOF
expect_fail "malformed expiry format" "$ignore_malformed" "$report_file"

ignore_invalid_date="$tmpdir/invalid-date-expiry.trivyignore"
cat > "$ignore_invalid_date" <<'EOF'
# exp:2026-02-30 - invalid calendar date must fail
CVE-2025-10001
EOF
expect_fail "invalid calendar expiry date" "$ignore_invalid_date" "$report_file"

echo "All trivyignore checks passed"
