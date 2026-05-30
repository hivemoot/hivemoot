"""Tests for the plugin-driven desired-agent → container render.

Golden assertions over the emitted `hivemoot.yaml`: the github plugin (repos +
watches + broker repo = repos[0]), schedule → cron, tasks/war_rooms blocks, a
task-only agent (no github → no github block, no apiarist.repo key, empty label),
and the Stage-2 health refactor: `hivemoot.health` carries NO `repo`.
"""

from __future__ import annotations

from typing import Any

import yaml

from apiarist.features.reconcile.models import (
    DesiredAgent,
    FleetPlugins,
    GithubPlugin,
    ResolvedEngine,
    SchedulePlugin,
    TasksPlugin,
    WarRoomsPlugin,
)
from apiarist.features.reconcile.render import render_agent

IMAGE = "ghcr.io/hivemoot/agent:latest"
BACKEND = "https://www.hivemoot.dev"


def _github(**over: Any) -> GithubPlugin:
    base: dict[str, Any] = dict(
        enabled=True,
        repos=("hivemoot/hivemoot",),
        watch_new_prs=True,
        watch_review_requests=False,
        watch_mentions=False,
        watch_new_prs_authors=(),
        poll_interval_secs=300,
    )
    base.update(over)
    return GithubPlugin(**base)


def _agent(plugins: FleetPlugins, *, name: str = "builder", over: Any = None) -> DesiredAgent:
    base: dict[str, Any] = dict(
        name=name,
        enabled=True,
        managed=True,
        config_version=1,
        engine=ResolvedEngine(
            id="claude", tool="claude", provider=None, model=None, tool_options=None
        ),
        skills=("code-reviewer",),
        system_prompt="Be helpful.",
        plugins=plugins,
        token_name=name,
        agent_role=name,
    )
    if over:
        base.update(over)
    return DesiredAgent(**base)


def _yaml(agent: DesiredAgent) -> dict[str, Any]:
    r = render_agent(agent, backend_url=BACKEND, image=IMAGE)
    doc = yaml.safe_load(r.hivemoot_yaml)
    return doc["plugins"]


# --- github-enabled: repos + watches + broker repo = repos[0] ---------------


def test_github_enabled_repos_watches_and_broker_repo() -> None:
    plugins = _yaml(
        _agent(
            FleetPlugins(
                github=_github(
                    repos=("hivemoot/hivemoot", "hivemoot/colony"),
                    watch_new_prs=True,
                    watch_review_requests=True,
                    watch_mentions=True,
                    poll_interval_secs=120,
                )
            )
        )
    )
    # Plugin order is load-bearing: hivemoot must precede github.
    assert next(iter(plugins)) == "hivemoot"
    gh = plugins["github"]
    assert gh["repos"] == ["hivemoot/hivemoot", "hivemoot/colony"]
    assert gh["watch_new_prs"] is True
    assert gh["watch_review_requests"] is True
    assert gh["watch_mentions"] is True
    assert gh["watch_poll_interval_secs"] == 120
    assert gh["token_source"] == "subscriber"
    assert gh["workspace"] == "/data/workspace"
    # broker repo is the first github repo.
    assert plugins["hivemoot"]["apiarist"]["repo"] == "hivemoot/hivemoot"


def test_github_authors_only_emitted_when_present() -> None:
    plugins = _yaml(_agent(FleetPlugins(github=_github())))
    assert "watch_new_prs_authors" not in plugins["github"]
    plugins2 = _yaml(_agent(FleetPlugins(github=_github(watch_new_prs_authors=("octocat",)))))
    assert plugins2["github"]["watch_new_prs_authors"] == ["octocat"]


def test_github_disabled_emits_no_github_block_and_no_broker_repo() -> None:
    # github present-but-disabled ⇒ no github block, broker repo key omitted.
    plugins = _yaml(
        _agent(
            FleetPlugins(
                github=GithubPlugin(
                    enabled=False,
                    repos=("hivemoot/hivemoot",),
                    watch_new_prs=False,
                    watch_review_requests=False,
                    watch_mentions=False,
                    watch_new_prs_authors=(),
                    poll_interval_secs=300,
                ),
                tasks=TasksPlugin(enabled=True),
            )
        )
    )
    assert "github" not in plugins
    assert "repo" not in plugins["hivemoot"]["apiarist"]


# --- health: NO repo (Stage-2 health refactor) ------------------------------


def test_health_block_has_no_repo() -> None:
    plugins = _yaml(_agent(FleetPlugins(github=_github())))
    assert plugins["hivemoot"]["health"] == {"enabled": True}
    assert "repo" not in plugins["hivemoot"]["health"]


# --- schedule → cron --------------------------------------------------------


def test_schedule_enabled_maps_to_cron() -> None:
    plugins = _yaml(
        _agent(
            FleetPlugins(
                schedule=SchedulePlugin(
                    enabled=True, interval_secs=3600, jitter_secs=60, prompt="go"
                )
            )
        )
    )
    cron = plugins["cron"]["schedules"][0]
    assert cron["schedule"] == "@every 3600s"
    assert cron["jitter_secs"] == 60
    assert cron["prompt"] == "go"


def test_schedule_disabled_emits_no_cron() -> None:
    disabled = SchedulePlugin(enabled=False, interval_secs=3600, jitter_secs=0, prompt="")
    plugins = _yaml(
        _agent(FleetPlugins(schedule=disabled, tasks=TasksPlugin(enabled=True)))
    )
    assert "cron" not in plugins


# --- tasks / war_rooms ------------------------------------------------------


def test_tasks_enabled_emits_hivemoot_tasks_and_env() -> None:
    agent = _agent(FleetPlugins(tasks=TasksPlugin(enabled=True)))
    r = render_agent(agent, backend_url=BACKEND, image=IMAGE)
    plugins = yaml.safe_load(r.hivemoot_yaml)["plugins"]
    assert plugins["hivemoot"]["tasks"]["claim_url"].endswith("/api/tasks/claim")
    assert r.env["AGENT_TASK_CLAIM_URL"].endswith("/api/tasks/claim")


def test_tasks_block_absent_when_disabled() -> None:
    plugins = _yaml(_agent(FleetPlugins(github=_github())))
    assert "tasks" not in plugins["hivemoot"]


def test_war_rooms_enabled_with_contribute() -> None:
    plugins = _yaml(_agent(FleetPlugins(war_rooms=WarRoomsPlugin(enabled=True, contribute=True))))
    assert plugins["hivemoot"]["war_rooms"] == {"enabled": True, "contribute": True}


def test_war_rooms_absent_when_disabled() -> None:
    plugins = _yaml(
        _agent(
            FleetPlugins(
                war_rooms=WarRoomsPlugin(enabled=False, contribute=True),
                tasks=TasksPlugin(enabled=True),
            )
        )
    )
    assert "war_rooms" not in plugins["hivemoot"]


# --- task-only agent: no repo anywhere, empty label -------------------------


def test_task_only_agent_has_no_github_no_broker_repo_empty_label() -> None:
    agent = _agent(FleetPlugins(tasks=TasksPlugin(enabled=True)))
    r = render_agent(agent, backend_url=BACKEND, image=IMAGE)
    plugins = yaml.safe_load(r.hivemoot_yaml)["plugins"]
    assert "github" not in plugins
    # broker repo key omitted entirely for a task-only agent.
    assert "repo" not in plugins["hivemoot"]["apiarist"]
    assert "repo" not in plugins["hivemoot"]["health"]
    # the dev.hivemoot.repo Docker label is empty (label-only; safe).
    assert r.repo == ""
    # task-only agent has no Repositories line in its identity.
    assert "Repositories:" not in r.identity_md


# --- container label / hash -------------------------------------------------


def test_container_repo_label_is_primary_github_repo() -> None:
    r = render_agent(
        _agent(FleetPlugins(github=_github(repos=("a/b", "c/d")))),
        backend_url=BACKEND,
        image=IMAGE,
    )
    assert r.repo == "a/b"  # container label uses the primary (first) repo
    plugins = yaml.safe_load(r.hivemoot_yaml)["plugins"]
    assert plugins["github"]["repos"] == ["a/b", "c/d"]
    assert plugins["hivemoot"]["apiarist"]["repo"] == "a/b"
    assert "Repositories: a/b, c/d" in r.identity_md


def test_config_hash_is_deterministic_and_sensitive() -> None:
    r1 = render_agent(_agent(FleetPlugins(github=_github())), backend_url=BACKEND, image=IMAGE)
    r2 = render_agent(_agent(FleetPlugins(github=_github())), backend_url=BACKEND, image=IMAGE)
    assert r1.config_hash == r2.config_hash
    r3 = render_agent(
        _agent(FleetPlugins(github=_github()), over={"system_prompt": "different"}),
        backend_url=BACKEND,
        image=IMAGE,
    )
    assert r3.config_hash != r1.config_hash


def test_config_hash_is_kwarg_order_independent() -> None:
    # The hash canonicalizes with sort_keys=True, so two plugin sets built with
    # different kwarg order (here: GithubPlugin fields and the FleetPlugins
    # members) must render to the SAME config_hash. Locks in that load-bearing
    # canonicalization — without it a reorder would spuriously roll a container.
    gh_a = GithubPlugin(
        enabled=True,
        repos=("hivemoot/hivemoot",),
        watch_new_prs=True,
        watch_review_requests=True,
        watch_mentions=False,
        watch_new_prs_authors=(),
        poll_interval_secs=120,
    )
    gh_b = GithubPlugin(
        poll_interval_secs=120,
        watch_mentions=False,
        watch_review_requests=True,
        watch_new_prs=True,
        repos=("hivemoot/hivemoot",),
        watch_new_prs_authors=(),
        enabled=True,
    )
    sched = SchedulePlugin(enabled=True, interval_secs=3600, jitter_secs=60, prompt="go")
    a = _agent(FleetPlugins(github=gh_a, schedule=sched, tasks=TasksPlugin(enabled=True)))
    b = _agent(FleetPlugins(tasks=TasksPlugin(enabled=True), schedule=sched, github=gh_b))
    ra = render_agent(a, backend_url=BACKEND, image=IMAGE)
    rb = render_agent(b, backend_url=BACKEND, image=IMAGE)
    assert ra.config_hash == rb.config_hash


def test_config_hash_is_sensitive_to_rendered_plugin_fields() -> None:
    # Changing a field that the render actually emits must change the hash.
    base = render_agent(_agent(FleetPlugins(github=_github())), backend_url=BACKEND, image=IMAGE)
    poll = render_agent(
        _agent(FleetPlugins(github=_github(poll_interval_secs=120))),
        backend_url=BACKEND,
        image=IMAGE,
    )
    assert poll.config_hash != base.config_hash

    sched_x = SchedulePlugin(enabled=True, interval_secs=3600, jitter_secs=0, prompt="x")
    sched_y = SchedulePlugin(enabled=True, interval_secs=3600, jitter_secs=0, prompt="y")
    prompt = render_agent(
        _agent(FleetPlugins(github=_github(), schedule=sched_x)),
        backend_url=BACKEND,
        image=IMAGE,
    )
    prompt2 = render_agent(
        _agent(FleetPlugins(github=_github(), schedule=sched_y)),
        backend_url=BACKEND,
        image=IMAGE,
    )
    assert prompt.config_hash != prompt2.config_hash


def test_env_engine_mapping_zai() -> None:
    agent = _agent(
        FleetPlugins(github=_github()),
        over={
            "engine": ResolvedEngine(
                id="zai", tool="opencode", provider="zai", model="zai/glm-5.1", tool_options=None
            )
        },
    )
    env = render_agent(agent, backend_url=BACKEND, image=IMAGE).env
    assert env["AGENT_PROVIDER"] == "opencode"
    assert env["AGENT_MODEL"] == "zai/glm-5.1"
    assert env["ZAI_API_KEY_FILE"] == "/run/secrets/zai-api-key"
