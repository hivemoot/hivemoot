"""mint_token op handler — wires the IPC layer to the backend client.

The handler:
  1. Validates the request `params` (service + repo required).
  2. Asks the cache for a token, with a fetcher that calls the backend
     and records timing/status into the shared HealthState.
  3. Returns the wire-shape response (token + expires_at + permissions
     + repositories per DESIGN.md §8).

Backend errors propagate as `BackendError` subclasses; the server
dispatcher in `server.py` translates them to wire error codes via
`_classify_handler_error`. Either way the call is recorded against
HealthState (success or "<ErrorClassName>") so the health op surfaces
last-call telemetry.
"""

from __future__ import annotations

import time
from hashlib import sha256
from typing import Any

from apiarist.core.backend import BackendClient
from apiarist.core.registry import Registry
from apiarist.features.health import HealthState
from apiarist.features.tokens.cache import TokenCache

# Hard-coded request-side ceiling per DESIGN.md §11. Apiarist always
# asks the backend for THIS scope; the backend (V1.6+) may further
# narrow per the agent token's `policy.allowed_permissions` before
# calling GitHub. The response's `permissions` field reflects what was
# actually granted (= intersect of this, token policy, installation
# grant).
#
# Must stay in sync with web's `V1_PERMISSIONS` in
# `web/src/server/github-installation-token.ts` — both define the same
# upper bound, used as the cache-key hash on this side and as the
# request body on the server side. Diverging keys/values would
# silently invalidate every cached entry on the client OR cause the
# server to receive a request asking for scope it doesn't accept.
#
# V1.6 cache-invalidation note: this dict drives the cache key on
# apiarist's side; the SERVER applies token-policy narrowing on top.
# If an operator updates a token's `policy.allowed_permissions`,
# cached tokens minted under the previous policy keep serving until
# their natural cache TTL expires (default 5 min). For immediate
# rollout, restart the apiarist daemon — the in-memory cache resets.
_V1_PERMISSIONS: dict[str, str] = {
    "contents": "read",
    "pull_requests": "write",
    "issues": "write",
    "metadata": "read",
}


def _token_fingerprint(agent_token: str) -> str:
    """Stable, non-reversible namespace key derived from the agent token.

    V1 has a single agent token in env; all services share it. Keying
    the cache + single-flight lock by this fingerprint means concurrent
    mint requests from DIFFERENT services backed by the SAME credential
    correctly serialize on one upstream call (instead of racing as we
    would if keyed by `service`). The multi-token schema (DESIGN.md §9
    multi-installation support) will mint one fingerprint per token
    slot — same logic, same correctness, no code change needed there.

    SHA-256 truncated to 16 hex chars: enough entropy for a key, no
    leakage of the underlying token (one-way + truncated).
    """
    return sha256(agent_token.encode("utf-8")).hexdigest()[:16]


def register(
    registry: Registry,
    *,
    backend: BackendClient,
    cache: TokenCache,
    health_state: HealthState,
    agent_token: str,
) -> None:
    """Register the `mint_token` op handler on `registry`.

    Called from daemon startup. The handler closure captures `backend`,
    `cache`, `health_state`, and the agent_token fingerprint — all
    must outlive the registry.

    `health_state` receives a record on every backend call (success or
    typed error), so the health op surfaces last-call telemetry.
    """

    namespace = _token_fingerprint(agent_token)

    async def mint_token(params: dict[str, Any]) -> dict[str, Any]:
        repo = params.get("repo")
        service = params.get("service")
        if not isinstance(service, str) or not service:
            raise ValueError("'service' is required and must be a non-empty string")
        if not isinstance(repo, str) or not repo:
            raise ValueError("'repo' is required and must be a non-empty string")

        # Optional pass-through agent_id (audit-only per DESIGN.md §11
        # "agent_id field"). Type-check only; backend ignores for auth.
        agent_id_raw = params.get("agent_id")
        if agent_id_raw is not None and not isinstance(agent_id_raw, str):
            raise ValueError("'agent_id' must be a string when present")

        async def fetch() -> Any:
            # Record health on every actual backend call — both success
            # and typed errors land in HealthState so the health op
            # surfaces real last-call telemetry. We use perf_counter
            # for the duration measurement (monotonic, sub-ms precision).
            start = time.perf_counter()
            try:
                result = await backend.mint_installation_token(
                    repo, agent_id=agent_id_raw
                )
            except Exception as exc:
                roundtrip_ms = (time.perf_counter() - start) * 1000
                # Status string is the BackendError class name (or other
                # exception type) — gives operators an immediate hint
                # what failed without leaking the message.
                health_state.record(
                    status=type(exc).__name__, roundtrip_ms=roundtrip_ms
                )
                raise
            roundtrip_ms = (time.perf_counter() - start) * 1000
            health_state.record(status="ok", roundtrip_ms=roundtrip_ms)
            return result

        token = await cache.get_or_fetch(
            installation_id=namespace,
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
