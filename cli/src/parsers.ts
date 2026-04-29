/**
 * Strict integer parsers for commander option values.
 *
 * Why strict: `parseInt("1.5", 10)` silently returns `1`,
 * `parseInt("1abc", 10)` returns `1`, and `parseInt("1e3", 10)`
 * returns `1` — none of which match user intent. For options like
 * `--sequence` (which feeds the server's `sequenceObservedByClient`
 * idempotency / status-drift cursor), a coerced value submits at
 * the wrong sequence and silently masks user typos as
 * "NETWORK_ERROR" downstream. Strict regex-then-Number gives an
 * actionable `INVALID_OPTION` exit instead.
 *
 * Both parsers reject:
 *   - Decimals (`1.5`, `0.0`)
 *   - Trailing garbage (`1abc`, `42 `)
 *   - Leading whitespace / sign (`+1`, ` 1`)
 *   - Exponent notation (`1e3`)
 *   - Empty string, `NaN`, `Infinity`
 *   - Values outside `Number.isSafeInteger` range (≥ 2^53)
 */

import { InvalidArgumentError } from "commander";

const NON_NEGATIVE_INT = /^\d+$/;

export function parseNonNegativeInt(value: string): number {
  if (!NON_NEGATIVE_INT.test(value)) {
    throw new InvalidArgumentError("Must be a non-negative integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(
      `Must be a non-negative integer (within ${Number.MAX_SAFE_INTEGER}).`,
    );
  }
  return n;
}

export function parseLimit(value: string): number {
  if (!NON_NEGATIVE_INT.test(value)) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
}
