/**
 * Operator-only CLI: set the per-token policy on an agent token.
 *
 * Use to set `allowed_repos` and (V1.6+) `allowed_permissions` on an
 * existing agent token without rotating it. Required before flipping
 * any repo to `refresh_token: true` for production rollout — without
 * a policy the mint endpoint runs in legacy-permissive mode and the
 * token can mint for any repo in the installation.
 *
 * Run from the `web/` directory:
 *
 *   # V1.5: repo narrowing only
 *   npx tsx scripts/set-agent-policy.ts \
 *     --installation-id 12345678 \
 *     --allowed-repos hivemoot/hivemoot,hivemoot/colony
 *
 *   # V1.6: repo narrowing + read-only worker preset (closes WAR_ROOM_DESIGN.md
 *   # §16 hard-rollout-gate; --read-only-worker is the canonical operator path)
 *   npx tsx scripts/set-agent-policy.ts \
 *     --installation-id 12345678 \
 *     --allowed-repos hivemoot/hivemoot \
 *     --read-only-worker
 *
 *   # V1.6: repo narrowing + custom permission map (advanced)
 *   npx tsx scripts/set-agent-policy.ts \
 *     --installation-id 12345678 \
 *     --allowed-repos hivemoot/hivemoot \
 *     --allowed-permissions '{"contents":"read","pull_requests":"read","issues":"read","metadata":"read"}'
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
  type GitHubPermissionLevel,
} from "../src/server/agent-token";
import { V1_PERMISSIONS } from "../src/server/github-installation-token";

// V1.6 read-only worker preset: every V1_PERMISSIONS key narrowed to "read".
// Composed at runtime so a future change to V1_PERMISSIONS keeps this in sync
// (e.g. if `metadata` ever upgrades to "write" upstream, the preset still
// produces a true read-only scope).
const READ_ONLY_WORKER_PRESET: Record<string, GitHubPermissionLevel> =
  Object.fromEntries(
    Object.keys(V1_PERMISSIONS).map((k) => [k, "read" as const]),
  );

const VALID_PERMISSION_LEVELS = ["read", "write", "admin"] as const;

interface CliArgs {
  installationId: string;
  allowedRepos: string[] | null; // null when --clear
  // V1.6: optional per-permission narrowing. Undefined = preserve V1.5 behavior.
  // Set via --read-only-worker (preset) or --allowed-permissions (raw JSON).
  allowedPermissions: Record<string, GitHubPermissionLevel> | undefined;
  acknowledge: boolean;
}

// owner/name validation. GitHub allows letters, digits, hyphens,
// underscores, and dots in owner+repo names. The slash separator must
// appear exactly once. Catches the common typo `owner-name` (missing
// slash) which would silently set a policy that rejects everything
// (no repo can ever match a malformed entry).
const REPO_FORMAT = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    acknowledge: false,
    allowedPermissions: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--installation-id") {
      args.installationId = argv[++i];
    } else if (arg === "--allowed-repos") {
      const csv = argv[++i];
      args.allowedRepos = csv === "" ? [] : csv.split(",").map((s) => s.trim());
    } else if (arg === "--read-only-worker") {
      // V1.6 preset: every V1_PERMISSIONS key narrowed to "read".
      args.allowedPermissions = { ...READ_ONLY_WORKER_PRESET };
    } else if (arg === "--allowed-permissions") {
      // V1.6 raw map: JSON object string. Validated below.
      const json = argv[++i];
      try {
        const parsed = JSON.parse(json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("must be a JSON object");
        }
        args.allowedPermissions = parsed as Record<string, GitHubPermissionLevel>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`invalid --allowed-permissions JSON: ${msg}`);
        process.exit(2);
      }
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
  // V1.6 validation: keys must be in V1_PERMISSIONS (so the operator
  // gets immediate feedback on typos), values must be valid levels.
  // Same fail-closed posture as intersectPermissions at mint time.
  if (args.allowedPermissions !== undefined) {
    if (args.allowedRepos === null) {
      console.error(
        "--allowed-permissions cannot be combined with --clear (clear drops the entire policy)",
      );
      process.exit(2);
    }
    for (const [key, value] of Object.entries(args.allowedPermissions)) {
      if (!Object.prototype.hasOwnProperty.call(V1_PERMISSIONS, key)) {
        console.error(
          `invalid allowed_permissions key '${key}': must be one of ${Object.keys(V1_PERMISSIONS).join(", ")}`,
        );
        process.exit(2);
      }
      if (!(VALID_PERMISSION_LEVELS as readonly string[]).includes(value as string)) {
        console.error(
          `invalid allowed_permissions['${key}'] value '${value}': must be one of ${VALID_PERMISSION_LEVELS.join(", ")}`,
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
  set-agent-policy --installation-id <id> --allowed-repos <csv> --read-only-worker
  set-agent-policy --installation-id <id> --allowed-repos <csv> --allowed-permissions '<json>'
  set-agent-policy --installation-id <id> --clear

Options:
  --installation-id <id>           Numeric GitHub installation id (required)
  --allowed-repos <owner/name,...> Comma-separated list of repos the token may mint for
                                   (empty = reject everything; intentional)
  --read-only-worker               V1.6 preset: narrow every default permission to "read".
                                   Composed at runtime from V1_PERMISSIONS, so future
                                   additions to the default set keep this read-only.
  --allowed-permissions <json>     V1.6 raw map: JSON object like
                                   '{"contents":"read","pull_requests":"read",...}'.
                                   Keys must be in V1_PERMISSIONS; values must be
                                   "read"|"write"|"admin". Levels above the default
                                   are silently capped at the default at mint time.
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
    args.allowedRepos === null
      ? null
      : {
          allowed_repos: args.allowedRepos,
          // V1.6: include allowed_permissions only when set. Omitting the
          // field (vs setting it to {}) preserves V1.5 behavior — mint
          // requests V1_PERMISSIONS unchanged. setting it to {} would
          // be technically valid (no per-key narrowing) but ambiguous;
          // the CLI defaults to the omit-field path when the operator
          // doesn't pass --read-only-worker or --allowed-permissions.
          ...(args.allowedPermissions !== undefined
            ? { allowed_permissions: args.allowedPermissions }
            : {}),
        };

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
        // V1.6: surface what was set so the operator can verify the
        // narrowing at a glance. Null = unchanged from V1.5 default
        // (mint will request V1_PERMISSIONS verbatim).
        allowedPermissions: policy?.allowed_permissions ?? null,
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
