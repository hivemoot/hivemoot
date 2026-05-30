"""Tests for the desired-agent → container render."""

from __future__ import annotations

from typing import Any

import yaml

from apiarist.features.reconcile.models import DesiredAgent, ResolvedEngine, Triggers
from apiarist.features.reconcile.render import render_agent

IMAGE = "ghcr.io/hivemoot/agent:latest"
BACKEND = "https://www.hivemoot.dev"


def make_triggers(**over: Any) -> Triggers:
    base: dict[str, Any] = dict(
        schedule_enabled=False,
        schedule_interval_secs=21600,
        schedule_jitter_secs=600,
        schedule_prompt="",
        pr_enabled=False,
        pr_watch_new=True,
        pr_watch_reviews=True,
        pr_authors=(),
        pr_poll_secs=300,
        mentions_enabled=False,
        mentions_poll_secs=90,
        tasks_enabled=False,
        war_rooms_enabled=False,
        war_rooms_contribute=False,
    )
    base.update(over)
    return Triggers(**base)


def make_agent(**over: Any) -> DesiredAgent:
    base: dict[str, Any] = dict(
        name="builder",
        repos=("hivemoot/hivemoot",),
        enabled=True,
        managed=True,
        config_version=1,
        engine=ResolvedEngine(
            id="claude", tool="claude", provider=None, model=None, tool_options=None
        ),
        skills=("code-reviewer",),
        system_prompt="Be helpful.",
        triggers=make_triggers(),
        token_name="builder",
        agent_role="builder",
    )
    base.update(over)
    return DesiredAgent(**base)


def test_render_basic_structure_and_plugin_order() -> None:
    r = render_agent(make_agent(), backend_url=BACKEND, image=IMAGE)
    assert r.container_name == "hivemoot-mgd-builder"
    doc = yaml.safe_load(r.hivemoot_yaml)
    plugins = doc["plugins"]
    # Plugin order is load-bearing: hivemoot must precede github.
    assert next(iter(plugins)) == "hivemoot"
    assert plugins["github"]["repos"] == ["hivemoot/hivemoot"]
    assert plugins["github"]["token_source"] == "subscriber"
    assert "cron" not in plugins  # schedule disabled


def test_schedule_maps_to_cron() -> None:
    a = make_agent(
        triggers=make_triggers(
            schedule_enabled=True, schedule_interval_secs=3600, schedule_prompt="go"
        )
    )
    r = render_agent(a, backend_url=BACKEND, image=IMAGE)
    cron = yaml.safe_load(r.hivemoot_yaml)["plugins"]["cron"]["schedules"][0]
    assert cron["schedule"] == "@every 3600s"
    assert cron["prompt"] == "go"


def test_tasks_maps_to_hivemoot_tasks_and_env() -> None:
    a = make_agent(triggers=make_triggers(tasks_enabled=True))
    r = render_agent(a, backend_url=BACKEND, image=IMAGE)
    doc = yaml.safe_load(r.hivemoot_yaml)
    assert doc["plugins"]["hivemoot"]["tasks"]["claim_url"].endswith("/api/tasks/claim")
    assert r.env["AGENT_TASK_CLAIM_URL"].endswith("/api/tasks/claim")


def test_pr_and_mentions_flags() -> None:
    a = make_agent(
        triggers=make_triggers(
            pr_enabled=True, pr_watch_new=True, pr_watch_reviews=False, mentions_enabled=True
        )
    )
    gh = yaml.safe_load(render_agent(a, backend_url=BACKEND, image=IMAGE).hivemoot_yaml)["plugins"][
        "github"
    ]
    assert gh["watch_new_prs"] is True
    assert gh["watch_review_requests"] is False
    assert gh["watch_mentions"] is True


def test_env_engine_mapping_zai() -> None:
    a = make_agent(
        engine=ResolvedEngine(
            id="zai", tool="opencode", provider="zai", model="zai/glm-5.1", tool_options=None
        )
    )
    env = render_agent(a, backend_url=BACKEND, image=IMAGE).env
    assert env["AGENT_PROVIDER"] == "opencode"
    assert env["AGENT_MODEL"] == "zai/glm-5.1"
    assert env["ZAI_API_KEY_FILE"] == "/run/secrets/zai-api-key"


def test_config_hash_is_deterministic_and_sensitive() -> None:
    r1 = render_agent(make_agent(), backend_url=BACKEND, image=IMAGE)
    r2 = render_agent(make_agent(), backend_url=BACKEND, image=IMAGE)
    assert r1.config_hash == r2.config_hash
    r3 = render_agent(
        make_agent(system_prompt="different prompt"), backend_url=BACKEND, image=IMAGE
    )
    assert r3.config_hash != r1.config_hash


def test_render_multi_repo_fan_out() -> None:
    # github watches ALL the token's repos; single-repo fields use the primary.
    r = render_agent(make_agent(repos=("a/b", "c/d")), backend_url=BACKEND, image=IMAGE)
    doc = yaml.safe_load(r.hivemoot_yaml)
    assert doc["plugins"]["github"]["repos"] == ["a/b", "c/d"]
    assert doc["plugins"]["hivemoot"]["health"]["repo"] == "a/b"
    assert doc["plugins"]["hivemoot"]["apiarist"]["repo"] == "a/b"
    assert "Repositories: a/b, c/d" in r.identity_md
    assert r.repo == "a/b"  # container label uses the primary repo
