"""Tests for the GitHub plugin — repo manager, prompt, and plugin class."""

import os
import subprocess
import sys
import tempfile
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hivemoot_agent.plugins.interfaces import PluginConfig
from hivemoot_agent.plugins_builtin.github.repo_manager import (
    parse_repos,
    RepoInfo,
    repo_checkout_path,
)
from hivemoot_agent.plugins_builtin.github.system_prompt import build_system_prompt
from hivemoot_agent.plugins_builtin.github import GitHubPlugin


# ── parse_repos tests ────────────────────────────────────────────


def test_parse_single_repo():
    assert parse_repos("owner/repo") == ["owner/repo"]


def test_parse_multiple_repos():
    assert parse_repos("a/one, b/two, c/three") == [
        "a/one", "b/two", "c/three",
    ]


def test_parse_empty_string():
    assert parse_repos("") == []


def test_parse_whitespace():
    assert parse_repos("  ,  ,  ") == []


def test_parse_invalid_format():
    try:
        parse_repos("no-slash")
        assert False, "Should raise ValueError"
    except ValueError as e:
        assert "owner/repo" in str(e)


def test_parse_too_many_slashes():
    try:
        parse_repos("a/b/c")
        assert False, "Should raise ValueError"
    except ValueError as e:
        assert "owner/repo" in str(e)


def test_repo_checkout_path_uses_owner_prefix():
    assert repo_checkout_path("/workspace", "foo/app") == "/workspace/foo/app"
    assert repo_checkout_path("/workspace", "bar/app") == "/workspace/bar/app"


# ── build_system_prompt tests ────────────────────────────────────


def test_prompt_empty_repos():
    prompt = build_system_prompt([], clone_depth=50)
    assert "No repositories were pre-cloned" in prompt
    assert "Shallow clone" not in prompt


def test_prompt_single_repo():
    repos = [RepoInfo(repo="acme/api", path="/workspace/api", default_branch="main")]
    prompt = build_system_prompt(repos, clone_depth=50)
    assert "acme/api" in prompt
    assert "/workspace/api" in prompt
    assert "main" in prompt
    assert "Shallow clone" in prompt


def test_prompt_multiple_repos():
    repos = [
        RepoInfo(repo="acme/api", path="/workspace/api", default_branch="main"),
        RepoInfo(repo="acme/web", path="/workspace/web", default_branch="develop"),
    ]
    prompt = build_system_prompt(repos, clone_depth=0)
    assert "acme/api" in prompt
    assert "acme/web" in prompt
    assert "/workspace/api" in prompt
    assert "/workspace/web" in prompt
    # Full clone — no shallow note.
    assert "Shallow clone" not in prompt


def test_prompt_with_identity():
    repos = [RepoInfo(repo="acme/api", path="/workspace/api", default_branch="main")]
    prompt = build_system_prompt(repos, clone_depth=50, git_user="bot-user")
    assert "@bot-user" in prompt
    assert "authenticated" in prompt


def test_prompt_without_identity():
    repos = [RepoInfo(repo="acme/api", path="/workspace/api", default_branch="main")]
    prompt = build_system_prompt(repos, clone_depth=50)
    assert "authenticated as" not in prompt


def test_prompt_full_clone_no_shallow_note():
    repos = [RepoInfo(repo="x/y", path="/w/y", default_branch="main")]
    prompt = build_system_prompt(repos, clone_depth=0)
    assert "Shallow clone" not in prompt


# ── GitHubPlugin.validate tests ──────────────────────────────────


def test_validate_ok():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "acme/api",
    })
    assert plugin.validate(config) == []


def test_validate_missing_token():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_REPOS": "acme/api",
    })
    errors = plugin.validate(config)
    assert len(errors) == 1
    assert "GITHUB_TOKEN" in errors[0]


def test_validate_missing_repos():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
    })
    errors = plugin.validate(config)
    assert len(errors) == 1
    assert "GITHUB_REPOS" in errors[0]


def test_validate_invalid_repos():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "bad-format",
    })
    errors = plugin.validate(config)
    assert len(errors) == 1
    assert "owner/repo" in errors[0]


def test_validate_both_missing():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={})
    errors = plugin.validate(config)
    assert len(errors) == 2


# ── GitHubPlugin.system_prompt tests ─────────────────────────────


def test_system_prompt_before_clone():
    """system_prompt() works even before on_job_started clones repos."""
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "acme/api,acme/web",
        "GITHUB_WORKSPACE": "/workspace",
    })
    prompt = plugin.system_prompt(config)
    assert "acme/api" in prompt
    assert "acme/web" in prompt
    assert "/workspace/acme/api" in prompt
    assert "/workspace/acme/web" in prompt


def test_system_prompt_before_clone_uses_workspace_root_when_github_workspace_empty():
    """Empty GITHUB_WORKSPACE should fall back to WORKSPACE_ROOT."""
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "acme/api",
        "GITHUB_WORKSPACE": "",
        "WORKSPACE_ROOT": "/workspace/repo",
    })
    prompt = plugin.system_prompt(config)
    assert "/workspace/repo/acme/api" in prompt


def test_system_prompt_after_clone():
    """system_prompt() uses real repo info after on_job_started."""
    plugin = GitHubPlugin()
    plugin._repos = [
        RepoInfo(repo="acme/api", path="/workspace/api", default_branch="develop"),
    ]
    config = PluginConfig(name="github", settings={
        "GITHUB_CLONE_DEPTH": "100",
    })
    prompt = plugin.system_prompt(config)
    assert "acme/api" in prompt
    assert "develop" in prompt


def test_setup_failure_does_not_fabricate_placeholder_paths():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "acme/api",
        "GITHUB_WORKSPACE": "/workspace",
    })

    with patch(
        "hivemoot_agent.plugins_builtin.github.clone_or_sync",
        side_effect=RuntimeError("boom"),
    ):
        try:
            plugin.setup(config)
            assert False, "Should raise RuntimeError"
        except RuntimeError as e:
            assert "acme/api" in str(e)

    prompt = plugin.system_prompt(config)
    assert "No repositories were pre-cloned" in prompt
    assert "/workspace/acme/api" not in prompt


def test_setup_configures_git_credential_helper():
    plugin = GitHubPlugin()

    with tempfile.TemporaryDirectory(prefix="hm-gh-plugin-") as tmpdir:
        home_dir = os.path.join(tmpdir, "home")
        bin_dir = os.path.join(tmpdir, "bin")
        repo_path = os.path.join(tmpdir, "workspace", "acme", "api")
        os.makedirs(home_dir)
        os.makedirs(bin_dir)
        os.makedirs(repo_path)

        gh_path = os.path.join(bin_dir, "gh")
        with open(gh_path, "w", encoding="utf-8") as fh:
            fh.write(
                "#!/usr/bin/env sh\n"
                "set -eu\n"
                "if [ \"$#\" -eq 2 ] && [ \"$1\" = \"auth\" ] && [ \"$2\" = \"setup-git\" ]; then\n"
                "  test -n \"${GH_TOKEN:-}\"\n"
                "  git config --global credential.helper '!gh auth git-credential'\n"
                "  exit 0\n"
                "fi\n"
                "if [ \"$#\" -eq 4 ] && [ \"$1\" = \"api\" ] && [ \"$2\" = \"repos/acme/api\" ] && [ \"$3\" = \"--jq\" ] && [ \"$4\" = \".full_name\" ]; then\n"
                "  printf '%s\\n' 'acme/api'\n"
                "  exit 0\n"
                "fi\n"
                "echo \"unexpected gh invocation: $*\" >&2\n"
                "exit 1\n"
            )
        os.chmod(gh_path, 0o755)

        config = PluginConfig(name="github", settings={
            "GITHUB_TOKEN": "ghp_test",
            "GITHUB_REPOS": "acme/api",
            "GITHUB_WORKSPACE": os.path.join(tmpdir, "workspace"),
        })

        old_home = os.environ.get("HOME")
        old_path = os.environ.get("PATH", "")
        old_gh_token = os.environ.get("GH_TOKEN")
        old_github_token = os.environ.get("GITHUB_TOKEN")
        os.environ["HOME"] = home_dir
        os.environ["PATH"] = f"{bin_dir}:{old_path}"
        os.environ.pop("GH_TOKEN", None)
        os.environ.pop("GITHUB_TOKEN", None)

        try:
            with patch(
                "hivemoot_agent.plugins_builtin.github.clone_or_sync",
                return_value=RepoInfo(
                    repo="acme/api",
                    path=repo_path,
                    default_branch="main",
                ),
            ), patch(
                "hivemoot_agent.plugins_builtin.github.resolve_github_user",
                return_value=("tester", "tester@users.noreply.github.com"),
            ):
                plugin.setup(config)

            result = subprocess.run(
                ["git", "config", "--global", "--get", "credential.helper"],
                capture_output=True,
                text=True,
                env={**os.environ, "HOME": home_dir},
                timeout=10,
            )
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home
            os.environ["PATH"] = old_path
            if old_gh_token is None:
                os.environ.pop("GH_TOKEN", None)
            else:
                os.environ["GH_TOKEN"] = old_gh_token
            if old_github_token is None:
                os.environ.pop("GITHUB_TOKEN", None)
            else:
                os.environ["GITHUB_TOKEN"] = old_github_token

    assert result.returncode == 0
    assert result.stdout.strip() == "!gh auth git-credential"


def test_setup_uses_workspace_root_when_github_workspace_empty():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "acme/api",
        "GITHUB_WORKSPACE": "",
        "WORKSPACE_ROOT": "/workspace/repo",
    })

    with patch(
        "hivemoot_agent.plugins_builtin.github._configure_git_auth",
    ), patch(
        "hivemoot_agent.plugins_builtin.github._validate_repo_access",
    ), patch(
        "hivemoot_agent.plugins_builtin.github.resolve_github_user",
        return_value=("tester", "tester@users.noreply.github.com"),
    ), patch(
        "hivemoot_agent.plugins_builtin.github.clone_or_sync",
        return_value=RepoInfo(
            repo="acme/api",
            path="/workspace/repo/acme/api",
            default_branch="main",
        ),
    ) as clone_or_sync:
        plugin.setup(config)

    assert clone_or_sync.call_args[0][1] == "/workspace/repo"


def test_setup_fails_fast_when_repo_access_validation_fails():
    plugin = GitHubPlugin()
    config = PluginConfig(name="github", settings={
        "GITHUB_TOKEN": "ghp_test",
        "GITHUB_REPOS": "acme/api",
        "GITHUB_WORKSPACE": "/workspace",
    })

    def fake_subprocess_run(cmd, **kwargs):
        if cmd == ["gh", "auth", "setup-git"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if cmd == ["gh", "api", "repos/acme/api", "--jq", ".full_name"]:
            return subprocess.CompletedProcess(
                cmd, 1, stdout="", stderr="HTTP 404: Not Found"
            )
        raise AssertionError(f"unexpected subprocess.run call: {cmd}")

    with patch(
        "hivemoot_agent.plugins_builtin.github.resolve_github_user",
        return_value=("tester", "tester@users.noreply.github.com"),
    ), patch(
        "hivemoot_agent.plugins_builtin.github.clone_or_sync",
    ) as clone_or_sync, patch(
        "hivemoot_agent.plugins_builtin.github.subprocess.run",
        side_effect=fake_subprocess_run,
    ):
        try:
            plugin.setup(config)
            assert False, "Expected setup() to raise when repo access validation fails"
        except RuntimeError as exc:
            assert "Failed to validate access for acme/api" in str(exc)
            assert "HTTP 404: Not Found" in str(exc)

    clone_or_sync.assert_not_called()


# ── GitHubPlugin.triggers tests ──────────────────────────────────


def test_no_triggers():
    plugin = GitHubPlugin()
    assert plugin.triggers() == []


# ── create_plugin tests ──────────────────────────────────────────


def test_create_plugin():
    from hivemoot_agent.plugins_builtin.github import create_plugin
    plugin = create_plugin()
    assert plugin.name == "github"
    assert plugin.version == "0.1.0"


if __name__ == "__main__":
    import inspect

    passed = 0
    failed = 0
    for name, func in sorted(
        inspect.getmembers(sys.modules[__name__], inspect.isfunction)
    ):
        if not name.startswith("test_"):
            continue
        try:
            func()
            print(f"  \u2713 {name}")
            passed += 1
        except Exception as e:
            print(f"  \u2717 {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
