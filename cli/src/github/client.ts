import { execFile } from "child_process";
import { promisify } from "util";
import { CliError } from "../config/types.js";

const execFileAsync = promisify(execFile);

let ghToken: string | undefined;

/** Set the GitHub token used for all subsequent `gh` calls. */
export function setGhToken(token: string): void {
  ghToken = token;
}

/**
 * Execute a `gh` CLI command and return stdout.
 * All GitHub I/O goes through this single function.
 */
export async function gh(args: string[]): Promise<string> {
  try {
    const opts: { timeout: number; env?: NodeJS.ProcessEnv } = {
      timeout: 30_000,
    };
    if (ghToken) {
      opts.env = { ...process.env, GH_TOKEN: ghToken };
    }
    const { stdout } = await execFileAsync("gh", args, opts);
    return stdout.trim();
  } catch (err: unknown) {
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
}
