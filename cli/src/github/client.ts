import { execFile } from "child_process";
import { promisify } from "util";
import { CliError } from "../config/types.js";

const execFileAsync = promisify(execFile);

let ghToken: string | undefined;

/** Set the GitHub token used for all subsequent `gh` calls. */
export function setGhToken(token: string): void {
  ghToken = token;
}

export interface HeadersAndBody {
  headers: Record<string, string>;
  body: string;
}

export type GhHeadersResult = { notModified: true } | ({ notModified: false } & HeadersAndBody);

/**
 * Parse HTTP headers and body from `gh api -i` output.
 * The format is: status line, headers, blank line, body.
 */
export function parseHeadersAndBody(raw: string): HeadersAndBody {
  // Find the blank line separating headers from body (\r\n\r\n or \n\n)
  const crlfBlank = raw.indexOf("\r\n\r\n");
  const lfBlank = raw.indexOf("\n\n");

  let headerEnd: number;
  let bodyStart: number;

  if (crlfBlank !== -1 && (lfBlank === -1 || crlfBlank < lfBlank)) {
    headerEnd = crlfBlank;
    bodyStart = crlfBlank + 4;
  } else if (lfBlank !== -1) {
    headerEnd = lfBlank;
    bodyStart = lfBlank + 2;
  } else {
    return { headers: {}, body: raw };
  }

  const headerSection = raw.slice(0, headerEnd);
  const body = raw.slice(bodyStart).trim();

  const headers: Record<string, string> = {};
  const lines = headerSection.split(/\r?\n/);
  // Skip the HTTP status line (first line)
  for (const line of lines.slice(1)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (name) headers[name] = value;
    }
  }

  return { headers, body };
}

function makeEnvOpts(): { timeout: number; env?: NodeJS.ProcessEnv } {
  const opts: { timeout: number; env?: NodeJS.ProcessEnv } = { timeout: 30_000 };
  if (ghToken) opts.env = { ...process.env, GH_TOKEN: ghToken };
  return opts;
}

function handleGhError(err: unknown): never {
  const error = err as NodeJS.ErrnoException & {
    stderr?: string;
    code?: string | number;
  };

  if (error.code === "ENOENT") {
    throw new CliError(
      "gh CLI not found. Install: https://cli.github.com",
      "GH_NOT_FOUND",
      2,
    );
  }

  const stderr = error.stderr ?? error.message ?? "";

  if (/gh auth login|not logged in|authentication required/i.test(stderr)) {
    throw new CliError(
      "Not authenticated. Pass --github-token <token>, set GITHUB_TOKEN, or run: gh auth login",
      "GH_NOT_AUTHENTICATED",
      2,
    );
  }

  if (/rate.?limit|API rate limit/i.test(stderr)) {
    throw new CliError(
      "GitHub rate limited. Try again later.",
      "RATE_LIMITED",
      3,
    );
  }

  throw new CliError(stderr || "gh command failed", "GH_ERROR", 1);
}

/**
 * Execute a `gh` CLI command and return stdout.
 * All GitHub I/O goes through this single function.
 */
export async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, makeEnvOpts());
    return stdout.trim();
  } catch (err: unknown) {
    handleGhError(err);
  }
}

/**
 * Execute a `gh api -i` command and return parsed response headers and body.
 * Handles HTTP 304 (Not Modified) by returning `{ notModified: true }`.
 *
 * Use this for conditional GET requests where you pass If-Modified-Since.
 */
export async function ghWithHeaders(args: string[]): Promise<GhHeadersResult> {
  try {
    const { stdout } = await execFileAsync("gh", args, makeEnvOpts());
    return { notModified: false, ...parseHeadersAndBody(stdout) };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      stderr?: string;
      code?: string | number;
    };

    const stderr = error.stderr ?? error.message ?? "";

    // gh exits with code 1 and writes "gh: HTTP 304" to stderr for 304 responses
    if (/HTTP 304/.test(stderr)) {
      return { notModified: true };
    }

    handleGhError(err);
  }
}

/**
 * Fetch a paginated GitHub API endpoint and return all items as a flat array.
 *
 * Uses `--paginate --slurp` to collect all pages into an outer array, then
 * flattens them. Throws a typed CliError on parse failure or unexpected shape
 * rather than silently returning an empty list.
 */
export async function ghPaginatedList<T>(apiPath: string): Promise<T[]> {
  const raw = await gh(["api", "--paginate", "--slurp", apiPath]);

  let pages: unknown;
  try {
    pages = JSON.parse(raw);
  } catch {
    throw new CliError(
      `Failed to parse paginated response for ${apiPath}`,
      "GH_ERROR",
      1,
    );
  }

  if (!Array.isArray(pages)) {
    throw new CliError(
      `Unexpected non-array response from GitHub API: ${apiPath}`,
      "GH_ERROR",
      1,
    );
  }

  return (pages as T[][]).flat();
}
