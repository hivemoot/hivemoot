/**
 * Command Parser
 *
 * Parses @mention + command patterns from issue/PR comment bodies.
 * Responds to @hivemoot mentions only. The leading slash is optional
 * for known command verbs.
 *
 * Examples:
 *   "@hivemoot /vote"                → { verb: "vote", freeText: undefined }
 *   "@hivemoot vote"                 → { verb: "vote", freeText: undefined }
 *   "@hivemoot /implement"           → { verb: "implement", freeText: undefined }
 *   "@hivemoot implement"            → { verb: "implement", freeText: undefined }
 *   "@hivemoot /vote good idea"      → { verb: "vote", freeText: "good idea" }
 */

/**
 * Parsed command extracted from a comment body.
 */
export interface ParsedCommand {
  /** The command verb (e.g., "vote", "implement") */
  verb: string;
  /** Optional free-text argument following the verb */
  freeText: string | undefined;
}

/**
 * Mention name the bot responds to.
 * Limited to @hivemoot to avoid spamming the real @queen GitHub account.
 */
const MENTION_NAMES = ["hivemoot"] as const;

/**
 * Known command verbs that can be used without a leading slash.
 * When a slash is present, any verb is accepted (forwarded to the handler
 * for dispatch). When the slash is absent, only these verbs are recognized
 * to avoid false-positive matches on regular @mention prose.
 */
const KNOWN_VERBS = new Set(["vote", "implement", "preflight", "squash", "gather"]);

/**
 * Line-anchored regex to match @mention + optional-slash + verb.
 *
 * Only matches when the @mention is the first non-whitespace token on a line.
 * This prevents accidental triggers from prose, inline code, or mid-sentence mentions.
 *
 * Capture groups:
 *   1 — The slash (if present) or empty string
 *   2 — The verb
 *   3 — Optional free-text argument
 *
 * The pattern is case-insensitive and allows whitespace between mention and command.
 * The `m` flag enables `^` to match the start of each line.
 */
const COMMAND_PATTERN = new RegExp(
  `^\\s*@(?:${MENTION_NAMES.join("|")})\\s+(/)?([a-zA-Z]\\w*)(?:\\s+(.+))?`,
  "im",
);

/**
 * Strip lines that should not be parsed for commands:
 * - GitHub-style quoted lines (lines starting with >)
 * - Fenced code blocks (``` ... ```)
 * - Inline code containing @mention patterns
 */
function stripNonCommandContent(body: string): string {
  // Remove fenced code blocks first
  let cleaned = body.replace(/```[\s\S]*?```/g, "");

  // Remove inline code spans that contain mention patterns
  cleaned = cleaned.replace(/`[^`]*@hivemoot[^`]*`/gi, "");

  // Remove quoted lines
  return cleaned
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/**
 * Parse a comment body for a bot command.
 *
 * Returns the parsed command if found, or null if the comment
 * does not contain a recognized command pattern.
 *
 * When the leading slash is present (`@hivemoot /verb`), any verb is accepted.
 * When the slash is absent (`@hivemoot verb`), only known command verbs are
 * recognized — this prevents `@hivemoot great work` from being misinterpreted.
 *
 * Quoted lines, fenced code blocks, and inline code are ignored.
 * Commands must start at the beginning of a line (after optional whitespace).
 */
export function parseCommand(body: string): ParsedCommand | null {
  const unquoted = stripNonCommandContent(body);
  const match = unquoted.match(COMMAND_PATTERN);
  if (!match) {
    return null;
  }

  const hasSlash = match[1] === "/";
  const verb = match[2].toLowerCase();
  const freeText = match[3]?.trim() || undefined;

  // Without the slash, only accept known command verbs
  if (!hasSlash && !KNOWN_VERBS.has(verb)) {
    return null;
  }

  return { verb, freeText };
}
