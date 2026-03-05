#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_PATH="${SCRIPT_DIR}/lib.sh"

source_lib() {
  # shellcheck source=scripts/lib.sh
  HIVEMOOT_LIB_LOADED='' source "$LIB_PATH"
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

  echo "  ✓ Single skill loads correctly"
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

  echo "  ✓ Multiple skills load correctly"
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

echo "Running skill loading tests..."
echo

test_strip_frontmatter
test_frontmatter_with_divider
test_load_single_skill
test_load_multiple_skills
test_invalid_skill_name
test_missing_skill_file
test_empty_skill_list

echo
echo "All skill loading tests passed!"
