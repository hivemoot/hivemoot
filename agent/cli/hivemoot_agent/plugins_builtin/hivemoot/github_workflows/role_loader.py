"""Helpers for loading Hivemoot role context via the hivemoot CLI."""

from __future__ import annotations

import json
import subprocess
from typing import Any


class RoleLoadError(RuntimeError):
    """Raised when hivemoot role resolution fails."""


def build_role_prompt_block(payload: Any) -> str:
    """Format a hivemoot role JSON payload into prompt text."""
    if not isinstance(payload, dict):
        raise RoleLoadError("Invalid role JSON payload: missing role object")

    role = payload.get("role")
    if not isinstance(role, dict):
        raise RoleLoadError("Invalid role JSON payload: missing role object")

    name = role.get("name")
    description = role.get("description")
    instructions = role.get("instructions")
    if not isinstance(name, str) or not name:
        raise RoleLoadError("Invalid role JSON payload: missing role.name")
    if not isinstance(description, str):
        raise RoleLoadError("Invalid role JSON payload: missing role.description")
    if not isinstance(instructions, str):
        raise RoleLoadError("Invalid role JSON payload: missing role.instructions")

    onboarding = payload.get("onboarding")
    parts: list[str] = []
    if isinstance(onboarding, str) and onboarding.rstrip():
        parts.append(f"Team onboarding:\n{onboarding.rstrip()}")

    parts.append(
        "Your role on this project is: "
        f"{name}\n"
        f"Role description: {description}\n"
        f"Role instructions: {instructions.rstrip()}"
    )
    return "\n\n".join(parts)


def load_role_prompt_block(role_name: str, repo_full_name: str) -> str:
    """Fetch role context from ``hivemoot role --json`` and format it."""
    try:
        result = subprocess.run(
            ["hivemoot", "role", role_name, "--repo", repo_full_name, "--json"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise RoleLoadError("hivemoot CLI is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RoleLoadError("hivemoot role timed out") from exc

    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        if not detail:
            detail = "hivemoot role exited without an error message"
        raise RoleLoadError(detail)

    stdout = result.stdout.strip()
    if not stdout:
        raise RoleLoadError("hivemoot role returned an empty JSON payload")

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RoleLoadError(f"Invalid role JSON payload: {exc.msg}") from exc

    return build_role_prompt_block(payload)
