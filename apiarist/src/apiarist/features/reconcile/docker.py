"""Docker Engine API client over the host UDS (httpx — already a dep).

`DockerClient` is a Protocol so tests inject a fake; `HttpxDockerClient` is the
real implementation. We deliberately drive the Docker API directly (not the sync
`docker` SDK) to stay async and dependency-light, and we own a disjoint set of
labeled containers so we never touch statically-deployed (systemd) ones.

The container spec is a FIXED template: desired-state supplies data (name, env,
labels), never flags. No `--privileged`, no host network, no arbitrary binds —
only the fixed per-agent config/secret mounts.

NOTE: exercised only in enforce mode (off by default). Verify the exact Engine
API payloads against the target Docker version when first enabling on a hive.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol

import httpx

from apiarist.features.reconcile.models import (
    LABEL_AGENT,
    LABEL_CONFIG_HASH,
    LABEL_ENGINE,
    LABEL_MANAGED_BY,
    LABEL_MANAGED_VALUE,
    LABEL_REPO,
    ManagedContainer,
    RenderedContainer,
    container_name_for,
)


class DockerClient(Protocol):
    async def list_managed(self) -> list[ManagedContainer]: ...
    async def pull_if_absent(self, image: str) -> None: ...
    async def create_and_start(self, rendered: RenderedContainer) -> None: ...
    async def stop_and_remove(self, agent_name: str) -> None: ...


class DockerError(Exception):
    """A Docker Engine API call failed."""


class HttpxDockerClient:
    def __init__(
        self,
        *,
        socket_path: Path,
        fleet_data_root: Path,
        stop_grace_seconds: int = 30,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._fleet_data_root = fleet_data_root
        self._stop_grace = stop_grace_seconds
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            transport = httpx.AsyncHTTPTransport(uds=str(socket_path))
            self._client = httpx.AsyncClient(transport=transport, base_url="http://docker")
            self._owns_client = True

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def list_managed(self) -> list[ManagedContainer]:
        filters = f'{{"label":["{LABEL_MANAGED_BY}={LABEL_MANAGED_VALUE}"]}}'
        resp = await self._client.get("/containers/json", params={"all": "1", "filters": filters})
        if resp.status_code != 200:
            raise DockerError(f"list containers failed: HTTP {resp.status_code}")
        out: list[ManagedContainer] = []
        for entry in _as_list(resp.json()):
            if not isinstance(entry, dict):
                continue
            labels = entry.get("Labels")
            labels = labels if isinstance(labels, dict) else {}
            agent = labels.get(LABEL_AGENT)
            if not isinstance(agent, str):
                continue
            names = entry.get("Names")
            name = ""
            if isinstance(names, list) and names and isinstance(names[0], str):
                name = names[0].lstrip("/")
            out.append(
                ManagedContainer(
                    container_name=name or container_name_for(agent),
                    container_id=str(entry.get("Id", "")),
                    agent_name=agent,
                    config_hash=str(labels.get(LABEL_CONFIG_HASH, "")),
                    state=str(entry.get("State", "")),
                )
            )
        return out

    async def pull_if_absent(self, image: str) -> None:
        inspect = await self._client.get(f"/images/{image}/json")
        if inspect.status_code == 200:
            return
        from_image, _, tag = image.partition(":")
        params = {"fromImage": from_image, "tag": tag or "latest"}
        resp = await self._client.post("/images/create", params=params)
        if resp.status_code not in (200, 204):
            raise DockerError(f"image pull failed for {image!r}: HTTP {resp.status_code}")

    async def create_and_start(self, rendered: RenderedContainer) -> None:
        agent_dir = self._fleet_data_root / rendered.agent_name
        (agent_dir / "secrets").mkdir(parents=True, exist_ok=True)
        (agent_dir / "hivemoot.yaml").write_text(rendered.hivemoot_yaml, encoding="utf-8")
        (agent_dir / "identity.md").write_text(rendered.identity_md, encoding="utf-8")

        binds = [
            f"{agent_dir}:/data",
            f"{agent_dir / 'secrets'}:/run/secrets:ro",
            f"{agent_dir / 'identity.md'}:/run/agent/identity.md:ro",
            f"{agent_dir / 'hivemoot.yaml'}:/run/agent/hivemoot.yaml:ro",
            "/run/apiarist/apiarist.sock:/run/apiarist.sock",
        ]
        body: dict[str, Any] = {
            "Image": rendered.image,
            "Cmd": ["run"],
            "Env": [f"{k}={v}" for k, v in rendered.env.items()],
            "Labels": {
                LABEL_MANAGED_BY: LABEL_MANAGED_VALUE,
                LABEL_AGENT: rendered.agent_name,
                LABEL_CONFIG_HASH: rendered.config_hash,
                LABEL_REPO: rendered.repo,
                LABEL_ENGINE: rendered.engine_id,
            },
            "HostConfig": {
                "Binds": binds,
                "RestartPolicy": {"Name": "unless-stopped"},
                # Fixed, locked-down: no privileged, no host net, no cap-add.
                "Privileged": False,
                "NetworkMode": "bridge",
            },
        }
        create = await self._client.post(
            "/containers/create", params={"name": rendered.container_name}, json=body
        )
        if create.status_code not in (200, 201):
            raise DockerError(
                f"create {rendered.container_name!r} failed: "
                f"HTTP {create.status_code} {create.text}"
            )
        container_id = str(_as_dict(create.json()).get("Id", rendered.container_name))
        start = await self._client.post(f"/containers/{container_id}/start")
        if start.status_code not in (204, 304):
            raise DockerError(f"start {rendered.container_name!r} failed: HTTP {start.status_code}")

    async def stop_and_remove(self, agent_name: str) -> None:
        name = container_name_for(agent_name)
        stop = await self._client.post(
            f"/containers/{name}/stop", params={"t": str(self._stop_grace)}
        )
        if stop.status_code not in (204, 304, 404):
            raise DockerError(f"stop {name!r} failed: HTTP {stop.status_code}")
        remove = await self._client.delete(f"/containers/{name}", params={"force": "true"})
        if remove.status_code not in (204, 404):
            raise DockerError(f"remove {name!r} failed: HTTP {remove.status_code}")


def _as_list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}
