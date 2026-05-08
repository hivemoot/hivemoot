/**
 * Redis-backed per-installation queen settings.
 *
 * Each installation gets one hash at `hive:v1:installation:<id>:queen-settings`
 * with `queen_mode` (`cloud | local`, default `cloud`) and an optional
 * `queen_prompt_override` YAML blob (D12). Reads default to `cloud` on
 * Redis-down (G7) so a failed Redis never silently flips an installation
 * into local mode.
 *
 * The `setQueenSettings` mutator runs under a per-installation lock (G12)
 * so that PR 2's mode-flip in-flight check + write happens atomically.
 * PR 1 ships the lock primitive; PR 2 plugs the in-flight check in.
 */

import { type Redis } from "@upstash/redis";
import { withRedisLock } from "@hivemoot/war-room";

const KEY_PREFIX = "hive:v1:installation:";
const KEY_SUFFIX = ":queen-settings";
const LOCK_PREFIX = "hive:v1:lock:installation:";
const LOCK_SUFFIX = ":queen-settings";

export const QUEEN_MODE_VALUES = ["cloud", "local"] as const;
export type QueenMode = (typeof QUEEN_MODE_VALUES)[number];

export const DEFAULT_QUEEN_MODE: QueenMode = "cloud";

export interface QueenSettings {
  queen_mode: QueenMode;
  queen_prompt_override: string | null;
}

const DEFAULT_SETTINGS: QueenSettings = {
  queen_mode: DEFAULT_QUEEN_MODE,
  queen_prompt_override: null,
};

function settingsKey(installationId: string): string {
  return `${KEY_PREFIX}${installationId}${KEY_SUFFIX}`;
}

function lockKey(installationId: string): string {
  return `${LOCK_PREFIX}${installationId}${LOCK_SUFFIX}`;
}

function isQueenMode(value: unknown): value is QueenMode {
  return typeof value === "string" && (QUEEN_MODE_VALUES as readonly string[]).includes(value);
}

/**
 * Reads the queen settings for an installation. Returns the documented
 * default (`{ queen_mode: "cloud", queen_prompt_override: null }`) when:
 *   - the hash doesn't exist (new installation)
 *   - the stored `queen_mode` is malformed (defensive fail-closed)
 *
 * G7: callers should treat any thrown error as "default to cloud" — the
 * Probot cache wrapper does that, see `getQueenModeCached`.
 */
export async function getQueenSettings(
  installationId: string,
  redis: Redis,
): Promise<QueenSettings> {
  const raw = await redis.hgetall<Record<string, string>>(settingsKey(installationId));
  if (!raw || Object.keys(raw).length === 0) return { ...DEFAULT_SETTINGS };

  const mode = raw.queen_mode;
  const queen_mode: QueenMode = isQueenMode(mode) ? mode : DEFAULT_QUEEN_MODE;
  const overrideRaw = raw.queen_prompt_override;
  const queen_prompt_override =
    typeof overrideRaw === "string" && overrideRaw.length > 0 ? overrideRaw : null;

  return { queen_mode, queen_prompt_override };
}

export interface SetQueenSettingsArgs {
  installationId: string;
  redis: Redis;
  /**
   * Optional in-flight precheck. Runs INSIDE the per-installation lock,
   * after acquisition and BEFORE the write. If it returns a non-null
   * value, the write is skipped and the value bubbles back to the
   * caller as `{ ok: false, blocked: <value> }`. PR 2 plugs in the D9
   * "rooms in deciding / decided_pending_action" check here.
   */
  precheck?: (current: QueenSettings) => Promise<{ blocked: unknown } | null>;
  /**
   * The new settings. Pass `queen_prompt_override: null` to delete the
   * override field; omit it to leave the existing override untouched.
   */
  next: {
    queen_mode: QueenMode;
    queen_prompt_override?: string | null;
  };
}

export type SetQueenSettingsResult =
  | { ok: true; previous: QueenSettings; current: QueenSettings }
  | { ok: false; blocked: unknown };

/**
 * Atomically updates queen settings for an installation under a
 * per-installation Redis lock (G12).
 *
 * The protected critical section is:
 *   1. read current settings
 *   2. run the optional precheck (PR 2 plugs in the in-flight check here)
 *   3. write next settings via `HSET`
 *
 * The lock prevents the cloud queen-tick from claiming a room between
 * the in-flight read and the mode write — without it, a race could
 * leave a room mid-claim under the wrong mode.
 *
 * Errors from the lock acquisition (`LockTimeoutError`) bubble to the
 * caller; this is intentional so the operator sees a clear timeout
 * rather than a silent stale read.
 */
export async function setQueenSettings(
  args: SetQueenSettingsArgs,
): Promise<SetQueenSettingsResult> {
  return withRedisLock(lockKey(args.installationId), args.redis, async () => {
    const previous = await getQueenSettings(args.installationId, args.redis);

    if (args.precheck) {
      const blocked = await args.precheck(previous);
      if (blocked) return { ok: false as const, blocked: blocked.blocked };
    }

    const fields: Record<string, string> = { queen_mode: args.next.queen_mode };
    const overrideArg = args.next.queen_prompt_override;
    if (overrideArg !== undefined) {
      // Caller wants to update the override; null means "clear it"
      if (overrideArg === null) {
        await args.redis.hdel(settingsKey(args.installationId), "queen_prompt_override");
      } else {
        fields.queen_prompt_override = overrideArg;
      }
    }

    await args.redis.hset(settingsKey(args.installationId), fields);

    const current: QueenSettings = {
      queen_mode: args.next.queen_mode,
      queen_prompt_override:
        overrideArg === undefined ? previous.queen_prompt_override : overrideArg,
    };

    return { ok: true as const, previous, current };
  });
}
