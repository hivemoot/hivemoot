"""mint_token op handler — wires the IPC layer to the backend client.

The handler:
  1. Validates the request `params` (service + repo required).
  2. Asks the cache for a token, with a fetcher that calls the backend.
  3. Returns the wire-shape response (token + expires_at + permissions
     + repositories per DESIGN.md §8).

Backend errors propagate as `BackendError` subclasses; the server
dispatcher in `server.py` translates them to wire error codes via
`_classify_handler_error`.
"""

from __future__ import annotations

from typing import Any

from apiarist.core.backend import BackendClient
from apiarist.core.registry import Registry
from apiarist.features.tokens.cache import TokenCache

# V1 hard-coded narrowed permission set per DESIGN.md §11. Future
# variants of the API may accept a per-request permissions override
# (constrained by the agent token's policy) — for now every mint asks
# for the same scope.
_V1_PERMISSIONS: dict[str, str] = {
    "contents": "read",
    "pull_requests": "write",
    "issues": "write",
    "metadata": "read",
}


def register(
    registry: Registry,
    *,
    backend: BackendClient,
    cache: TokenCache,
) -> None:
    """Register the `mint_token` op handler on `registry`.

    Called from daemon startup. The handler closure captures `backend`
    and `cache` — both must outlive the registry.
    """

    async def mint_token(params: dict[str, Any]) -> dict[str, Any]:
        service = params.get("service")
        repo = params.get("repo")
        if not isinstance(service, str) or not service:
            raise ValueError("'service' is required and must be a non-empty string")
        if not isinstance(repo, str) or not repo:
            raise ValueError("'repo' is required and must be a non-empty string")

        # Optional pass-through agent_id (audit-only per DESIGN.md §11
        # "agent_id field"). Type-check only; backend ignores for auth.
        agent_id_raw = params.get("agent_id")
        if agent_id_raw is not None and not isinstance(agent_id_raw, str):
            raise ValueError("'agent_id' must be a string when present")

        # The cache's installation_id key is what the backend ultimately
        # echoes. Until the backend stub returns real data we use
        # `service` as a stand-in cache namespace — this means each
        # service has its own cache slot regardless of underlying
        # installation. When real minting lands and the response carries
        # `installation_id`, switch the cache namespace to that.
        # TODO(Phase N foxstoria pilot): re-key by installation_id once
        # the backend returns real data.
        installation_namespace = service

        async def fetch() -> Any:
            return await backend.mint_installation_token(repo, agent_id=agent_id_raw)

        token = await cache.get_or_fetch(
            installation_id=installation_namespace,
            repo=repo,
            permissions=_V1_PERMISSIONS,
            fetch=fetch,
        )

        return {
            "token": token.token,
            "expires_at": token.expires_at.isoformat().replace("+00:00", "Z"),
            "installation_id": token.installation_id,
            "permissions": token.permissions,
            "repositories": [
                {"full_name": r.full_name, "id": r.id} for r in token.repositories
            ],
        }

    registry.register("mint_token", mint_token)
