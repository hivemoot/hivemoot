import { execFile } from "node:child_process";

type ExecOutput = {
  stdout: string;
  stderr: string;
};

type ExecError = Error & {
  stdout?: string;
  stderr?: string;
};

export interface PublishPreflightResult {
  command: "git push --dry-run origin HEAD";
  ok: boolean;
  originUrl?: string;
  error?: string;
}

function redactHttpCredentials(value: string): string {
  return value.replace(/(https?:\/\/)([^/\s@]+@)/gi, "$1");
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function execGit(args: string[]): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8" },
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

function describeExecError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const execErr = err as ExecError;
  const description = (
    trimText(execErr.stderr)
    ?? trimText(execErr.stdout)
    ?? trimText(execErr.message)
    ?? "unknown error"
  );
  return redactHttpCredentials(description);
}

export async function runPublishPreflight(): Promise<PublishPreflightResult> {
  const command = "git push --dry-run origin HEAD" as const;

  let originUrl: string | undefined;
  try {
    const { stdout } = await execGit(["remote", "get-url", "origin"]);
    const origin = trimText(stdout);
    originUrl = origin ? redactHttpCredentials(origin) : undefined;
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
