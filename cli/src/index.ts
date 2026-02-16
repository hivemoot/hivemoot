import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { buzzCommand } from "./commands/buzz.js";
import { rolesCommand } from "./commands/roles.js";
import { roleCommand } from "./commands/role.js";
import { initCommand } from "./commands/init.js";
import { watchCommand } from "./commands/watch.js";
import { ackCommand } from "./commands/ack.js";
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
  .option("--repo <owner/repo>", "Target repository (default: detect from git)")
  .addHelpText(
    "after",
    `
Examples:
  $ hivemoot buzz
    Show repo work summary (issues, PRs, notifications)

  $ hivemoot buzz --role worker
    Get worker role instructions and repo summary

  $ hivemoot buzz --json
    Output as JSON`,
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
    List available roles with descriptions

  $ hivemoot roles --json
    Output as JSON`,
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
  $ hivemoot role worker
    Get full instructions for the worker role

  $ hivemoot role worker --json
    Output as JSON`,
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
  $ hivemoot watch --repo hivemoot/hivemoot
    Watch for mentions (polls every 5 minutes by default)

  $ hivemoot watch --repo hivemoot/hivemoot --once
    Check once and exit

  $ hivemoot watch --repo hivemoot/hivemoot --interval 60
    Poll every 60 seconds`,
  )
  .action(watchCommand);

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
    Mark the notification as processed and persist it in the journal`,
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
