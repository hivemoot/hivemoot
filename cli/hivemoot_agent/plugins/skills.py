"""Skill loading and ephemeral plugin-dir generation.

Skills are SKILL.md files that Claude Code discovers via --plugin-dir.
This module provides:
  - load_skills_from_dir(): load Skill objects from a directory tree
  - generate_plugin_dir(): create the ephemeral directory layout
"""

from __future__ import annotations

import json
import os
import tempfile
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
                Skill(name=entry.name, content=skill_file.read_text())
            )
    return skills


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

    # Write each skill.
    skills_root = os.path.join(plugin_dir, "skills")
    os.makedirs(skills_root)
    for skill in skills:
        skill_dir = os.path.join(skills_root, skill.name)
        os.makedirs(skill_dir)
        with open(os.path.join(skill_dir, "SKILL.md"), "w") as f:
            f.write(skill.content)

    return plugin_dir
