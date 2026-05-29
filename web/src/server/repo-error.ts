/**
 * Error codes and response builder for the Repos API.
 *
 * Mirrors the agent-health-error.ts pattern — a const object of namespaced
 * error codes, a derived union type, and a helper that returns NextResponse.json().
 */

import { NextResponse } from "next/server";

export const REPO_ERROR = {
  INVALID_PATH: "repo_invalid_path",
  INVALID_BODY: "repo_invalid_body",
  INVALID_ROLE_NAME: "repo_invalid_role_name",
  INVALID_DESCRIPTION: "repo_invalid_description",
  INVALID_INSTRUCTIONS: "repo_invalid_instructions",
  INVALID_FILE_SHA: "repo_invalid_file_sha",
  SERVER_MISCONFIGURATION: "repo_server_misconfiguration",
  CONFIG_NOT_FOUND: "repo_config_not_found",
  CONFIG_PARSE_ERROR: "repo_config_parse_error",
  ROLE_NOT_FOUND: "repo_role_not_found",
  CONFLICT: "repo_conflict",
  SERVER_ERROR: "repo_server_error",
} as const;

export type RepoErrorCode = (typeof REPO_ERROR)[keyof typeof REPO_ERROR];

export function repoError(
  code: RepoErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      code,
      message,
      ...(details ?? {}),
    },
    { status },
  );
}
