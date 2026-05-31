"""Render a desired-state agent into concrete container inputs.

A Python port of the relevant `deploy-apiary.sh` rendering (write_standing_*),
driven by the desired-state entry instead of static YAML. Produces the
`hivemoot.yaml`, `identity.md`, and `env` the agent container reads, plus a
content-addressed `config_hash` used to detect "changed" without inspecting a
running container's internals.

This is a near-passthrough of the agent's `plugins` block (the canonical config
shape — mirrors `FleetPlugins` in web/src/server/fleet-store.ts) plus the always-
on plumbing the dashboard never exposes: `hivemoot.health` (per-agent, NO repo),
the `hivemoot.apiarist` token broker (its `repo` = `plugins.github.repos[0]` when
github is enabled, else omitted — task-only agents mint per-task), and
`github_workflows`. The `github`/`cron`/`tasks`/`war_rooms` blocks are emitted
only when their plugin is enabled. `repos` live ONLY under `plugins.github`.

NOTE: the exact `hivemoot.yaml` plugin schema must be re-verified against the
agent runtime when the reconciler is first ENABLED on a hive (it ships disabled).
Plugin-block ORDER is load-bearing: `hivemoot` is emitted before `github` so the
apiarist token subscriber populates GITHUB_TOKEN before the github clone reads it.
Plain dicts preserve insertion order (CPython 3.7+), so the YAML key order is the
build order below.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import yaml

from apiarist.features.reconcile.models import (
    SPEC_VERSION,
    DesiredAgent,
    RenderedContainer,
    container_name_for,
)

# Provider → the env var naming the secret file the container mounts. The files
# themselves are staged into the per-agent secrets dir by the apiary deploy.
_PROVIDER_KEY_FILE_ENV = {
    "zai": ("ZAI_API_KEY_FILE", "/run/secrets/zai-api-key"),
    "openrouter": ("OPENROUTER_API_KEY_FILE", "/run/secrets/openrouter-api-key"),
}


def render_agent(
    agent: DesiredAgent,
    *,
    backend_url: str,
    image: str,
) -> RenderedContainer:
    hivemoot_yaml = _render_hivemoot_yaml(agent, backend_url=backend_url)
    identity_md = _render_identity(agent)
    env = _render_env(agent, backend_url=backend_url)
    config_hash = _config_hash(
        hivemoot_yaml=hivemoot_yaml,
        identity_md=identity_md,
        env=env,
        image=image,
    )
    return RenderedContainer(
        container_name=container_name_for(agent.name),
        agent_name=agent.name,
        # The `dev.hivemoot.repo` Docker label: the primary github repo when the
        # github plugin is enabled, else "" (label-only/observability; a task-
        # only agent has no repo and an empty label is safe).
        repo=_primary_repo(agent),
        engine_id=agent.engine.id,
        image=image,
        hivemoot_yaml=hivemoot_yaml,
        identity_md=identity_md,
        env=env,
        config_hash=config_hash,
    )


def _primary_repo(agent: DesiredAgent) -> str:
    """The agent's primary repo: `plugins.github.repos[0]` when the github
    plugin is enabled and has repos, else "". Repos live ONLY under github."""
    github = agent.plugins.github
    if github is not None and github.enabled and github.repos:
        return github.repos[0]
    return ""


def _render_hivemoot_yaml(agent: DesiredAgent, *, backend_url: str) -> str:
    p = agent.plugins
    base = backend_url.rstrip("/")
    primary_repo = _primary_repo(agent)

    # hivemoot plugin (emitted FIRST — load-bearing order for the broker path).
    # health is per-agent now: NO `repo` field. The apiarist broker's `repo` is
    # the primary github repo when github is enabled; OMITTED entirely for
    # task-only agents (they mint per-task, so there's no single repo to broker).
    hivemoot: dict[str, Any] = {
        "token_file": "/run/secrets/hivemoot-agent-token",
        "health": {"enabled": True},
        "github_workflows": {
            "enabled": True,
            "role_name": agent.name,
            "workspace": "/data/workspace",
        },
        "apiarist": _apiarist_block(primary_repo),
    }
    if p.tasks is not None and p.tasks.enabled:
        hivemoot["tasks"] = {
            "enabled": True,
            "claim_url": f"{base}/api/tasks/claim",
            "execute_base_url": f"{base}/api/tasks",
            "workspace": "/data/workspace",
        }
    if p.war_rooms is not None and p.war_rooms.enabled:
        hivemoot["war_rooms"] = {"enabled": True, "contribute": p.war_rooms.contribute}

    plugins: dict[str, Any] = {"hivemoot": hivemoot}

    # github plugin (brokered installation token via apiarist subscriber) — only
    # when the github plugin is enabled. Near-passthrough of plugins.github.
    github_plugin = p.github
    if github_plugin is not None and github_plugin.enabled:
        github: dict[str, Any] = {
            "repos": list(github_plugin.repos),
            "watch_new_prs": github_plugin.watch_new_prs,
            "watch_review_requests": github_plugin.watch_review_requests,
            "watch_mentions": github_plugin.watch_mentions,
        }
        if github_plugin.watch_new_prs_authors:
            github["watch_new_prs_authors"] = list(github_plugin.watch_new_prs_authors)
        github["watch_poll_interval_secs"] = github_plugin.poll_interval_secs
        github["token_source"] = "subscriber"
        github["workspace"] = "/data/workspace"
        plugins["github"] = github

    # cron plugin (periodic scan) — only when the schedule plugin is enabled.
    schedule = p.schedule
    if schedule is not None and schedule.enabled:
        plugins["cron"] = {
            "schedules": [
                {
                    "name": "autonomous",
                    "schedule": f"@every {schedule.interval_secs}s",
                    "jitter_secs": schedule.jitter_secs,
                    "prompt": schedule.prompt,
                }
            ]
        }

    return yaml.safe_dump({"plugins": plugins}, sort_keys=False, default_flow_style=False)


def _apiarist_block(primary_repo: str) -> dict[str, Any]:
    """Always-on token broker. Its `repo` is the primary github repo when github
    is enabled; the key is OMITTED entirely for task-only agents (no repo)."""
    block: dict[str, Any] = {"enabled": True, "socket_path": "/run/apiarist.sock"}
    if primary_repo:
        block["repo"] = primary_repo
    return block


def _render_identity(agent: DesiredAgent) -> str:
    # The image's root_system_prompt.md provides the non-negotiable baseline;
    # identity.md carries this agent's persona + operator system prompt.
    github = agent.plugins.github
    repos = list(github.repos) if (github is not None and github.enabled) else []
    header = f"# Agent: {agent.name}\n"
    if repos:
        header += f"\nRepositories: {', '.join(repos)}\n"
    if agent.skills:
        header += f"Skills: {', '.join(agent.skills)}\n"
    body = agent.system_prompt.strip()
    return f"{header}\n{body}\n" if body else f"{header}\n"


def _render_env(agent: DesiredAgent, *, backend_url: str) -> dict[str, str]:
    eng = agent.engine
    env: dict[str, str] = {
        "AGENT_IDENTITY_FILE": "/run/agent/identity.md",
        "AGENT_ID": agent.name,
        "AGENT_SERVICE": agent.name,
        "AGENT_PROVIDER": eng.tool,
    }
    if eng.model:
        env["AGENT_MODEL"] = eng.model
    if eng.tool_options:
        env["AGENT_TOOL_OPTIONS_JSON"] = json.dumps(eng.tool_options, sort_keys=True)
    # Brokered GitHub token: the agent's github plugin subscribes to GITHUB_TOKEN,
    # which the apiarist UDS round-trip populates at runtime.
    env["APIARIST_TOKEN_ENV"] = "GITHUB_TOKEN"

    if eng.tool == "claude":
        env["CLAUDE_CODE_OAUTH_TOKEN_FILE"] = "/run/secrets/claude-oauth-token"
    provider = eng.provider
    if provider is not None and provider in _PROVIDER_KEY_FILE_ENV:
        var, path = _PROVIDER_KEY_FILE_ENV[provider]
        env[var] = path

    tasks = agent.plugins.tasks
    if tasks is not None and tasks.enabled:
        base = backend_url.rstrip("/")
        env["AGENT_TASK_CLAIM_URL"] = f"{base}/api/tasks/claim"
        env["AGENT_TASK_EXECUTE_BASE_URL"] = f"{base}/api/tasks"
    return env


def _config_hash(
    *,
    hivemoot_yaml: str,
    identity_md: str,
    env: dict[str, str],
    image: str,
) -> str:
    canonical = json.dumps(
        {
            "spec": SPEC_VERSION,
            "image": image,
            "hivemoot_yaml": hivemoot_yaml,
            "identity_md": identity_md,
            "env": env,
        },
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
