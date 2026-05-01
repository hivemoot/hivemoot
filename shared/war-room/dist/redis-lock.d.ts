/**
 * Shared Redis distributed lock primitive.
 *
 * Provides a CAS-based spin lock with a configurable key, TTL, and retry
 * window. Both agent-token and task-store use this primitive; callers supply
 * the lock key and any scoped logging through an optional release-error hook.
 */
import { type Redis } from "@upstash/redis";
export declare const LOCK_TTL_SECONDS = 5;
export declare const LOCK_MAX_WAIT_MS = 1000;
export interface WithRedisLockOptions {
    /**
     * Called when the lock-release step fails after the protected operation
     * completes. Release failures are best-effort and never hide the primary
     * operation result — this hook is for scoped logging only.
     */
    onReleaseError?: (error: unknown) => void;
}
export declare class LockTimeoutError extends Error {
    constructor(lockKey: string);
}
/**
 * Acquires an exclusive lock on `lockKey`, runs `fn`, then releases the lock.
 *
 * Retries acquisition until `LOCK_MAX_WAIT_MS` elapses. Throws
 * `LockTimeoutError` when the deadline is exceeded. Lock release is
 * best-effort: if it fails, `opts.onReleaseError` is called (if provided) and
 * the primary operation result is returned normally.
 */
export declare function withRedisLock<T>(lockKey: string, redis: Redis, fn: () => Promise<T>, opts?: WithRedisLockOptions): Promise<T>;
//# sourceMappingURL=redis-lock.d.ts.map