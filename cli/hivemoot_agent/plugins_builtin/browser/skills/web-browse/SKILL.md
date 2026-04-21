---
name: web-browse
description: |
  Drive the shared hivemoot-browser sidecar via agent-browser
  (vercel-labs).  Use for JS-rendered pages, authenticated sessions
  via bootstrapped cookies, OAuth flows — anything curl / API calls
  can't handle.
---

# Web browse

You have a shared headless Chromium sidecar attached over the Chrome
DevTools Protocol at `$BROWSER_CDP_URL`.  Drive it with the `browser`
plugin's CLI — a thin Hermes-style wrapper that injects fleet flags
(`--cdp`, `--session-name`, `--state`) and delegates to
`agent-browser` for all browser logic.

    python3 -m hivemoot_agent.plugins_builtin.browser.cli <subcommand> [args]

## When to use

| Task | Use this skill? | Cheaper alternative |
|---|---|---|
| Fetch a JS-rendered SPA's content | ✓ | none — browser is required |
| Log into a SaaS with your bootstrapped cookies | ✓ | none |
| Fill a multi-step form | ✓ | none |
| Read a static HTML page | ✗ | `curl -sL <url>` |
| GitHub / Linear / Notion work via API | ✗ | their respective CLIs / APIs |
| Scrape anti-bot sites anonymously | ✗ | out of scope; report to operator |

**Default to NO.**  Every browser call is multi-second and
multi-MB.  Reach for it only when there's no cheaper path.

## Subcommands (1:1 with agent-browser)

### `navigate <url>`
Open a URL.  Aliases `open` in agent-browser.

    python3 .../cli.py navigate https://example.com
    ✓ Example Domain
      https://example.com/

### `snapshot [--include-iframes]`
Returns the accessibility tree of the current page with stable
element refs (`@e1`, `@e2`, …).  **This is the discovery step
for interactive elements.**  Refs survive DOM re-renders and
encode frame / tab context — use them instead of CSS selectors
whenever you can.

    python3 .../cli.py snapshot
    - Page: Example Domain
      - heading "Example Domain" @e1
      - paragraph "This domain is for use …" @e2
      - link "More information..." @e3

### `click <ref-or-selector>`
Click an element.  `@e3` (aria-ref) is preferred over
`a:nth-child(2)` (CSS).

    python3 .../cli.py click @e3
    python3 .../cli.py click "button[type=submit]"     # CSS fallback

### `type <ref-or-selector> <text>`
Type into an element (appends).

### `fill <ref-or-selector> <text>`
Clear the element, then type.  Use for form inputs.

    python3 .../cli.py fill @e4 "my search query"

### `press <key>`
Send a keyboard key to the focused element.  `Enter`, `Tab`,
`Escape`, `ArrowDown`, etc.

    python3 .../cli.py press Enter

### `screenshot <path> [--full-page]`
Save a PNG.  Default captures the viewport; `--full-page`
captures the entire scrollable height.

    python3 .../cli.py screenshot /tmp/shot.png
    python3 .../cli.py screenshot /tmp/full.png --full-page

Don't pipe screenshots into your context — they're multi-MB
images.  Save to disk, reason about the page via `snapshot`
or `run-js`.

### `run-js <js>`
Evaluate JavaScript in the page.  Use for extraction beyond
what the aria-ref tree exposes.

    python3 .../cli.py run-js "() => document.title"

### `back`
Browser back-button.

### `import-cookies <json-file>`
Bootstrap your session from an exported cookies JSON (no
browser interaction — pure file op).  Two formats accepted:
Playwright native (`{"cookies":[...], "origins":[...]}`) or
bare Cookie-Editor array (`[{"name":..., "value":...}, ...]`).

Next call inherits the session.

### `clear-state`
Forget the agent's session.  Use when a session has gone bad
(logged out, captcha loop, account locked) and you want to
start fresh.

## Bootstrapping a logged-in session

The `browser` plugin does NOT automate form-fill login.  To get
your session into a logged-in state, ask the operator to:

1. Log into the target site in their own browser.
2. Export cookies via Cookie-Editor extension → `cookies.json`.
3. Save the JSON somewhere accessible from your container.
4. Run `import-cookies <path>` — session state written to
   `/state/sessions/$AGENT_ID/`.
5. All subsequent `navigate` / `snapshot` / `click` / `fill`
   calls inherit the logged-in session.

If a task requires login and no session is bootstrapped, **stop
and report to the operator** — don't type credentials.

## Fleet flags (rarely needed — env vars default correctly)

Every subcommand honours:

| Flag | Default | Purpose |
|---|---|---|
| `--cdp-url URL` | `$BROWSER_CDP_URL` | Override sidecar endpoint |
| `--session-name NAME` | `$AGENT_ID` | Override session (cross-agent sharing / isolation) |
| `--no-state` | off | Run anonymous, no session load or save |

## Richer surface — agent-browser directly

The wrapper exposes 11 curated subcommands.  For the full
~50-subcommand agent-browser surface (network interception,
batch flows, PDF rendering, geolocation mocking, upload,
dialog handling, etc.), call `agent-browser` directly — the
binary is on your PATH:

    agent-browser --cdp $BROWSER_CDP_URL --session-name $AGENT_ID <cmd> [args]

Full reference: <https://agent-browser.dev/commands>

## Errors

Non-zero exit with a JSON error on stderr.  Common cases:

| `error` | Meaning | What to do |
|---|---|---|
| `missing_cdp_url` | `$BROWSER_CDP_URL` unset | Operator forgot `APIARY_ENABLE_BROWSER=1` |
| `agent_browser_missing` | binary not on PATH | Runtime image pre-dates hivemoot-agent#593; upgrade |
| `no_state_path` | `--no-state` set but command needs state path | Drop `--no-state` or pass `--session-name` |
| `source_not_found` | `import-cookies` source JSON missing | Check the path |
| `unrecognized_format` | `import-cookies` JSON shape unexpected | Re-export as Playwright native or Cookie-Editor array |

Agent-browser's own errors (nav timeout, selector-not-found, etc.)
pass through verbatim to your stderr — read them as plain text.
