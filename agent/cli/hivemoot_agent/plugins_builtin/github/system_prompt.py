"""GitHub plugin — system prompt template.

Injects repo locations and environment facts the agent can't discover
on its own.  Does NOT teach git/GitHub workflow — the agent knows that.
"""

from __future__ import annotations

from hivemoot_agent.plugins_builtin.github.repo_manager import RepoInfo

SYSTEM_PROMPT = """\
{identity_section}\
## Pre-cloned repositories

{repo_section}

The `gh` CLI is authenticated and ready to use.
{shallow_note}\
"""

_SHALLOW_NOTE = """
Shallow clone (depth {depth}) — `git log`/`git blame` are truncated. \
Run `git fetch --unshallow` if you need full history.
"""


def build_system_prompt(
    repos: list[RepoInfo],
    clone_depth: int = 50,
    git_user: str = "",
) -> str:
    """Build the system prompt with cloned repo context."""
    identity_section = ""
    if git_user:
        identity_section = (
            f"You are authenticated as **@{git_user}** on GitHub. "
            f"Commits and PRs will be authored under this identity.\n\n"
        )

    if not repos:
        repo_section = "No repositories were pre-cloned."
    elif len(repos) == 1:
        r = repos[0]
        repo_section = (
            f"**{r.repo}** — `{r.path}` "
            f"(branch: `{r.default_branch}`)"
        )
    else:
        lines = []
        for r in repos:
            lines.append(
                f"- **{r.repo}** → `{r.path}` "
                f"(branch: `{r.default_branch}`)"
            )
        repo_section = "\n".join(lines)

    shallow_note = ""
    if clone_depth > 0 and repos:
        shallow_note = _SHALLOW_NOTE.format(depth=clone_depth)

    return SYSTEM_PROMPT.format(
        identity_section=identity_section,
        repo_section=repo_section,
        shallow_note=shallow_note,
    )
