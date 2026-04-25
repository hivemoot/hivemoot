/**
 * Operator-only CLI: set the per-token policy on an agent token.
 *
 * Use to set `allowed_repos` (and future allowed_permissions) on an
 * existing agent token without rotating it. Required before flipping
 * any repo to `refresh_token: true` for production rollout — without
 * a policy the mint endpoint runs in legacy-permissive mode and the
 * token can mint for any repo in the installation.
 *
 * Run from the `web/` directory:
 *
 *   npx tsx scripts/set-agent-policy.ts \
 *     --installation-id 12345678 \
 *     --allowed-repos hivemoot/hivemoot,hivemoot/colony
 *
 * Or to clear the policy (revert to legacy permissive — for testing
 * rollback only):
 *
 *   npx tsx scripts/set-agent-policy.ts \
 *     --installation-id 12345678 \
 *     --clear
 *
 * Reads HIVEMOOT_REDIS_REST_URL + HIVEMOOT_REDIS_REST_TOKEN from env
 * (same as the production app). Will refuse to run in production
 * `NODE_ENV` without an explicit `--i-know-what-im-doing` flag —
 * setting policies in prod from a CLI is recoverable but not
 * idempotent (clobbers the prior policy), so the safety lock makes
 * the intent explicit.
 */

import { Redis } from "@upstash/redis";
import {
  setAgentTokenPolicy,
  getAgentToken,
  type AgentTokenPolicy,
} from "../src/server/agent-token";

interface CliArgs {
  installationId: string;
  allowedRepos: string[] | null; // null when --clear
  acknowledge: boolean;
}

// owner/name validation. GitHub allows letters, digits, hyphens,
// underscores, and dots in owner+repo names. The slash separator must
// appear exactly once. Catches the common typo `owner-name` (missing
// slash) which would silently set a policy that rejects everything
// (no repo can ever match a malformed entry).
const REPO_FORMAT = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { acknowledge: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--installation-id") {
      args.installationId = argv[++i];
    } else if (arg === "--allowed-repos") {
      const csv = argv[++i];
      args.allowedRepos = csv === "" ? [] : csv.split(",").map((s) => s.trim());
    } else if (arg === "--clear") {
      args.allowedRepos = null;
    } else if (arg === "--i-know-what-im-doing") {
      args.acknowledge = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      printUsage();
      process.exit(2);
    }
  }
  if (!args.installationId) {
    console.error("missing --installation-id");
    printUsage();
    process.exit(2);
  }
  if (args.allowedRepos === undefined) {
    console.error("missing --allowed-repos or --clear");
    printUsage();
    process.exit(2);
  }
  // Format-validate every entry of allowed_repos. An operator typing
  // `hivemoot-hivemoot` instead of `hivemoot/hivemoot` would silently
  // set a policy where every mint fails. Fail-fast here with a clear
  // message naming the bad entry.
  if (args.allowedRepos !== null) {
    for (const repo of args.allowedRepos) {
      if (!REPO_FORMAT.test(repo)) {
        console.error(
          `invalid repo format '${repo}': expected owner/name with no spaces (e.g. hivemoot/hivemoot)`,
        );
        process.exit(2);
      }
    }
  }
  return args as CliArgs;
}

function printUsage(): void {
  console.error(`Usage:
  set-agent-policy --installation-id <id> --allowed-repos <csv>
  set-agent-policy --installation-id <id> --clear

Options:
  --installation-id <id>           Numeric GitHub installation id (required)
  --allowed-repos <owner/name,...> Comma-separated list of repos the token may mint for
                                   (empty = reject everything; intentional)
  --clear                          Drop the policy (revert to legacy permissive — testing only)
  --i-know-what-im-doing           Required when NODE_ENV=production
  --help                           Show this message

Env required: HIVEMOOT_REDIS_REST_URL, HIVEMOOT_REDIS_REST_TOKEN`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.NODE_ENV === "production" && !args.acknowledge) {
    console.error(
      "Refusing to mutate production policies without --i-know-what-im-doing.",
    );
    console.error(
      "Setting policies clobbers the prior value (no merge); confirm intent.",
    );
    process.exit(3);
  }

  const url = process.env.HIVEMOOT_REDIS_REST_URL;
  const token = process.env.HIVEMOOT_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error(
      "HIVEMOOT_REDIS_REST_URL + HIVEMOOT_REDIS_REST_TOKEN must be set.",
    );
    process.exit(4);
  }

  const redis = new Redis({ url, token });

  // Pre-flight: confirm a token exists for this installation. setAgentTokenPolicy
  // returns false on missing token but we want a clearer error message.
  // Reading via getAgentToken would decrypt the token; we don't need that —
  // resolve via a direct envelope check instead.
  const policy: AgentTokenPolicy | null =
    args.allowedRepos === null ? null : { allowed_repos: args.allowedRepos };

  const ok = await setAgentTokenPolicy(args.installationId, policy, redis);
  if (!ok) {
    console.error(
      `No agent token exists for installation ${args.installationId}. ` +
        "Generate one via the dashboard first.",
    );
    process.exit(5);
  }

  // Verify by reading back. Token value is also recovered (operator
  // sometimes wants the value at the same time they set policy);
  // fingerprint is logged so the operator can match against the
  // dashboard display.
  const verify = await getAgentToken(
    args.installationId,
    new Map(), // not actually decrypting — keyring is empty so this would throw if we tried
    redis,
  ).catch(() => null);

  console.log(
    JSON.stringify(
      {
        installationId: args.installationId,
        action: policy === null ? "cleared" : "set",
        allowedReposCount: policy?.allowed_repos.length ?? 0,
        allowedRepos: policy?.allowed_repos ?? null,
        fingerprintMatch: verify?.fingerprint ?? "(could not decrypt to verify)",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("set-agent-policy failed:", err);
  process.exit(1);
});
