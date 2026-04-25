# apiarist systemd unit

`apiarist.service` runs the apiarist daemon under systemd with the
hardening profile from DESIGN.md §10.

## What it expects on the host (Phase J — install script)

The unit file references several pre-existing pieces. The Phase J
install script (`deploy/install.sh`) creates them; this README
documents the contract so the install script and the unit stay
honest with each other.

| Path | Owner | Mode | Created by |
|---|---|---|---|
| `/usr/local/bin/apiarist` | `root:root` | 0755 | install.sh (pip-installed entry point) |
| `/etc/apiarist/apiarist.yaml` | `root:apiarist` | 0640 | install.sh (or operator) |
| `/etc/apiarist/agent-token.env` | `root:apiarist` | 0640 | install.sh, populated from `apiary.secrets.yaml` |
| User `apiarist` | — | — | install.sh (`useradd -r -s /sbin/nologin`) |
| Group membership: `apiarist ∈ agent` | — | — | install.sh (`usermod -aG agent apiarist`) |
| `/var/lib/apiarist/` | `apiarist:apiarist` | 0750 | systemd via `StateDirectory=apiarist` |
| `/run/apiarist/` | `apiarist:apiarist` | 0755 | systemd via `RuntimeDirectory=apiarist` |
| `/run/apiarist/apiarist.sock` | `apiarist:agent` | 0660 | daemon at startup (chgrp + chmod after bind) |

The `apiarist ∈ agent` group membership is required so the daemon
can `chgrp` the socket file to `agent` for cross-container access.
Without it, the chgrp call inside `Server.bind()` returns EPERM.

## Why the socket is inside a directory, not directly in /run/

A previous draft used `/run/apiarist.sock` directly. That doesn't work
with the hardening profile: `ProtectSystem=strict` plus
`ReadWritePaths=` (empty here) means the daemon cannot write into
`/run/` itself. systemd's idiomatic answer is `RuntimeDirectory=`,
which creates `/run/<dir>/` owned by the unit's `User:Group` and
makes that directory the daemon's writable runtime location.

Containers in the `agent` group reach the socket via directory
traversal: `/run/apiarist` is mode 0755 (any user can `+x` traverse),
the socket file inside is mode 0660 with group `agent` (only group
members can read/write).

## Installing manually (development only)

For dev-on-Hive iteration before the install script lands:

```bash
sudo cp apiarist.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now apiarist.service
sudo systemctl status apiarist.service
sudo journalctl -u apiarist -f
```

Production should always go through `deploy/install.sh` (Phase J)
which handles the user creation, group membership, env-file population,
and config staging atomically.
