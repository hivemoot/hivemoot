/**
 * Environment Variable Normalization
 *
 * Shared utility for normalizing LLM-related environment variable values:
 * strips surrounding whitespace, removes matching quote pairs, and returns
 * undefined for empty or whitespace-only strings.
 *
 * The optional `name` parameter enables a warning log when normalization
 * changes the value — useful for diagnosing silent env var mutations in
 * production (e.g., a quoted ANTHROPIC_API_KEY in a .env file).
 */

/**
 * Normalize an environment variable value by trimming whitespace and
 * stripping surrounding matching quotes.
 *
 * Returns undefined if the input is undefined or results in an empty string
 * after normalization.
 *
 * @param value - The raw environment variable value to normalize.
 * @param name  - Optional variable name, used in a warning log when
 *               normalization changes the value.
 */
export function normalizeEnvString(value: string | undefined, name?: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const hasMatchingQuotes =
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"));
  if (hasMatchingQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  if (normalized !== value && name) {
    console.warn(`[llm] env var ${name} was normalized (whitespace/quotes removed)`);
  }

  return normalized.length > 0 ? normalized : undefined;
}
