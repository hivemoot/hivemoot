#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2317,SC2329  # test fixtures use indirect slot globals and mocked helpers.
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="${SCRIPT_DIR}/lib.sh"
LIB_SLOTS_PATH="${SCRIPT_DIR}/lib-slots.sh"

source_lib() {
  # shellcheck source=scripts/lib.sh
  HIVEMOOT_LIB_LOADED='' source "$LIB_PATH"
  # shellcheck source=scripts/lib-slots.sh
  HIVEMOOT_LIB_SLOTS_LOADED='' source "$LIB_SLOTS_PATH"
}

setup_test_skills() {
  local skills_dir="$1"
  mkdir -p "${skills_dir}/skill-one" "${skills_dir}/skill-two" "${skills_dir}/with-divider" "${skills_dir}/no-frontmatter"

  cat > "${skills_dir}/skill-one/SKILL.md" <<'EOF'
---
name: skill-one
description: First test skill
---
# Skill One

This is the first skill.
EOF

  cat > "${skills_dir}/skill-two/SKILL.md" <<'EOF'
---
name: skill-two
description: Second test skill
---
# Skill Two

This is the second skill.
EOF

  cat > "${skills_dir}/with-divider/SKILL.md" <<'EOF'
---
name: with-divider
description: Skill with horizontal rule
---
# Skill With Divider

Section one

---

Section two
EOF

  cat > "${skills_dir}/no-frontmatter/SKILL.md" <<'EOF'
# Plain Skill

No frontmatter here.
EOF
}

test_strip_frontmatter() {
  echo "Testing strip_frontmatter..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  source_lib

  local with_fm="${tmp_dir}/with-frontmatter.md"
  cat > "$with_fm" <<'EOF'
---
name: test
description: Test skill
---
# Content

Body text here.
EOF

  local result
  result="$(strip_frontmatter "$with_fm")"

  if [[ "$result" == *"name: test"* ]]; then
    fail "strip_frontmatter should remove frontmatter"
  fi

  if [[ "$result" != *"Body text here"* ]]; then
    fail "strip_frontmatter should preserve body content"
  fi

  local no_fm="${tmp_dir}/no-frontmatter.md"
  cat > "$no_fm" <<'EOF'
# Plain Content

No frontmatter.
EOF

  result="$(strip_frontmatter "$no_fm")"

  if [[ "$result" != *"Plain Content"* ]]; then
    fail "strip_frontmatter should handle files without frontmatter"
  fi

  echo "  ✓ strip_frontmatter works correctly"
}

test_frontmatter_with_divider() {
  echo "Testing frontmatter with body dividers..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  source_lib

  local with_divider="${tmp_dir}/with-divider.md"
  cat > "$with_divider" <<'EOF'
---
name: test
description: Test skill
---
# Content

Section one

---

Section two
EOF

  local result
  result="$(strip_frontmatter "$with_divider")"

  if [[ "$result" != *"Section one"* ]]; then
    fail "strip_frontmatter should preserve content before divider"
  fi

  if [[ "$result" != *"Section two"* ]]; then
    fail "strip_frontmatter should preserve content after divider"
  fi

  local divider_count
  divider_count="$(echo "$result" | grep -c '^---$' || true)"

  if [ "$divider_count" -ne 1 ]; then
    fail "strip_frontmatter should preserve exactly one --- in body (found $divider_count)"
  fi

  echo "  ✓ Horizontal rules in body are preserved"
}

test_load_single_skill() {
  echo "Testing single skill loading..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  setup_test_skills "$tmp_dir"
  source_lib

  local result
  result="$(load_skill_prompts "skill-one" "$tmp_dir")"

  if [[ "$result" != *"Skill One"* ]]; then
    fail "load_skill_prompts should load skill content"
  fi

  if [[ "$result" == *"name: skill-one"* ]]; then
    fail "load_skill_prompts should strip frontmatter"
  fi

  if [[ "$result" != *'<skill name="skill-one">'* ]]; then
    fail "load_skill_prompts should wrap skill in <skill> tag"
  fi

  if [[ "$result" != *'</skill>'* ]]; then
    fail "load_skill_prompts should close </skill> tag"
  fi

  echo "  ✓ Single skill loads correctly with XML wrapper"
}

test_load_multiple_skills() {
  echo "Testing multiple skill loading..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  setup_test_skills "$tmp_dir"
  source_lib

  local result
  result="$(load_skill_prompts "skill-one,skill-two" "$tmp_dir")"

  if [[ "$result" != *"Skill One"* ]]; then
    fail "load_skill_prompts should load first skill"
  fi

  if [[ "$result" != *"Skill Two"* ]]; then
    fail "load_skill_prompts should load second skill"
  fi

  if [[ "$result" != *'<skill name="skill-one">'* ]]; then
    fail "load_skill_prompts should wrap first skill in <skill> tag"
  fi

  if [[ "$result" != *'<skill name="skill-two">'* ]]; then
    fail "load_skill_prompts should wrap second skill in <skill> tag"
  fi

  local skill_tag_count
  skill_tag_count="$(echo "$result" | grep -c '</skill>' || true)"
  if [ "$skill_tag_count" -ne 2 ]; then
    fail "Expected 2 </skill> closing tags, found $skill_tag_count"
  fi

  echo "  ✓ Multiple skills load correctly with XML wrappers"
}

test_ensure_skill_files_exist() {
  echo "Testing skill file validation..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  setup_test_skills "$tmp_dir"
  source_lib

  ensure_skill_files_exist "skill-one,skill-two" "$tmp_dir" || \
    fail "ensure_skill_files_exist should accept valid skills"

  if ensure_skill_files_exist "../escape" "$tmp_dir" 2>/dev/null; then
    fail "ensure_skill_files_exist should reject invalid skill names"
  fi

  if ensure_skill_files_exist "missing-skill" "$tmp_dir" 2>/dev/null; then
    fail "ensure_skill_files_exist should fail when a skill file is missing"
  fi

  echo "  ✓ Skill file validation behaves correctly"
}

test_invalid_skill_name() {
  echo "Testing invalid skill name rejection..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  setup_test_skills "$tmp_dir"
  source_lib

  if load_skill_prompts "../escape" "$tmp_dir" 2>/dev/null; then
    fail "load_skill_prompts should reject path traversal in skill name"
  fi

  if load_skill_prompts "skill with spaces" "$tmp_dir" 2>/dev/null; then
    fail "load_skill_prompts should reject spaces in skill name"
  fi

  echo "  ✓ Invalid skill names are rejected"
}

test_missing_skill_file() {
  echo "Testing missing skill file..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  setup_test_skills "$tmp_dir"
  source_lib

  if load_skill_prompts "nonexistent" "$tmp_dir" 2>/dev/null; then
    fail "load_skill_prompts should fail for missing skill file"
  fi

  echo "  ✓ Missing skill files cause failure"
}

test_empty_skill_list() {
  echo "Testing empty skill list..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  source_lib

  local result
  result="$(load_skill_prompts "" "$tmp_dir")"

  if [ -n "$result" ]; then
    fail "load_skill_prompts should return empty for empty skill list"
  fi

  echo "  ✓ Empty skill list returns nothing"
}

test_slot_specific_skill_loading() {
  echo "Testing slot-specific skill loading..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  source_lib

  export AGENT_ID_01="worker"
  export AGENT_GITHUB_TOKEN_01="token-one"
  export AGENT_SKILLS_01="skill-one,skill-two"
  export AGENT_ID_02="builder"
  export AGENT_GITHUB_TOKEN_02="token-two"
  export AGENT_SKILLS="global-skill"

  # shellcheck disable=SC2034  # arrays are populated/consumed indirectly by sourced slot helpers.
  declare -A seen_agents=()
  declare -A agent_skill_lists=()
  # shellcheck disable=SC2034  # arrays are populated/consumed indirectly by sourced slot helpers.
  declare -a agent_ids=()
  # shellcheck disable=SC2034  # arrays are populated/consumed indirectly by sourced slot helpers.
  declare -a agent_tokens=()
  load_agent_slots 2

  if [ "${agent_skill_lists[worker]:-}" != "skill-one,skill-two" ]; then
    fail "load_agent_slots should record slot-specific skills for worker"
  fi

  if [ "${agent_skill_lists[builder]+_}" = "_" ]; then
    fail "load_agent_slots should not create an empty slot-specific skill entry"
  fi

  if [ "$(resolve_agent_skill_list "worker")" != "skill-one,skill-two" ]; then
    fail "resolve_agent_skill_list should prefer slot-specific skills"
  fi

  if [ "$(resolve_agent_skill_list "builder")" != "global-skill" ]; then
    fail "resolve_agent_skill_list should fall back to AGENT_SKILLS"
  fi

  unset AGENT_ID_01 AGENT_GITHUB_TOKEN_01 AGENT_SKILLS_01
  unset AGENT_ID_02 AGENT_GITHUB_TOKEN_02 AGENT_SKILLS

  echo "  ✓ Slot-specific skills resolve correctly"
}

test_preflight_check_agent_skill_lists() {
  echo "Testing preflight agent skill validation..."

  local tmp_dir
  local failures=0
  tmp_dir="$(mktemp -d)"
  trap 'if [ -n "${tmp_dir:-}" ]; then rm -rf "$tmp_dir"; fi' EXIT

  setup_test_skills "$tmp_dir"
  source_lib

  export AGENT_ID_01="worker"
  export AGENT_GITHUB_TOKEN_01="token-one"
  export AGENT_SKILLS_01="skill-one"
  export AGENT_ID_02="builder"
  export AGENT_GITHUB_TOKEN_02="token-two"
  export AGENT_SKILLS_02="skill-one"
  export AGENT_ID_03="reviewer"
  export AGENT_GITHUB_TOKEN_03="token-three"
  export AGENT_SKILLS_03="missing-skill"

  declare -A seen_agents=()
  declare -A agent_skill_lists=()
  declare -a agent_ids=()
  declare -a agent_tokens=()
  load_agent_slots 3

  preflight_check_agent_skill_lists "$tmp_dir" 2>/dev/null || failures=$?
  if [ "$failures" -ne 1 ]; then
    fail "preflight_check_agent_skill_lists should count one missing skill list"
  fi

  unset AGENT_ID_01 AGENT_GITHUB_TOKEN_01 AGENT_SKILLS_01
  unset AGENT_ID_02 AGENT_GITHUB_TOKEN_02 AGENT_SKILLS_02
  unset AGENT_ID_03 AGENT_GITHUB_TOKEN_03 AGENT_SKILLS_03

  echo "  ✓ Preflight agent skill validation deduplicates shared lists"
}

test_shipped_skills_load() {
  echo "Testing shipped skill files load correctly..."

  source_lib

  local skills_dir="${SCRIPT_DIR}/../cli/hivemoot_agent/plugins_builtin/hivemoot_github/skills"
  local expected_skills="security-reviewer code-reviewer test-advocate dep-auditor pr-hygiene"

  for skill in $expected_skills; do
    local skill_file="${skills_dir}/${skill}/SKILL.md"
    if [ ! -f "$skill_file" ]; then
      fail "Shipped skill file missing: ${skill_file}"
    fi

    local result
    result="$(load_skill_prompts "$skill" "$skills_dir")"

    if [ -z "$result" ]; then
      fail "Skill '${skill}' loaded empty content"
    fi

    # Frontmatter must be stripped
    if [[ "$result" == *"name: ${skill}"* ]]; then
      fail "Skill '${skill}' frontmatter not stripped"
    fi

    # Body must contain the skill heading
    if [[ "$result" != *"## Skill:"* ]]; then
      fail "Skill '${skill}' missing expected heading"
    fi

    # Must be wrapped in XML skill tag
    if [[ "$result" != *"<skill name=\"${skill}\">"* ]]; then
      fail "Skill '${skill}' missing <skill> XML wrapper"
    fi

    if [[ "$result" != *"</skill>"* ]]; then
      fail "Skill '${skill}' missing </skill> closing tag"
    fi
  done

  # Test loading all shipped skills at once
  local all_csv
  all_csv="$(echo "$expected_skills" | tr ' ' ',')"
  local combined
  combined="$(load_skill_prompts "$all_csv" "$skills_dir")"

  for skill_name in $expected_skills; do
    # Each skill should appear in combined output (check a unique word from each)
    local check_word
    case "$skill_name" in
      security-reviewer) check_word="Rationalizations to Reject" ;;
      code-reviewer)     check_word="Review Priorities" ;;
      test-advocate)     check_word="Test Advocate" ;;
      dep-auditor)       check_word="Dependency Auditor" ;;
      pr-hygiene)        check_word="PR Hygiene" ;;
    esac
    if [[ "$combined" != *"$check_word"* ]]; then
      fail "Combined load missing content from '${skill_name}'"
    fi
  done

  echo "  ✓ All shipped skills load correctly (${expected_skills// /, })"
}

test_generate_claude_plugin_dir_basic() {
  echo "Testing generate_claude_plugin_dir basic success..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"

  setup_test_skills "$tmp_dir"
  source_lib

  local plugin_dir
  plugin_dir="$(generate_claude_plugin_dir "skill-one,skill-two" "$tmp_dir")"

  if [ -z "$plugin_dir" ]; then
    rm -rf "$tmp_dir"
    fail "generate_claude_plugin_dir should return a non-empty path"
  fi

  if [ ! -f "${plugin_dir}/.claude-plugin/plugin.json" ]; then
    rm -rf "$plugin_dir" "$tmp_dir"
    fail "plugin.json missing from plugin dir"
  fi

  if [ ! -f "${plugin_dir}/skills/skill-one/SKILL.md" ]; then
    rm -rf "$plugin_dir" "$tmp_dir"
    fail "skill-one/SKILL.md not copied into plugin dir"
  fi

  if [ ! -f "${plugin_dir}/skills/skill-two/SKILL.md" ]; then
    rm -rf "$plugin_dir" "$tmp_dir"
    fail "skill-two/SKILL.md not copied into plugin dir"
  fi

  # Frontmatter must be preserved (native Claude dispatch reads it directly)
  if ! grep -q "name: skill-one" "${plugin_dir}/skills/skill-one/SKILL.md"; then
    rm -rf "$plugin_dir" "$tmp_dir"
    fail "generate_claude_plugin_dir must preserve frontmatter (raw cp)"
  fi

  rm -rf "$plugin_dir" "$tmp_dir"
  echo "  ✓ generate_claude_plugin_dir builds correct layout with frontmatter intact"
}

test_generate_claude_plugin_dir_all_mode() {
  echo "Testing generate_claude_plugin_dir with 'all' keyword..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"

  setup_test_skills "$tmp_dir"
  source_lib

  local plugin_dir
  plugin_dir="$(generate_claude_plugin_dir "all" "$tmp_dir")"

  if [ -z "$plugin_dir" ]; then
    rm -rf "$tmp_dir"
    fail "generate_claude_plugin_dir 'all' should return a non-empty path"
  fi

  # Should discover all skills that have SKILL.md
  local skill_count
  skill_count="$(find "${plugin_dir}/skills" -name 'SKILL.md' | wc -l | tr -d ' ')"

  if [ "$skill_count" -lt 2 ]; then
    rm -rf "$plugin_dir" "$tmp_dir"
    fail "generate_claude_plugin_dir 'all' should discover multiple skills, found ${skill_count}"
  fi

  rm -rf "$plugin_dir" "$tmp_dir"
  echo "  ✓ generate_claude_plugin_dir 'all' auto-discovers all skills (found ${skill_count})"
}

test_generate_claude_plugin_dir_cp_failure() {
  echo "Testing generate_claude_plugin_dir fails closed on cp failure..."

  local tmp_dir
  tmp_dir="$(mktemp -d)"

  setup_test_skills "$tmp_dir"
  source_lib

  # Override cp to simulate a write failure
  # shellcheck disable=SC2317  # cp is overridden for the sourced helper under test.
  cp() { return 1; }

  local plugin_dir before_count after_count
  before_count="$(find /tmp -maxdepth 1 -name 'tmp.*' -type d 2>/dev/null | wc -l || echo 0)"

  if plugin_dir="$(generate_claude_plugin_dir "skill-one" "$tmp_dir" 2>/dev/null)"; then
    unset -f cp
    rm -rf "$tmp_dir"
    fail "generate_claude_plugin_dir should return non-zero when cp fails"
  fi

  unset -f cp

  after_count="$(find /tmp -maxdepth 1 -name 'tmp.*' -type d 2>/dev/null | wc -l || echo 0)"

  if [ "$after_count" -gt "$before_count" ]; then
    rm -rf "$tmp_dir"
    fail "generate_claude_plugin_dir leaked a temp dir on cp failure (before=$before_count after=$after_count)"
  fi

  rm -rf "$tmp_dir"
  echo "  ✓ generate_claude_plugin_dir fails closed and cleans up on cp failure"
}

echo "Running skill loading tests..."
echo

test_strip_frontmatter
test_frontmatter_with_divider
test_load_single_skill
test_load_multiple_skills
test_ensure_skill_files_exist
test_invalid_skill_name
test_missing_skill_file
test_empty_skill_list
test_slot_specific_skill_loading
test_preflight_check_agent_skill_lists
test_shipped_skills_load
test_generate_claude_plugin_dir_basic
test_generate_claude_plugin_dir_all_mode
test_generate_claude_plugin_dir_cp_failure

echo
echo "All skill loading tests passed!"
