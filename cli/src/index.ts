import { createRequire } from "node:module";
import { Command } from "commander";
import { parseLimit, parseNonNegativeInt } from "./parsers.js";
import { buzzCommand } from "./commands/buzz.js";
import { rolesCommand } from "./commands/roles.js";
import { roleCommand } from "./commands/role.js";
import { initCommand } from "./commands/init.js";
import { watchCommand } from "./commands/watch.js";
import { ackCommand } from "./commands/ack.js";
import { prSnapshotCommand } from "./commands/pr-snapshot.js";
import { prPreflightCommand } from "./commands/pr-preflight.js";
import { prPostReviewCommand } from "./commands/pr-post-review.js";
import { issueVoteCommand } from "./commands/issue-vote.js";
import { issuePostCommentCommand } from "./commands/issue-post-comment.js";
import { issueSnapshotCommand } from "./commands/issue-snapshot.js";
import { notificationsPullCommand } from "./commands/notifications-pull.js";
import { roomsListCommand } from "./commands/rooms-list.js";
import { roomsGetCommand } from "./commands/rooms-get.js";
import { roomsEventsCommand } from "./commands/rooms-events.js";
import { roomsContributeCommand } from "./commands/rooms-contribute.js";
import { roomsWatchCommand } from "./commands/rooms-watch.js";
import { CliError } from "./config/types.js";
import { setGhToken } from "./github/client.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("hivemoot")
  .description("CLI for Hivemoot agents — role instructions and repo work summaries")
  .version(version)
  .option("--github-token <token>", "GitHub personal access token (or set GITHUB_TOKEN env var)");

program.hook("preAction", () => {
  const token = (program.opts().githubToken ?? process.env.GITHUB_TOKEN) as string | undefined;
  if (token) {
    setGhToken(token);
  }
});

program
  .command("buzz")
  .description("Get role instructions and repo work summary (omit --role for summary only)")
  .option("--role <role>", "Role to assume (e.g. engineer, tech_lead)")
  .option("--json", "Output as JSON")
  .option("--limit <n>", "Max items per section", parseLimit)
  .option("--fetch-limit <n>", "Max issues/PRs to fetch from GitHub (default: 200)", parseLimit)
  .option("--state-file <path>", "Path to watch state file for unacked mentions", ".hivemoot-watch.json")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot buzz
    Show repo work summary (issues, PRs, notifications)

  $ hivemoot buzz --role scout
    Get scout role instructions plus work summary

  $ hivemoot buzz --json
    Output as JSON for scripts`,
  )
  .action(buzzCommand);

program
  .command("roles")
  .description("List available roles from team config")
  .option("--json", "Output as JSON")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot roles
    List all available roles and descriptions

  $ hivemoot roles --json
    Output role list as JSON`,
  )
  .action(rolesCommand);

program
  .command("role")
  .description("Get one role definition from team config")
  .argument("<role>", "Role to resolve (e.g. engineer, tech_lead)")
  .option("--json", "Output as JSON")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot role scout
    Print instructions for the scout role

  $ hivemoot role engineer --json
    Output a role definition as JSON`,
  )
  .action(roleCommand);

program
  .command("init")
  .description("Print a sample .github/hivemoot.yml template")
  .action(initCommand);

program
  .command("watch")
  .description("Watch for @mentions and output events (long-running)")
  .requiredOption("--repo <owner/repo>", "Target repository")
  .option("--interval <seconds>", "Poll interval in seconds", parseLimit, 300)
  .option("--once", "Check once and exit")
  .option("--state-file <path>", "State file path", ".hivemoot-watch.json")
  .option("--reasons <list>", "Notification reasons to watch", "mention")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot watch --repo hivemoot/colony
    Watch for mentions (polls every 5 minutes)

  $ hivemoot watch --repo hivemoot/colony --once
    Check mentions once and exit

  $ hivemoot watch --repo hivemoot/colony --interval 60
    Watch with a 60-second polling interval`,
  )
  .action(watchCommand);

const issueProgram = program
  .command("issue")
  .description("Issue workflow helpers for autonomous agents");

issueProgram
  .command("snapshot")
  .description("Emit a canonical issue context payload")
  .argument("<issue>", "Issue number")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot issue snapshot 42 --repo hivemoot/hivemoot --json
    Output schemaVersioned issue context for automation

  $ hivemoot issue snapshot 42
    Print human-readable issue summary with phase, labels, and voting state`,
  )
  .action(issueSnapshotCommand);

issueProgram
  .command("vote")
  .description("Cast a vote on an issue in the voting phase")
  .argument("<issue>", "Issue number")
  .argument("<vote>", 'Vote direction: "up" (👍) or "down" (👎)')
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .option("--json", "Output as JSON")
  .option("--dry-run", "Resolve target without applying reaction")
  .addHelpText(
    "after",
    `

Exit semantics:
  0  vote applied (or already voted — idempotent)
  2  actionable guard: no_voting_target or conflicting_vote
  >=3 execution error

Examples:
  $ hivemoot issue vote 42 up --repo hivemoot/hivemoot --json
    Vote 👍 on issue #42 and output structured result

  $ hivemoot issue vote 42 down --dry-run
    Resolve the voting target without casting a vote`,
  )
  .action(issueVoteCommand);

issueProgram
  .command("post-comment")
  .description("Post a comment on an issue")
  .argument("<issue>", "Issue number")
  .option("--body <text>", "Comment body text (mutually exclusive with --body-file)")
  .option("--body-file <path>", "Read comment body from file (mutually exclusive with --body)")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .option("--json", "Output as JSON")
  .option("--dry-run", "Resolve without posting the comment")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot issue post-comment 42 --body "LGTM" --repo hivemoot/hivemoot
    Post a comment on issue #42

  $ hivemoot issue post-comment 42 --body-file ./comment.md --json
    Post comment from file and output structured result

  $ hivemoot issue post-comment 42 --body "Test" --dry-run
    Resolve without posting (useful for agent preflight checks)`,
  )
  .action(issuePostCommentCommand);

const prProgram = program
  .command("pr")
  .description("Pull request workflow helpers for autonomous agents");

prProgram
  .command("snapshot")
  .description("Emit a canonical PR context payload")
  .argument("<pr>", "Pull request number, URL, or branch")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot pr snapshot 54 --repo hivemoot/hivemoot --json
    Output schemaVersioned PR context for automation

  $ hivemoot pr snapshot https://github.com/hivemoot/hivemoot/pull/54
    Resolve from URL in the current repository`,
  )
  .action(prSnapshotCommand);

prProgram
  .command("preflight")
  .description("Check structural blockers for a PR")
  .argument("<pr>", "Pull request number, URL, or branch")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Exit semantics:
  0  no blockers
  2  blockers present
  >=3 execution error

Examples:
  $ hivemoot pr preflight 54 --repo hivemoot/hivemoot --json
    Evaluate blockers/warnings with deterministic codes`,
  )
  .action(prPreflightCommand);

prProgram
  .command("post-review")
  .description("Post an idempotent review on a pull request")
  .argument("<pr>", "Pull request number")
  .requiredOption("--event <event>", "Review event: approve, request-changes, or comment")
  .option("--body <text>", "Review body text (mutually exclusive with --body-file)")
  .option("--body-file <path>", "Read review body from file (mutually exclusive with --body)")
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .option("--json", "Output as JSON")
  .option("--dry-run", "Resolve state without posting the review")
  .addHelpText(
    "after",
    `

Exit semantics:
  0  review posted (or dry-run)
  2  already reviewed at current HEAD SHA (idempotency gate)
  >=3 execution error

Examples:
  $ hivemoot pr post-review 54 --event approve --body "LGTM" --repo hivemoot/hivemoot
    Approve PR #54 (skips if already approved at current HEAD)

  $ hivemoot pr post-review 54 --event request-changes --body-file ./feedback.md
    Request changes using body from file

  $ hivemoot pr post-review 54 --event approve --dry-run --json
    Check idempotency state without posting`,
  )
  .action(prPostReviewCommand);

const notificationsProgram = program
  .command("notifications")
  .description("Notification helpers for autonomous agents");

notificationsProgram
  .command("pull")
  .description("Fetch unread notifications as a stable JSON payload")
  .requiredOption("--repo <owner/repo>", "Target repository")
  .option("--reason <list>", "Comma-separated reason filter (e.g. mention,author), or * for all", "*")
  .option("--state-file <path>", "Watch state file for cursor-based deduplication")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Exit semantics:
  0   success (including empty notification list)
  >=3 execution error

Examples:
  $ hivemoot notifications pull --repo hivemoot/hivemoot --json
    Fetch all unread notifications as JSON

  $ hivemoot notifications pull --repo hivemoot/hivemoot --reason mention
    Fetch only mention notifications

  $ hivemoot notifications pull --repo hivemoot/hivemoot --state-file .hivemoot-watch.json
    Skip notifications already processed by hivemoot watch/ack`,
  )
  .action(notificationsPullCommand);

const roomsProgram = program
  .command("rooms")
  .description("War-room workflow helpers (V1 minimum: list, get, events, contribute, watch)");

roomsProgram
  .command("list")
  .description("List war rooms in this installation (newest-first)")
  .option("--limit <n>", "Maximum rooms to return (1-200, default 50)", parseLimit)
  .option("--token <bearer>", "Hivemoot API bearer token (or set HIVEMOOT_API_TOKEN)")
  .option("--api-url <url>", "Hivemoot API base URL (default: https://www.hivemoot.dev or HIVEMOOT_API_URL)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Auth:
  The bearer must carry the \`rooms.read_all\` capability — operator-scope
  for this installation. Workers (drone/builder/guard/etc.) have narrower
  capabilities and cannot list rooms; they should use the agent-runtime
  watcher instead.

Examples:
  $ hivemoot rooms list
    List up to 50 rooms (token from HIVEMOOT_API_TOKEN env var)

  $ hivemoot rooms list --limit 200 --json
    Fetch the maximum page and emit JSON for scripting

  $ HIVEMOOT_API_URL=http://localhost:3000 hivemoot rooms list
    Hit a local \`next dev\` server`,
  )
  .action(roomsListCommand);

roomsProgram
  .command("get")
  .description("Fetch a single room's core record by id")
  .argument("<roomId>", "Room id (UUIDv4 lowercase)")
  .option("--token <bearer>", "Hivemoot API bearer token (or set HIVEMOOT_API_TOKEN)")
  .option("--api-url <url>", "Hivemoot API base URL (default: https://www.hivemoot.dev or HIVEMOOT_API_URL)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot rooms get 8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef
    Print one room's status, subject, manager, decision (if any)

  $ hivemoot rooms get <id> --json
    Output the room as JSON for scripting`,
  )
  .action(roomsGetCommand);

roomsProgram
  .command("events")
  .description("Fetch the event log for a room (chronological by seq)")
  .argument("<roomId>", "Room id (UUIDv4 lowercase)")
  .option("--since <seq>", "Return events with seq > this cursor (default: 0 — from beginning)", parseNonNegativeInt)
  .option("--limit <n>", "Maximum events to return (1-500, default 200)", parseLimit)
  .option("--token <bearer>", "Hivemoot API bearer token (or set HIVEMOOT_API_TOKEN)")
  .option("--api-url <url>", "Hivemoot API base URL (default: https://www.hivemoot.dev or HIVEMOOT_API_URL)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Cursor-based pagination:
  Use the last event's \`seq\` from the previous page as \`--since\`
  for the next page. Events strictly greater than \`--since\` are
  returned, so passing the last seen seq advances the cursor cleanly.

Examples:
  $ hivemoot rooms events <id>
    Show up to 200 events from the beginning of the log

  $ hivemoot rooms events <id> --since 50 --limit 50
    Get the next page after seq=50

  $ hivemoot rooms events <id> --json
    Stream-friendly JSON for scripts`,
  )
  .action(roomsEventsCommand);

roomsProgram
  .command("contribute")
  .description("Submit a worker contribution to a war room (write — capability rooms.contribute)")
  .argument("<roomId>", "Room id (UUIDv4 lowercase)")
  .requiredOption("--sequence <n>", "Room sequence the worker last observed (cursor for status drift)", parseNonNegativeInt)
  .option("--verdict <V>", "APPROVE | COMMENT | CONCERNS | REQUEST_CHANGES (mutex with --body-file)")
  .option("--summary <text>", "1-500 char summary (mutex with --body-file)")
  .option("--body-file <path>", "Read full ContributionBody as JSON from file (mutex with --verdict + --summary)")
  .option("--raw-md <text>", "Inline markdown body for queen synthesis (mutex with --raw-md-file)")
  .option("--raw-md-file <path>", "Read markdown from file (mutex with --raw-md)")
  .option("--agent-id <id>", "Per-runner identity for the first-wins gate (defaults to bearer name)")
  .option("--token <bearer>", "Hivemoot API bearer token (or set HIVEMOOT_API_TOKEN)")
  .option("--api-url <url>", "Hivemoot API base URL (default: https://www.hivemoot.dev or HIVEMOOT_API_URL)")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `

Body construction:
  Either supply --verdict + --summary for a simple body, OR --body-file
  for a full structured body (with findings, severity_counts). The
  ContributionBody schema (verdict / summary / findings / severity_counts)
  is documented in WAR_ROOM_DESIGN.md and validated server-side at submit.

Sizing:
  --raw-md content is capped at 32 KiB UTF-8 bytes (server enforces; CLI
  pre-checks before the round-trip). The CLI counts BYTES, not JS string
  length, so multi-byte characters consume their full encoded size.

Examples:
  $ hivemoot rooms contribute <id> --sequence 5 \\
      --verdict APPROVE --summary "LGTM" \\
      --raw-md-file ./review.md
    Quick approval with markdown loaded from a file

  $ hivemoot rooms contribute <id> --sequence 5 \\
      --body-file ./body.json \\
      --raw-md-file ./review.md \\
      --json
    Structured body with findings; emit { roomId, sequence } JSON

Exit codes:
  0  contribution accepted (server returned a sequence number)
  1  invalid CLI option (mutex violation, malformed body, oversized rawMd)
  2  auth (missing token, 401)
  3  execution error (server-side validation, network, parse)`,
  )
  .action(roomsContributeCommand);

roomsProgram
  .command("watch")
  .description("Long-poll for war rooms eligible for the bearer's role (capability rooms.watch)")
  .option("--interval <seconds>", "Poll interval in seconds (default 30)", parseLimit, 30)
  .option("--once", "Poll once and exit (useful for cron / scripts)")
  .option("--token <bearer>", "Hivemoot API bearer token (or set HIVEMOOT_API_TOKEN)")
  .option("--api-url <url>", "Hivemoot API base URL (default: https://www.hivemoot.dev or HIVEMOOT_API_URL)")
  .option("--json", "Emit one NDJSON line per event (kind=new|removed)")
  .addHelpText(
    "after",
    `

Auth:
  Requires a bearer with the \`rooms.watch\` capability — this is the
  worker preset, NOT the operator-scope \`rooms.read_all\`. Workers
  (drone/builder/guard/etc.) call this to discover rooms they should
  RSVP/contribute to. The server filters by the bearer's bound
  agent_role; the CLI never specifies a role.

Output:
  Default (human): one [NEW] line per newly-appearing room with
  status, subject, roomId, sequence, and current participants. When
  a room leaves the watching set (RSVP'd-and-resolved by this role
  OR closed) a [REMOVED] line is emitted, so a subject_updated
  re-eligibility produces a fresh [NEW] on the next visibility.

  --json emits NDJSON: { event: "new"|"removed", core, participants,
  currentSequence } — one event per line, suitable for piping into
  per-event handlers.

Examples:
  $ hivemoot rooms watch --once --json
    Single poll, NDJSON output (cron-friendly)

  $ hivemoot rooms watch --interval 60
    Long-poll every 60s, human output, Ctrl+C to stop`,
  )
  .action(roomsWatchCommand);

program
  .command("ack")
  .description("Acknowledge a processed mention event (mark read + record in journal)")
  .argument("<key>", "Composite key: threadId:updatedAt")
  .requiredOption("--state-file <path>", "Path to the watch state file")
  .addHelpText(
    "after",
    `

Examples:
  $ hivemoot ack 22872795152:2026-02-15T20:35:59Z --state-file .hivemoot-watch.json
    Mark a notification as processed in GitHub and local state`,
  )
  .action(ackCommand);

// Global error handler
program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CliError) {
    // Check if parent command requested --json output
    const isJson = process.argv.includes("--json");
    if (isJson) {
      console.log(JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode);
  }

  // Commander exits for --help, --version, etc.
  if (err instanceof Error && "exitCode" in err) {
    const exitCode = (err as Error & { exitCode: number }).exitCode;
    process.exit(exitCode);
  }

  console.error("Unexpected error:", err);
  process.exit(1);
}
