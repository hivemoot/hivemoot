# apiarist

> **Status:** Phase A — project skeleton only. The daemon does not yet
> do anything useful. See [DESIGN.md](./DESIGN.md) for the full V1
> architecture and phase plan.

`apiarist` is the host-side daemon for the Hivemoot fleet. It runs on
each Hive (the host that runs the apiary fleet of agent containers) and
mediates between local agents and the centralized hivemoot.dev backend.

## What it does (eventual V1)

- **Brokers GitHub installation tokens.** Talks to the hivemoot.dev
  backend (which holds the Hivemoot Bot App private key) to mint
  short-lived (≤ 1 hour) GitHub installation tokens, and exposes them
  to local agent containers via a Unix-domain socket. Replaces the
  long-lived classic PATs in `apiary.secrets.yaml`.
- **(V2+) Spawns and reconciles agent containers** based on
  configuration pulled from the backend. Future feature, designed for
  but not built in V1.

## Architecture

See [DESIGN.md](./DESIGN.md) for:

- §1 Why this exists (federated multi-Hive runtime)
- §3 Architectural analog (HashiCorp Vault Agent / Kubelet)
- §6 Architecture overview (diagram)
- §7 Component layout (module structure)
- §8 IPC protocol (UDS, length-prefixed JSON)
- §10 Security model (threats and mitigations)
- §11 Backend dependencies (the new `/api/installation-token` endpoint)
- §12 Integration with existing apiary (cross-repo touch points)
- §14 Implementation phases (this skeleton is Phase A)

## Try it (Phase A)

```bash
# From the apiarist/ directory
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
apiarist --version    # → "apiarist 0.1.0"
apiarist --help       # → usage with description
```

## Layout

```
apiarist/
├── DESIGN.md          ← architectural source of truth
├── README.md          ← this file
├── pyproject.toml     ← package metadata, deps, entry point
├── src/apiarist/      ← package code (grows phase by phase)
└── tests/             ← unit + integration tests (filled out in Phases G-H)
```

## License

MIT — same as the rest of the hivemoot monorepo.
