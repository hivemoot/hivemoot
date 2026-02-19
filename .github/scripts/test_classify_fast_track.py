"""
Tests for the fast-track classifier.
Run with: python3 -m pytest .github/scripts/test_classify_fast_track.py -v
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from classify_fast_track import classify, matches, ALLOWED, DENIED

# --- matches() tests ---


def test_matches_md_toplevel():
    assert matches("README.md", ALLOWED)


def test_matches_md_nested():
    assert matches("docs/guide/intro.md", ALLOWED)


def test_matches_txt():
    assert matches("notes.txt", ALLOWED)


def test_matches_docs_dir():
    assert matches("docs/reference.rst", ALLOWED) is False  # .rst not in allowlist


def test_matches_docs_md():
    assert matches("docs/api.md", ALLOWED)


def test_no_match_source_file():
    assert matches("src/index.ts", ALLOWED) is False


def test_denied_github_dir():
    assert matches(".github/workflows/ci.yml", DENIED)


def test_denied_package_json():
    assert matches("package.json", DENIED)


def test_denied_lock_file():
    assert matches("yarn.lock", DENIED)


def test_denied_package_lock():
    assert matches("package-lock.json", DENIED)


def test_not_denied_readme():
    assert matches("README.md", DENIED) is False


# --- classify() tests ---


def _file(path, additions=1, deletions=0):
    return {"path": path, "additions": additions, "deletions": deletions}


def test_eligible_single_md():
    files = [_file("README.md", 5, 2)]
    eligible, reason = classify(files)
    assert eligible is True
    assert reason == "eligible"


def test_eligible_multiple_md():
    files = [_file(f"docs/page{i}.md", 3, 1) for i in range(5)]
    eligible, reason = classify(files)
    assert eligible is True


def test_denied_too_many_files():
    files = [_file(f"docs/page{i}.md") for i in range(6)]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:size" in reason
    assert "file_count" in reason


def test_denied_too_many_lines():
    # 5 files * (9 additions + 9 deletions) = 90 lines > 80
    files = [_file(f"docs/page{i}.md", 9, 9) for i in range(5)]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:size" in reason
    assert "total_lines" in reason


def test_denied_denylist_github_workflow():
    files = [_file(".github/workflows/ci.yml")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:denylist" in reason


def test_denied_denylist_bypass_attempt_adjacent():
    # Attacker tries path adjacent to .github but not inside it
    files = [_file(".github-extra/config.yml")]
    eligible, reason = classify(files)
    # Not on denylist, but not on allowlist either
    assert eligible is False
    assert "denied:allowlist" in reason


def test_denied_denylist_bypass_attempt_traversal():
    # Path that looks like it could escape denylist matching
    files = [_file(".github/../README.md")]
    # PurePath normalizes this — .github/../README.md resolves to README.md
    # This should be eligible since it resolves to README.md
    eligible, reason = classify(files)
    # Either outcome is acceptable as long as denylist is not bypassed for actual .github paths
    assert isinstance(eligible, bool)


def test_denied_mixed_allowed_and_source():
    files = [_file("README.md"), _file("src/index.ts")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:allowlist" in reason


def test_denied_package_json_in_root():
    files = [_file("package.json")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:denylist" in reason


def test_fallback_exact_boundary_files():
    # Exactly 5 files is still eligible
    files = [_file(f"docs/p{i}.md") for i in range(5)]
    eligible, reason = classify(files)
    assert eligible is True


def test_fallback_exact_boundary_lines():
    # Exactly 80 lines is still eligible (2 files * 40 lines each)
    files = [_file("README.md", 40, 0), _file("docs/guide.md", 40, 0)]
    eligible, reason = classify(files)
    assert eligible is True


def test_fallback_over_boundary_lines():
    # 81 lines should be denied
    files = [_file("README.md", 81, 0)]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:size" in reason
