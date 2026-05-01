/**
 * Shared Redis distributed lock primitive.
 *
 * Provides a CAS-based spin lock with a configurable key, TTL, and retry
 * window. Both agent-token and task-store use this primitive; callers supply
 * the lock key and any scoped logging through an optional release-error hook.
 */
import { randomBytes } from "node:crypto";
// ---------------------------------------------------------------------------
// Constants (exported so consumers can reference them in error messages)
// ---------------------------------------------------------------------------
export const LOCK_TTL_SECONDS = 5;
export const LOCK_MAX_WAIT_MS = 1000;
const LOCK_RETRY_MIN_MS = 8;
const LOCK_RETRY_MAX_MS = 20;
// CAS-based atomic release: only deletes the key if the caller still owns it.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class LockTimeoutError extends Error {
    constructor(lockKey) {
        super(`Timed out acquiring Redis lock for key "${lockKey}"`);
        this.name = "LockTimeoutError";
    }
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomRetryDelayMs() {
    return LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_MIN_MS + 1));
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Acquires an exclusive lock on `lockKey`, runs `fn`, then releases the lock.
 *
 * Retries acquisition until `LOCK_MAX_WAIT_MS` elapses. Throws
 * `LockTimeoutError` when the deadline is exceeded. Lock release is
 * best-effort: if it fails, `opts.onReleaseError` is called (if provided) and
 * the primary operation result is returned normally.
 */
export async function withRedisLock(lockKey, redis, fn, opts) {
    const lockOwnerToken = randomBytes(16).toString("hex");
    const deadline = Date.now() + LOCK_MAX_WAIT_MS;
    while (Date.now() < deadline) {
        const acquired = await redis.set(lockKey, lockOwnerToken, {
            nx: true,
            ex: LOCK_TTL_SECONDS,
        });
        if (acquired === "OK") {
            try {
                return await fn();
            }
            finally {
                try {
                    await redis.eval(RELEASE_LOCK_SCRIPT, [lockKey], [lockOwnerToken]);
                }
                catch (error) {
                    opts?.onReleaseError?.(error);
                }
            }
        }
        await sleep(randomRetryDelayMs());
    }
    throw new LockTimeoutError(lockKey);
}
