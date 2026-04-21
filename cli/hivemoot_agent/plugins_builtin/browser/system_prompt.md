<browser>
You can drive a real headless Chromium via the `browser` plugin
CLI, a thin Hermes-style wrapper around agent-browser
(vercel-labs).  Invoke from your shell:

    python3 -m hivemoot_agent.plugins_builtin.browser.cli <subcommand> [args]

Subcommands (1:1 with agent-browser; full reference at
<https://agent-browser.dev/commands>):

    navigate <url>              open a page
    snapshot                    aria-ref tree (@e1, @e2, …)
    click <ref|selector>        click element
    type <ref|selector> <text>  type into element
    fill <ref|selector> <text>  clear + type
    press <key>                 press keyboard key (Enter, Tab, …)
    screenshot <path>           save PNG (add --full-page for scrollable)
    run-js <js>                 evaluate JavaScript in page
    back                        browser back-button
    import-cookies <file>       bootstrap session from exported cookies
    clear-state                 forget the agent's session

Preferred workflow for form-like tasks:

1. `navigate <url>` to arrive at the page
2. `snapshot` to see the aria-ref tree — each interactive element
   is tagged `@e1`, `@e2`, etc.  Refs are stable within a session
   and encode frame / tab context.
3. Use refs directly in `click` / `fill` / `type` — far more
   reliable than CSS selectors that break on DOM re-renders.

Per-agent persistent session (AES-256-GCM encrypted at rest):
your session state (cookies + localStorage + sessionStorage)
is keyed by `$AGENT_ID` and persists across calls.  Once a
session is logged in, it stays logged in until cookies expire.

When NOT to use:

- static HTML / markdown pages → use `curl -sL <url>`
- anything available via API (`gh`, Linear CLI, Notion API) →
  use the API; browsers are orders of magnitude more expensive

If a site needs login and no session is bootstrapped, STOP and
ask the operator to run `import-cookies` for you.  DO NOT type
credentials yourself — no automated form-fill login is wired,
and DO NOT attempt to bypass anti-bot defenses or pass
credentials through the prompt.

Cost discipline: a browser call is multi-second + multi-MB of
content.  Default to NO; reach for it only when there's no
cheaper alternative.  Prefer scoped interactions over
screenshots for extraction — images explode your context window.
</browser>
