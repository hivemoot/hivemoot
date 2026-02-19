import { execFile } from "node:child_process";

type ExecOutput = {
  stdout: string;
  stderr: string;
};

type ExecError = Error & {
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

const GIT_EXEC_TIMEOUT_MS = 15_000;

export interface PublishPreflightResult {
  command: "git push --dry-run origin HEAD";
  ok: boolean;
  originUrl?: string;
  error?: string;
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function redactHttpUrlCredentials(urlText: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return urlText;
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || (!parsed.username && !parsed.password)) {
    return urlText;
  }

  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function sanitizeHttpUrlsInText(value: string): string {
  return value.replace(/https?:\/\/[^\s'"]+/gi, (candidate) => redactHttpUrlCredentials(candidate));
}

function execGit(args: string[]): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        encoding: "utf8",
        timeout: GIT_EXEC_TIMEOUT_MS,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as ExecError;
          enriched.stdout = stdout;
          enriched.stderr = stderr;
          reject(enriched);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isPromptDisabledError(value: string | undefined): boolean {
  return typeof value === "string" && /terminal prompts disabled/i.test(value);
}

function isTimeoutError(err: ExecError): boolean {
  return err.killed === true || (typeof err.message === "string" && /timed out/i.test(err.message));
}

function describeExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const execErr = err as ExecError;
  const detail = (
    trimText(execErr.stderr)
    ?? trimText(execErr.stdout)
    ?? trimText(execErr.message)
  );
  if (!detail) return "unknown error";
  const sanitized = sanitizeHttpUrlsInText(detail);
  if (isTimeoutError(execErr)) {
    return `git command timed out after ${GIT_EXEC_TIMEOUT_MS}ms`;
  }
  if (isPromptDisabledError(detail)) {
    return `git authentication prompt blocked (GIT_TERMINAL_PROMPT=0): ${sanitized}`;
  }
  return sanitized;
}

export async function runPublishPreflight(): Promise<PublishPreflightResult> {
  const command = "git push --dry-run origin HEAD" as const;

  let originUrl: string | undefined;
  try {
    const { stdout } = await execGit(["remote", "get-url", "origin"]);
    const rawOriginUrl = trimText(stdout);
    originUrl = rawOriginUrl ? sanitizeHttpUrlsInText(rawOriginUrl) : undefined;
  } catch (err) {
    return {
      command,
      ok: false,
      error: `could not resolve git origin remote: ${describeExecError(err)}`,
    };
  }

  try {
    await execGit(["push", "--dry-run", "origin", "HEAD"]);
    return { command, ok: true, originUrl };
  } catch (err) {
    return {
      command,
      ok: false,
      originUrl,
      error: describeExecError(err),
    };
  }
}
