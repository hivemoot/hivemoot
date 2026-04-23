"""browser CLI — thin Hermes-style wrapper around agent-browser.

Promoted from apiary's external apiary-browser plugin to a built-in
under the hivemoot-agent runtime.  Each subcommand is an atomic 1:1
shell-out to ``agent-browser`` (vercel-labs, shipped in
hivemoot-agent#593).  The wrapper's entire job is injecting
fleet-specific flags (``--cdp``, ``--session-name``, ``--state``)
and applying per-agent policy — it adds no browser logic of its own.
Heavy lifting (CDP attach, aria-ref snapshots, session persistence,
encrypted state) is in agent-browser.

Reference: Hermes Agent's tools/browser_tool.py uses the same
pattern — atomic Python tool functions, each a thin subprocess call,
safety policy around (not inside) the calls.

Subcommands mirror agent-browser's surface so SKILL.md can point
agents at ``https://agent-browser.dev/commands`` for the authoritative
reference.  We expose a curated subset (navigate / snapshot / click
/ type / fill / press / screenshot / run-js / back) plus two
fleet-specific policy helpers (import-cookies, clear-state).

All agent-browser stdout / stderr is passed through verbatim so the
agent sees exactly what the upstream tool produced (no wrapping,
no restructuring).  The wrapper only exits non-zero with our error
shape when OUR policy fails (missing CDP URL, missing session
context).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


# Default state dir mirrors the BrowserConfig.state_dir default.  The
# plugin's setup() exports BROWSER_STATE_DIR into env so deployers
# overriding the schema field flow through automatically without the
# wrapper having to re-load the YAML config on every invocation.
_DEFAULT_STATE_DIR = os.environ.get("BROWSER_STATE_DIR", "/state")
_AGENT_BROWSER_BIN = "agent-browser"


def _err(payload: dict, exit_code: int = 1) -> None:
    print(json.dumps(payload), file=sys.stderr, flush=True)
    sys.exit(exit_code)


def _state_file_path(args: argparse.Namespace) -> Path | None:
    """Resolve the per-agent persistent state file path.

    We use agent-browser's ``--state <path>`` (explicit state file)
    for cross-restart persistence instead of ``--session-name``
    (which agent-browser stores in a daemon-managed dir inside the
    container's overlay filesystem — ephemeral).  An explicit file
    on the /state bind-mount survives container restarts.
    """
    if args.no_state:
        return None
    if getattr(args, "state_file", ""):
        return Path(args.state_file)
    session = args.session_name or os.environ.get("AGENT_ID", "").strip() or "anonymous"
    return Path(_DEFAULT_STATE_DIR) / f"{session}.json"


def _fleet_flags(args: argparse.Namespace) -> list[str]:
    """Build the --cdp / --session-name / --state prefix.

    This is the entire reason the wrapper exists.  Three bindings:
      * --cdp URL        → fleet's hivemoot-browser sidecar
      * --session-name   → per-agent in-memory session isolation
      * --state PATH     → cross-restart persistence via explicit
                           state file on the /state bind-mount,
                           loaded only when the file exists
    """
    cdp = (args.cdp_url or os.environ.get("BROWSER_CDP_URL", "")).strip()
    if not cdp:
        _err({
            "error": "missing_cdp_url",
            "message": (
                "BROWSER_CDP_URL is not set and --cdp-url was not given.  "
                "Activate the browser plugin in hivemoot.yaml — its "
                "setup() exports BROWSER_CDP_URL from plugins.browser.cdp_url."
            ),
        })

    flags = ["--cdp", cdp]

    if not args.no_state:
        session = args.session_name or os.environ.get("AGENT_ID", "").strip() or "anonymous"
        flags.extend(["--session-name", session])
        # Only pass --state when a bootstrapped file exists; otherwise
        # agent-browser errors on an empty/missing state path.  The
        # file is created by `import-cookies` or by `state save ...`.
        state_path = _state_file_path(args)
        if state_path and state_path.is_file() and state_path.stat().st_size > 0:
            flags.extend(["--state", str(state_path)])

    return flags


def _run(args: argparse.Namespace, subcmd: str, extra: list[str]) -> None:
    """Exec agent-browser and pass its stdout/stderr through verbatim.

    Replaces the current process so the agent sees agent-browser's
    exit code + output directly — no re-wrapping, no re-ordering.
    If the binary is missing, we surface a clear structured error
    pointing at hivemoot-agent#593 before dying.
    """
    if not shutil.which(_AGENT_BROWSER_BIN):
        _err({
            "error": "agent_browser_missing",
            "message": (
                "`agent-browser` binary not on PATH.  Upgrade to a runtime "
                "image that includes hivemoot-agent#593."
            ),
        })

    cmd = [_AGENT_BROWSER_BIN, *_fleet_flags(args), subcmd, *extra]
    os.execvp(cmd[0], cmd)


# ── Atomic subcommands (1:1 with agent-browser) ────────────────────


def _cmd_navigate(args):
    _run(args, "open", [args.url])


def _cmd_snapshot(args):
    extra = []
    if args.include_iframes:
        extra.append("-i")
    _run(args, "snapshot", extra)


def _cmd_click(args):
    extra = [args.target]
    if args.new_tab:
        extra.append("--new-tab")
    _run(args, "click", extra)


def _cmd_type(args):
    _run(args, "type", [args.target, args.text])


def _cmd_fill(args):
    _run(args, "fill", [args.target, args.text])


def _cmd_press(args):
    _run(args, "keyboard", ["press", args.key])


def _cmd_screenshot(args):
    extra = [args.path]
    if args.full_page:
        extra.append("--full")
    _run(args, "screenshot", extra)


def _cmd_run_js(args):
    """Delegates to agent-browser's JS-in-page subcommand."""
    _run(args, "eval", [args.js])


def _cmd_back(args):
    _run(args, "back", [])


# ── Fleet-specific policy helpers ──────────────────────────────────


def _cmd_import_cookies(args):
    """Bootstrap the agent's session from an exported cookies JSON.

    Pure filesystem op — no agent-browser invocation.  Accepts two
    common export shapes (Playwright native, Cookie-Editor array)
    and normalizes to agent-browser's ``--state`` file format
    ``{"cookies": [...], "origins": [...]}``.

    Writes to ``/state/$AGENT_ID.json``.  The next navigate / click
    / fill etc. picks it up automatically via ``--state <path>``
    (injected by _fleet_flags when the file exists).
    """
    state_path = _state_file_path(args)
    if state_path is None:
        _err({"error": "no_state_path", "message": "session resolution disabled (--no-state)"})

    src = Path(args.json_file)
    if not src.is_file():
        _err({"error": "source_not_found", "path": str(src)})

    try:
        payload = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        _err({"error": "invalid_json", "path": str(src), "message": str(exc)})

    if isinstance(payload, dict) and "cookies" in payload:
        cookies = list(payload.get("cookies", []))
        origins = list(payload.get("origins", []))
    elif isinstance(payload, list):
        cookies = list(payload)
        origins = []
    else:
        _err({
            "error": "unrecognized_format",
            "message": (
                "Expected Playwright storage_state or bare cookie array; "
                'got {"cookies": [...]} or [{"name":..., ...}, ...]'
            ),
        })

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"cookies": cookies, "origins": origins}, indent=2, sort_keys=True),
    )
    print(json.dumps({
        "imported_to": str(state_path),
        "cookie_count": len(cookies),
        "origin_count": len(origins),
    }))


def _cmd_clear_state(args):
    state_path = _state_file_path(args)
    if state_path is None:
        _err({"error": "no_state_path", "message": "session resolution disabled (--no-state)"})

    if state_path.is_file():
        state_path.unlink()
        print(json.dumps({"cleared": str(state_path)}))
    else:
        print(json.dumps({"cleared": str(state_path), "note": "already absent"}))


# ── Argparse ───────────────────────────────────────────────────────


def _add_fleet_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cdp-url", default="", help="Override CDP endpoint (default: $BROWSER_CDP_URL)")
    p.add_argument("--session-name", default="", help="Override session name (default: $AGENT_ID)")
    p.add_argument("--no-state", action="store_true", help="Run anonymous; no session persistence")


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="hivemoot-agent.browser",
        description=(
            "Thin Hermes-style wrapper around vercel-labs/agent-browser.  "
            "Injects fleet flags (--cdp, --session-name, --state); "
            "subcommands are 1:1 with agent-browser.  Full reference: "
            "https://agent-browser.dev/commands"
        ),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    nav = sub.add_parser("navigate", help="Open a URL (alias for `open`)")
    nav.add_argument("url")
    _add_fleet_flags(nav)

    snap = sub.add_parser("snapshot", help="Aria-ref tree of the current page")
    snap.add_argument("--include-iframes", "-i", action="store_true")
    _add_fleet_flags(snap)

    clk = sub.add_parser("click", help="Click an aria-ref (@e1) or CSS selector")
    clk.add_argument("target")
    clk.add_argument("--new-tab", action="store_true")
    _add_fleet_flags(clk)

    typ = sub.add_parser("type", help="Type text into element")
    typ.add_argument("target")
    typ.add_argument("text")
    _add_fleet_flags(typ)

    fill = sub.add_parser("fill", help="Clear + type text into element")
    fill.add_argument("target")
    fill.add_argument("text")
    _add_fleet_flags(fill)

    prs = sub.add_parser("press", help="Press a keyboard key (e.g. Enter, Escape)")
    prs.add_argument("key")
    _add_fleet_flags(prs)

    shot = sub.add_parser("screenshot", help="Save a PNG of the page")
    shot.add_argument("path")
    shot.add_argument("--full-page", action="store_true")
    _add_fleet_flags(shot)

    js = sub.add_parser("run-js", help="Run JavaScript in the page context")
    js.add_argument("js")
    _add_fleet_flags(js)

    bk = sub.add_parser("back", help="Go back in browser history")
    _add_fleet_flags(bk)

    imp = sub.add_parser("import-cookies", help="Bootstrap session from exported cookies JSON")
    imp.add_argument("json_file")
    _add_fleet_flags(imp)

    clr = sub.add_parser("clear-state", help="Delete the agent's session state")
    _add_fleet_flags(clr)

    return p


def main() -> int:
    args = _build_parser().parse_args()
    handlers = {
        "navigate": _cmd_navigate,
        "snapshot": _cmd_snapshot,
        "click": _cmd_click,
        "type": _cmd_type,
        "fill": _cmd_fill,
        "press": _cmd_press,
        "screenshot": _cmd_screenshot,
        "run-js": _cmd_run_js,
        "back": _cmd_back,
        "import-cookies": _cmd_import_cookies,
        "clear-state": _cmd_clear_state,
    }
    handlers[args.cmd](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
