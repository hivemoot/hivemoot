"""Core infrastructure shared by feature plugins.

Modules:
    - backend: httpx async client for hivemoot.dev (this PR adds it).
    - auth (future): bearer-token loading from apiary.secrets.yaml.
    - ipc (future): Unix-domain-socket request framing and dispatch.
    - registry (future): feature plugin registry.
"""
