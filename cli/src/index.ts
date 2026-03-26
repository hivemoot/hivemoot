import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
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
import { CliError } from "./config/types.js";
import { setGhToken } from "./github/client.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

function parseLimit(value: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
}

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
