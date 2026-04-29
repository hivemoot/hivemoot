import { readFile } from "node:fs/promises";
import { CliError } from "../config/types.js";
import { hivemootPost } from "../hivemoot/client.js";
import {
  CONTRIBUTION_VERDICTS,
  RAW_MD_MAX_BYTES,
  ROOM_ID_REGEX,
  SUMMARY_MAX_CHARS,
} from "../hivemoot/types.js";
import type {
  ContributionBody,
  ContributionVerdict,
  SubmitContributionRequest,
  SubmitContributionResponse,
} from "../hivemoot/types.js";

export interface RoomsContributeOptions {
  sequence?: number;
  verdict?: string;
  summary?: string;
  bodyFile?: string;
  rawMd?: string;
  rawMdFile?: string;
  agentId?: string;
  token?: string;
  apiUrl?: string;
  json?: boolean;
}

function isContributionVerdict(v: unknown): v is ContributionVerdict {
  return typeof v === "string"
    && (CONTRIBUTION_VERDICTS as readonly string[]).includes(v);
}

/**
 * Parse a body JSON file into a `ContributionBody`. The CLI does
 * minimal pre-flight validation (verdict enum, summary present);
 * the server runs the full `validateContributionBody` (findings
 * shape, severity counts coherence, etc.) at submit time.
 */
async function loadBodyFromFile(path: string): Promise<ContributionBody> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new CliError(
      `Could not read --body-file ${JSON.stringify(path)}: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_OPTION",
      1,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      `--body-file ${JSON.stringify(path)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_OPTION",
      1,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      `--body-file must contain a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
      "INVALID_OPTION",
      1,
    );
  }
  const candidate = parsed as Partial<ContributionBody>;
  if (!isContributionVerdict(candidate.verdict)) {
    throw new CliError(
      `--body-file's "verdict" must be one of: ${CONTRIBUTION_VERDICTS.join(", ")}`,
      "INVALID_OPTION",
      1,
    );
  }
  if (typeof candidate.summary !== "string" || candidate.summary.length === 0) {
    throw new CliError(
      "--body-file's \"summary\" must be a non-empty string",
      "INVALID_OPTION",
      1,
    );
  }
  return candidate as ContributionBody;
}

async function readRawMd(options: RoomsContributeOptions): Promise<string> {
  if (options.rawMd !== undefined && options.rawMdFile !== undefined) {
    throw new CliError(
      "--raw-md and --raw-md-file are mutually exclusive",
      "INVALID_OPTION",
      1,
    );
  }
  if (options.rawMd !== undefined) {
    return options.rawMd;
  }
  if (options.rawMdFile !== undefined) {
    try {
      return await readFile(options.rawMdFile, "utf8");
    } catch (err) {
      throw new CliError(
        `Could not read --raw-md-file ${JSON.stringify(options.rawMdFile)}: ${err instanceof Error ? err.message : String(err)}`,
        "INVALID_OPTION",
        1,
      );
    }
  }
  throw new CliError(
    "Either --raw-md <text> or --raw-md-file <path> is required (the markdown body the queen synthesizes from)",
    "INVALID_OPTION",
    1,
  );
}

async function buildBody(options: RoomsContributeOptions): Promise<ContributionBody> {
  const hasFlags = options.verdict !== undefined || options.summary !== undefined;
  const hasFile = options.bodyFile !== undefined;
  if (hasFlags && hasFile) {
    throw new CliError(
      "(--verdict + --summary) and --body-file are mutually exclusive",
      "INVALID_OPTION",
      1,
    );
  }
  if (hasFile) {
    return loadBodyFromFile(options.bodyFile as string);
  }
  // Flag path: both --verdict and --summary required.
  if (options.verdict === undefined || options.summary === undefined) {
    throw new CliError(
      "Either --body-file <path> OR (--verdict <V> + --summary <text>) is required",
      "INVALID_OPTION",
      1,
    );
  }
  if (!isContributionVerdict(options.verdict)) {
    throw new CliError(
      `--verdict must be one of: ${CONTRIBUTION_VERDICTS.join(", ")}; got ${JSON.stringify(options.verdict)}`,
      "INVALID_OPTION",
      1,
    );
  }
  if (options.summary.length === 0 || options.summary.length > SUMMARY_MAX_CHARS) {
    throw new CliError(
      `--summary must be 1-${SUMMARY_MAX_CHARS} characters (got ${options.summary.length})`,
      "INVALID_OPTION",
      1,
    );
  }
  return { verdict: options.verdict, summary: options.summary };
}

export async function roomsContributeCommand(
  roomId: string,
  options: RoomsContributeOptions,
): Promise<void> {
  if (!ROOM_ID_REGEX.test(roomId)) {
    throw new CliError(
      `roomId must be a UUIDv4 (e.g. 8d2bbb86-1f33-4d6a-9b3a-3ed1c0fbcdef); got ${JSON.stringify(roomId)}`,
      "INVALID_OPTION",
      1,
    );
  }
  if (options.sequence === undefined) {
    throw new CliError(
      "--sequence <N> is required (the room sequence the worker last observed; ROOM_OPEN_BLOCKED if stale)",
      "INVALID_OPTION",
      1,
    );
  }
  if (options.sequence < 0) {
    throw new CliError(
      "--sequence must be a non-negative integer",
      "INVALID_OPTION",
      1,
    );
  }

  const body = await buildBody(options);
  const rawMd = await readRawMd(options);

  // Match the server's `RoomContributionTooLargeError` cap so the
  // operator sees an actionable local error rather than a 400 race.
  // Byte-length on the UTF-8 encoded form to mirror the storage path.
  const rawMdBytes = Buffer.byteLength(rawMd, "utf8");
  if (rawMdBytes > RAW_MD_MAX_BYTES) {
    throw new CliError(
      `--raw-md content is ${rawMdBytes} bytes; server cap is ${RAW_MD_MAX_BYTES} bytes (32 KiB UTF-8)`,
      "INVALID_OPTION",
      1,
    );
  }

  const requestBody: SubmitContributionRequest = {
    sequenceObservedByClient: options.sequence,
    body,
    rawMd,
  };
  if (options.agentId !== undefined && options.agentId.length > 0) {
    requestBody.agentId = options.agentId;
  }

  const result = await hivemootPost<
    SubmitContributionRequest,
    SubmitContributionResponse
  >({
    apiUrl: options.apiUrl,
    token: options.token,
    path: `/api/rooms/${roomId}/contributions`,
    body: requestBody,
  });

  if (options.json) {
    console.log(JSON.stringify({ roomId, ...result }, null, 2));
  } else {
    console.log(
      `WAR ROOM CONTRIBUTION accepted — room ${roomId}, sequence ${result.sequence}, verdict ${body.verdict}`,
    );
  }
}
