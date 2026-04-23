/**
 * Detect whether a PR body contains same-repository closing keyword syntax.
 *
 * Supported forms:
 * - Fixes #123
 * - Closes owner/repo#123
 * - Resolves https://github.com/owner/repo/issues/123
 */

interface RepositoryRef {
  owner: string;
  repo: string;
}

const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+([^\s]+)/gi;

const ISSUE_NUMBER_PATTERN = /^#\d+$/;
const QUALIFIED_REFERENCE_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#\d+$/;
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+$/i;

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[),.;:!?]+$/, "");
}

function stripMarkdownCode(body: string): string {
  return body
    // Remove fenced code blocks (```...``` and ~~~...~~~)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    // Remove inline code spans (`...`)
    .replace(/`[^`]*`/g, " ");
}

export function hasSameRepoClosingKeywordRef(body: string | null | undefined, repository: RepositoryRef): boolean {
  if (!body) {
    return false;
  }

  const searchableBody = stripMarkdownCode(body);
  const normalizedOwner = repository.owner.toLowerCase();
  const normalizedRepo = repository.repo.toLowerCase();

  for (const match of searchableBody.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const rawTarget = match[1];
    if (!rawTarget) continue;

    const target = stripTrailingPunctuation(rawTarget);
    if (ISSUE_NUMBER_PATTERN.test(target)) {
      return true;
    }

    const qualifiedMatch = target.match(QUALIFIED_REFERENCE_PATTERN);
    if (qualifiedMatch) {
      const [, owner, repo] = qualifiedMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        return true;
      }
      continue;
    }

    const urlMatch = target.match(ISSUE_URL_PATTERN);
    if (urlMatch) {
      const [, owner, repo] = urlMatch;
      if (
        owner.toLowerCase() === normalizedOwner &&
        repo.toLowerCase() === normalizedRepo
      ) {
        return true;
      }
    }
  }

  return false;
}
