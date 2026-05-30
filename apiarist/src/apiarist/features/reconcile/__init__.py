"""Dynamic agent reconciliation (apiarist V2).

Polls the backend's `GET /api/fleet/desired-state` for the installation's
desired agent roster and reconciles local Docker containers to match
(spawn / stop / replace). DESIGN.md §4/§7 reserve this slot.

SAFETY: ships disabled (`reconcile_enabled=False`) and dry-run by default
(`reconcile_dry_run=True`). Fail-closed on any backend error (keep
last-known-good; never mass-delete on a hiccup). The backend describes WHAT
to run; apiarist decides HOW (fixed container template, image allowlist,
no privileged flags).
"""
