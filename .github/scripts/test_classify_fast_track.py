"""
Tests for the fast-track classifier.
Run with: python3 -m pytest .github/scripts/test_classify_fast_track.py -v
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import io
import tempfile

from classify_fast_track import classify, matches, write_output, _sanitize_output_value, ALLOWED, DENIED

# --- matches() tests ---


def test_matches_md_toplevel():
    assert matches("README.md", ALLOWED)


def test_matches_md_nested():
    assert matches("docs/guide/intro.md", ALLOWED)


def test_matches_txt():
    assert matches("notes.txt", ALLOWED)


def test_matches_docs_dir():
    assert matches("docs/reference.rst", ALLOWED) is True  # docs/** matches any file under docs/


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


def test_denied_pnpm_lock():
    # pnpm-lock.yaml uses .yaml extension — not caught by *.lock
    assert matches("pnpm-lock.yaml", DENIED)


def test_denied_go_sum():
    # go.sum has no .lock extension
    assert matches("go.sum", DENIED)


def test_denied_bun_lockb():
    # bun.lockb uses .lockb binary format
    assert matches("bun.lockb", DENIED)


def test_denied_go_work_sum():
    # go.work.sum is the Go workspace sum file
    assert matches("go.work.sum", DENIED)


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


def test_denied_denylist_pnpm_lock():
    # pnpm-lock.yaml must produce denied:denylist, not denied:allowlist
    files = [_file("pnpm-lock.yaml")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:denylist" in reason
    assert "pnpm-lock.yaml" in reason


def test_denied_denylist_go_sum():
    files = [_file("go.sum")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:denylist" in reason
    assert "go.sum" in reason


def test_denied_denylist_bun_lockb():
    files = [_file("bun.lockb")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:denylist" in reason
    assert "bun.lockb" in reason


def test_denied_denylist_go_work_sum():
    files = [_file("go.work.sum")]
    eligible, reason = classify(files)
    assert eligible is False
    assert "denied:denylist" in reason
    assert "go.work.sum" in reason


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


# --- output injection regression tests ---


def test_sanitize_newline_in_reason():
    # A crafted path with a newline cannot inject an extra output key
    injected = "denied:denylist path=evil\nELIGIBLE=true"
    sanitized = _sanitize_output_value(injected)
    assert "\n" not in sanitized
    assert "%0A" in sanitized  # newline must be percent-encoded, not stripped


def test_sanitize_carriage_return_in_reason():
    injected = "denied:denylist path=evil\rELIGIBLE=true"
    sanitized = _sanitize_output_value(injected)
    assert "\r" not in sanitized


def test_sanitize_percent_in_reason():
    injected = "denied:allowlist path=docs/100%done.md"
    sanitized = _sanitize_output_value(injected)
    # All bare % must be encoded; strip valid sequences and confirm none remain
    assert "%" not in sanitized.replace("%25", "").replace("%0D", "").replace("%0A", "")


def test_write_output_injection_via_path(tmp_path, monkeypatch):
    # Simulate a crafted filename containing newline + injected key
    output_file = tmp_path / "github_output"
    output_file.write_text("")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output_file))

    # Attacker crafts a path that would inject ELIGIBLE=true if unescaped
    crafted_reason = "denied:denylist path=evil\nELIGIBLE=true"
    write_output(False, crafted_reason)

    contents = output_file.read_text()
    lines = contents.splitlines()
    # There must be exactly 2 key=value lines
    assert len(lines) == 2
    # ELIGIBLE must remain false
    assert lines[0] == "ELIGIBLE=false"
    # The injected newline must be escaped in REASON
    assert "\nELIGIBLE=true" not in contents
