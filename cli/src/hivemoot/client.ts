/**
 * HTTP client for the hivemoot.dev war-room API.
 *
 * Auth: bearer token resolved from (in order) the `--token` flag,
 * the `HIVEMOOT_API_TOKEN` env var, or a `CliError` if neither is
 * supplied. Tokens are V1 capability bearers minted by the apiarist
 * — operators with `rooms.read_all` can list/inspect any room in
 * their installation; workers carry narrower scopes used by the
 * agent-runtime plugin (which has its own client in
 * `agent/cli/.../war_rooms/api.py`).
 *
 * Base URL: `--api-url`, then `HIVEMOOT_API_URL`, then production
 * (`https://www.hivemoot.dev`). Override is mostly useful for
 * staging / preview deploys / local `next dev`.
 *
 * Failure modes mapped to `CliError` so the existing global error
 * handler in `cli/src/index.ts` renders them consistently:
 *   - missing token → exit 2 (actionable: "set the env var")
 *   - 401 → exit 2 (actionable: "your token is wrong/expired")
 *   - 4xx with parseable body → exit 3, code from server's `code`
 *   - 5xx / network / parse failures → exit 3, generic
 */

import { CliError } from "../config/types.js";

export const DEFAULT_API_URL = "https://www.hivemoot.dev";

export interface HivemootClientOptions {
  /** Override base URL. Falls back to env, then production default. */
  apiUrl?: string;
  /** Bearer token. Falls back to `HIVEMOOT_API_TOKEN` env var. */
  token?: string;
}

export function resolveApiUrl(opts: HivemootClientOptions): string {
  const flag = opts.apiUrl?.trim();
  if (flag && flag.length > 0) return flag;
  const env = process.env.HIVEMOOT_API_URL?.trim();
  if (env && env.length > 0) return env;
  return DEFAULT_API_URL;
}

export function resolveToken(opts: HivemootClientOptions): string {
  const flag = opts.token?.trim();
  if (flag && flag.length > 0) return flag;
  const env = process.env.HIVEMOOT_API_TOKEN?.trim();
  if (env && env.length > 0) return env;
  throw new CliError(
    "No hivemoot API token. Set HIVEMOOT_API_TOKEN env var or pass --token <bearer>.",
    "AUTH_ERROR",
    2,
  );
}

export interface HivemootGetArgs extends HivemootClientOptions {
  /** Path relative to base URL — must start with `/`. */
  path: string;
  /** Optional querystring parameters. `undefined` / `null` values
   * are skipped so callers can pass `{ status: opts.status }` without
   * branching. */
  query?: Record<string, string | number | undefined | null>;
  /** Optional fetch override (testing). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export async function hivemootGet<T>(args: HivemootGetArgs): Promise<T> {
  const baseUrl = resolveApiUrl(args);
  const token = resolveToken(args);
  const fetchFn = args.fetchImpl ?? fetch;

  const url = new URL(args.path, baseUrl);
  if (args.query) {
    for (const [k, v] of Object.entries(args.query)) {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new CliError(
      `Network error reaching ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      "NETWORK_ERROR",
      3,
    );
  }

  if (response.ok) {
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new CliError(
        `Invalid JSON response from ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`,
        "PARSE_ERROR",
        3,
      );
    }
  }

  // Try to extract the server's structured error envelope
  // (`{ code, message }`) — both 4xx and 5xx routes use it.
  let serverCode: string | undefined;
  let serverMessage: string | undefined;
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") serverCode = body.code;
    if (typeof body.message === "string") serverMessage = body.message;
  } catch {
    // Non-JSON body (e.g., plain "Unauthorized" or empty 401) — fall
    // through to the generic message below.
  }

  const summary = serverMessage ?? response.statusText ?? "request failed";
  // 401 is "fix your token" → exit 2; everything else is exit 3.
  const exitCode = response.status === 401 ? 2 : 3;
  throw new CliError(
    `${response.status} ${summary} (${url.pathname})`,
    serverCode ?? `HTTP_${response.status}`,
    exitCode,
  );
}
