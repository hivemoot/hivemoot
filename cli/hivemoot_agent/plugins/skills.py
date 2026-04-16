"""Skill loading, prompt rendering, and ephemeral plugin-dir generation."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from collections.abc import Iterable
from pathlib import Path

from hivemoot_agent.plugins.interfaces import Skill


def load_skills_from_dir(skills_dir: Path) -> list[Skill]:
    """Load skills from a directory of ``<name>/SKILL.md`` entries.

    Each subdirectory with a SKILL.md file becomes one Skill whose name
    is the subdirectory name and whose content is the raw file bytes.
    """
    if not skills_dir.is_dir():
        return []

    skills: list[Skill] = []
    for entry in sorted(skills_dir.iterdir()):
        skill_file = entry / "SKILL.md"
        if entry.is_dir() and skill_file.is_file():
            skills.append(
                Skill(
                    name=entry.name,
                    content=skill_file.read_text(),
                    source_dir=str(entry.resolve()),
                )
            )
    return skills


def collect_skills_from_dirs(skill_dirs: Iterable[Path]) -> dict[str, Skill]:
    """Collect skills from multiple directories, keeping the first match."""
    seen: dict[str, Skill] = {}
    for skills_dir in skill_dirs:
        for skill in load_skills_from_dir(skills_dir):
            if skill.name not in seen:
                seen[skill.name] = skill
    return seen


def load_named_skills(
    skills_list: str,
    skill_dirs: Iterable[Path],
    *,
    context: str,
) -> list[Skill]:
    """Load a validated skill list from the given search directories.

    Supports comma-separated skill names plus the special value ``all``.
    Raises ``ValueError`` on invalid names or missing files.
    """
    requested = (skills_list or "").strip()
    if not requested:
        return []

    available = collect_skills_from_dirs(skill_dirs)
    if requested == "all":
        if not available:
            raise ValueError(f"no skills found ({context}=all)")
        return list(available.values())

    result: list[Skill] = []
    for raw_name in requested.split(","):
        skill_name = raw_name.strip()
        if not skill_name:
            continue
        if any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for ch in skill_name):
            raise ValueError(f"Invalid skill name: '{skill_name}' ({context}={skills_list})")
        skill = available.get(skill_name)
        if skill is None:
            raise ValueError(f"Skill file not found: {skill_name} ({context}={skills_list})")
        result.append(skill)
    return result


def _strip_frontmatter(content: str) -> str:
    """Strip simple YAML frontmatter from a SKILL.md body."""
    lines = content.splitlines()
    if lines and lines[0].strip() == "---":
        for idx in range(1, len(lines)):
            if lines[idx].strip() == "---":
                return "\n".join(lines[idx + 1 :]).strip()
    return content.strip()


def render_prompt_skills(skills: list[Skill]) -> str:
    """Render skills into the legacy prompt-injection XML block."""
    if not skills:
        return ""

    parts = []
    for skill in skills:
        parts.append(
            f'<skill name="{skill.name}">\n'
            f"{_strip_frontmatter(skill.content)}\n"
            "</skill>"
        )
    return "<skills>\n" + "\n\n".join(parts) + "\n</skills>"


def generate_plugin_dir(skills: list[Skill]) -> str:
    """Create an ephemeral Claude --plugin-dir layout.

    Writes the following structure to a new temp directory::

        <tmpdir>/.claude-plugin/plugin.json
        <tmpdir>/skills/<name>/SKILL.md

    Returns the temp directory path.  Callers must clean up via
    ``shutil.rmtree()`` when the agent run completes.
    """
    plugin_dir = tempfile.mkdtemp(prefix="hivemoot-skills-")

    # plugin.json — matches the bash worker's layout.
    meta_dir = os.path.join(plugin_dir, ".claude-plugin")
    os.makedirs(meta_dir)
    with open(os.path.join(meta_dir, "plugin.json"), "w") as f:
        json.dump(
            {
                "name": "hivemoot-skills",
                "version": "1.0.0",
                "description": "Composable skill modules for hivemoot-agent",
            },
            f,
        )

    # Write each skill, preserving bundled assets when available.
    skills_root = os.path.join(plugin_dir, "skills")
    os.makedirs(skills_root)
    for skill in skills:
        skill_dir = os.path.join(skills_root, skill.name)
        source_dir = Path(skill.source_dir)
        if source_dir.is_dir():
            shutil.copytree(source_dir, skill_dir, dirs_exist_ok=False)
            continue
        os.makedirs(skill_dir)
        with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
            f.write(skill.content)

    return plugin_dir
