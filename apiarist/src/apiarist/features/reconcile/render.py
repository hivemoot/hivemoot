"""Render a desired-state agent into concrete container inputs.

A Python port of the relevant `deploy-apiary.sh` rendering (write_standing_*),
driven by the desired-state entry instead of static YAML. Produces the
`hivemoot.yaml`, `identity.md`, and `env` the agent container reads, plus a
content-addressed `config_hash` used to detect "changed" without inspecting a
running container's internals.

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
        repo=agent.repo,
        engine_id=agent.engine.id,
        image=image,
        hivemoot_yaml=hivemoot_yaml,
        identity_md=identity_md,
        env=env,
        config_hash=config_hash,
    )


def _render_hivemoot_yaml(agent: DesiredAgent, *, backend_url: str) -> str:
    t = agent.triggers
    base = backend_url.rstrip("/")

    # hivemoot plugin (emitted FIRST — load-bearing order for the broker path).
    hivemoot: dict[str, Any] = {
        "token_file": "/run/secrets/hivemoot-agent-token",
        "health": {"enabled": True, "repo": agent.repo},
        "github_workflows": {
            "enabled": True,
            "role_name": agent.name,
            "workspace": "/data/workspace",
        },
        "apiarist": {
            "enabled": True,
            "socket_path": "/run/apiarist.sock",
            "repo": agent.repo,
        },
    }
    if t.tasks_enabled:
        hivemoot["tasks"] = {
            "enabled": True,
            "claim_url": f"{base}/api/tasks/claim",
            "execute_base_url": f"{base}/api/tasks",
            "workspace": "/data/workspace",
        }
    if t.war_rooms_enabled:
        hivemoot["war_rooms"] = {"enabled": True}

    # github plugin (brokered installation token via apiarist subscriber).
    github: dict[str, Any] = {
        "repos": [agent.repo],
        "token_source": "subscriber",
        "workspace": "/data/workspace",
        "watch_mentions": t.mentions_enabled,
        "watch_new_prs": t.pr_enabled and t.pr_watch_new,
        "watch_review_requests": t.pr_enabled and t.pr_watch_reviews,
    }
    if t.pr_enabled and t.pr_authors:
        github["watch_new_prs_authors"] = list(t.pr_authors)
    github["watch_poll_interval_secs"] = t.pr_poll_secs if t.pr_enabled else t.mentions_poll_secs

    plugins: dict[str, Any] = {"hivemoot": hivemoot, "github": github}

    # cron plugin (periodic scan) — only when the schedule trigger is enabled.
    if t.schedule_enabled:
        plugins["cron"] = {
            "schedules": [
                {
                    "name": "autonomous",
                    "schedule": f"@every {t.schedule_interval_secs}s",
                    "jitter_secs": t.schedule_jitter_secs,
                    "prompt": t.schedule_prompt,
                }
            ]
        }

    return yaml.safe_dump({"plugins": plugins}, sort_keys=False, default_flow_style=False)


def _render_identity(agent: DesiredAgent) -> str:
    # The image's root_system_prompt.md provides the non-negotiable baseline;
    # identity.md carries this agent's persona + operator system prompt.
    header = f"# Agent: {agent.name}\n\nRepository: {agent.repo}\n"
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

    if agent.triggers.tasks_enabled:
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
