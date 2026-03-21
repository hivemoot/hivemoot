/**
 * Per-Repository Configuration Loader
 *
 * Loads governance configuration from .github/hivemoot.yml in customer repositories.
 * Provides per-repo customization while maintaining safe boundaries.
 *
 * Config hierarchy (lowest to highest priority):
 * 1. Global defaults (env-derived, clamped to CONFIG_BOUNDS)
 * 2. Per-repo .github/hivemoot.yml
 */

import * as yaml from "js-yaml";
import {
  CONFIG_BOUNDS,
  MAX_PRS_PER_ISSUE,
  PR_STALE_THRESHOLD_DAYS,
} from "../config.js";
import { getErrorStatus } from "./github-client.js";
import { logger } from "./logger.js";

// ───────────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────────

export interface RequiredVotersConfig {
  minCount: number;
  voters: string[];
}

export type ExitRequires = "majority" | "unanimous";
export type ExitType = "manual" | "auto";

// ── Intake Method Types ─────────────────────────────────────────────────────

interface IntakeMethodUpdate {
  method: "update";
}

interface IntakeMethodApproval {
  method: "approval";
  minApprovals: number;
}

interface IntakeMethodAuto {
  method: "auto";
}

export type IntakeMethod = IntakeMethodUpdate | IntakeMethodApproval | IntakeMethodAuto;

// ── Merge-Ready Config ──────────────────────────────────────────────────

export interface MergeReadyConfig {
  minApprovals: number;
}

// ── Automerge Config ────────────────────────────────────────────────────

export type MergeMethod = "squash" | "merge" | "rebase";

export interface AutomergeConfig {
  dryRun: boolean;
  allowedPaths: string[];
  denyPaths: string[];
  maxFiles: number;
  maxChangedLines: number;
  minApprovals: number;
  requireChecks: boolean;
  /** Merge method used when enabling GitHub native auto-merge. Default: "squash". */
  mergeMethod: MergeMethod;
  /**
   * Custom commit headline for the auto-merge commit.
   * Only applies to SQUASH and MERGE methods; ignored for REBASE.
   * When absent, GitHub uses its default (PR title for squash, standard merge message for merge).
   */
  commitHeadline?: string;
  /**
   * Custom commit body for the auto-merge commit.
   * Only applies to SQUASH and MERGE methods; ignored for REBASE.
   * When absent, GitHub uses its default.
   */
  commitBody?: string;
}

// ── Standup Config ──────────────────────────────────────────────────────

export interface StandupConfig {
  enabled: boolean;
  category: string;
}

// ── Auto-Gather Config ──────────────────────────────────────────────────

export interface AutoGatherConfig {
  enabled: boolean;
  minNewComments: number;
  cooldownMinutes: number;
}

export interface VotingAutoExit {
  type: "auto";
  afterMs: number;
  requires: ExitRequires;
  minVoters: number;
  requiredVoters: RequiredVotersConfig;
}

export interface VotingManualExit {
  type: "manual";
}

export type VotingExit = VotingAutoExit | VotingManualExit;

export interface RequiredReadyConfig {
  minCount: number;
  users: string[];
}

export interface DiscussionAutoExit {
  type: "auto";
  afterMs: number;
  minReady: number;
  requiredReady: RequiredReadyConfig;
}

export interface DiscussionManualExit {
  type: "manual";
}

export type DiscussionExit = DiscussionAutoExit | DiscussionManualExit;

export function isAutoVotingExit(exit: VotingExit): exit is VotingAutoExit {
  return exit.type === "auto";
}

export function isAutoDiscussionExit(exit: DiscussionExit): exit is DiscussionAutoExit {
  return exit.type === "auto";
}

/**
 * Schema for .github/hivemoot.yml config file.
 */
export interface RepoConfigFile {
  version?: number;
  governance?: {
    proposals?: {
      discussion?: {
        exits?: unknown[];
        autoGather?: {
          enabled?: boolean;
          minNewComments?: number;
          cooldownMinutes?: number;
        };
      };
      voting?: {
        exits?: unknown[];
      };
      extendedVoting?: {
        exits?: unknown[];
      };
    };
    pr?: {
      staleDays?: number;
      maxPRsPerIssue?: number;
      trustedReviewers?: unknown;
      intake?: unknown;
      mergeReady?: unknown;
      automerge?: unknown;
    };
  };
  standup?: {
    enabled?: boolean;
    category?: string;
  };
}

/**
 * PR workflow configuration when explicitly enabled.
 * Present only when the `pr:` section exists in the config file.
 */
export interface PRConfig {
  /** Null unless `governance.pr.staleDays` is explicitly present in YAML. */
  staleDays: number | null;
  maxPRsPerIssue: number;
  trustedReviewers: string[];
  intake: IntakeMethod[];
  mergeReady: MergeReadyConfig | null;
  automerge: AutomergeConfig | null;
}

/**
 * Effective configuration after merging repo config with defaults.
 * All values are guaranteed to be within safe boundaries.
 */
export interface EffectiveConfig {
  version: number;
  governance: {
    proposals: {
      discussion: {
        exits: DiscussionExit[];
        /** Derived from the last auto exit's afterMs (0 when manual-only). */
        durationMs: number;
        autoGather: AutoGatherConfig;
      };
      voting: {
        exits: VotingExit[];
        /** Derived from the last auto exit's afterMs (0 when manual-only). */
        durationMs: number;
      };
      extendedVoting: {
        exits: VotingExit[];
        /** Derived from the last auto exit's afterMs (0 when manual-only). */
        durationMs: number;
      };
    };
    /** null when `pr:` section is absent — all PR workflows disabled. */
    pr: PRConfig | null;
  };
  standup: StandupConfig;
}

/**
 * Minimal GitHub client interface for fetching repo content.
 * Compatible with both Octokit and Probot's context.octokit.
 *
 * The getContent API returns different shapes depending on the path:
 * - Single file: { type: "file", content: "...", ... }
 * - Directory: array of items
 * - Symlink/submodule: different structures
 *
 * We use `unknown` for the response data and handle the shape at runtime.
 */
export interface RepoConfigClient {
  rest: {
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
      }) => Promise<{
        data: unknown;
      }>;
    };
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Config Loading
// ───────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = ".github/hivemoot.yml";
const MS_PER_MINUTE = 60 * 1000;
const PR_STALE_DAYS_BOUNDS = {
  ...CONFIG_BOUNDS.prStaleDays,
  default: PR_STALE_THRESHOLD_DAYS,
};

const MAX_PRS_PER_ISSUE_BOUNDS = {
  ...CONFIG_BOUNDS.maxPRsPerIssue,
  default: MAX_PRS_PER_ISSUE,
};

const MIN_VOTERS_BOUNDS = {
  ...CONFIG_BOUNDS.voting.minVoters,
};

// minReady shares the same bounds as minVoters (0..50, default 0)
const MIN_READY_BOUNDS = {
  ...CONFIG_BOUNDS.voting.minVoters,
  default: 0,
};

/**
 * Clamp a value to the specified bounds.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate and clamp an integer value from config.
 * Returns the clamped value, or default if invalid.
 */
function parseIntValue(
  value: unknown,
  bounds: { min: number; max: number; default: number },
  fieldName: string,
  repoFullName: string
): number {
  if (value === undefined || value === null) {
    return bounds.default;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    logger.warn(
      `[${repoFullName}] Invalid ${fieldName}: expected number, got ${typeof value}. Using default.`
    );
    return bounds.default;
  }

  // Round to integer for non-integer inputs
  const intValue = Math.round(value);
  const clamped = clamp(intValue, bounds.min, bounds.max);

  if (clamped !== value) {
    logger.info(
      `[${repoFullName}] ${fieldName} clamped from ${value} to ${clamped} (bounds: ${bounds.min}-${bounds.max})`
    );
  }

  return clamped;
}

function hasOwnConfigKey(value: unknown, key: string): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Parse and validate a voters array from config.
 * Returns a deduplicated, lowercased array clamped to maxEntries/maxUsernameLength.
 */
function parseVotersList(
  value: unknown,
  repoFullName: string,
  fieldName: string = "requiredVoters"
): string[] {
  if (!Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      logger.warn(
        `[${repoFullName}] Invalid ${fieldName}.voters: expected array. Using default (empty).`
      );
    }
    return [];
  }

  const { maxEntries, maxUsernameLength } = CONFIG_BOUNDS.requiredVoters;

  const result: string[] = [];
  const seen = new Set<string>();
  const isValidGitHubUsername = (name: string): boolean =>
    /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(name);

  for (const entry of value) {
    if (result.length >= maxEntries) {
      logger.info(
        `[${repoFullName}] ${fieldName} truncated to ${maxEntries} entries`
      );
      break;
    }

    if (typeof entry !== "string" || entry.length === 0) {
      logger.warn(
        `[${repoFullName}] Invalid ${fieldName} entry: expected non-empty string, got ${typeof entry}. Skipping.`
      );
      continue;
    }

    // Strip whitespace and optional leading @ (common in GitHub config contexts)
    const cleaned = entry.trim().replace(/^@/, "");
    if (cleaned.length === 0) {
      logger.warn(
        `[${repoFullName}] Empty ${fieldName} entry after trimming: "${entry}". Skipping.`
      );
      continue;
    }

    if (cleaned.length > maxUsernameLength) {
      logger.warn(
        `[${repoFullName}] Invalid ${fieldName} entry '${cleaned}': exceeds max length ${maxUsernameLength}. Skipping.`
      );
      continue;
    }

    const normalized = cleaned.toLowerCase();
    if (!isValidGitHubUsername(normalized)) {
      logger.warn(
        `[${repoFullName}] Invalid ${fieldName} entry '${cleaned}': not a valid GitHub username. Skipping.`
      );
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Parse and validate requiredVoters from config.
 *
 * Accepts either:
 * - Array shorthand: ["alice", "bob"] → { mode: "all", voters: [...] }
 * - Object format: { mode: "any", voters: ["alice"] }
 */
function parseRequiredVotersConfig(
  value: unknown,
  repoFullName: string
): RequiredVotersConfig {
  if (value === undefined || value === null) {
    return { minCount: 0, voters: [] };
  }

  // Array shorthand → all required (minCount = list length)
  if (Array.isArray(value)) {
    const voters = parseVotersList(value, repoFullName);
    return { minCount: voters.length, voters };
  }

  if (typeof value !== "object") {
    logger.warn(
      `[${repoFullName}] Invalid requiredVoters: expected object or array. Using default.`
    );
    return { minCount: 0, voters: [] };
  }

  const obj = value as { mode?: unknown; minCount?: unknown; voters?: unknown };
  const voters = parseVotersList(obj.voters, repoFullName);

  // Resolve minCount: prefer explicit minCount, fall back to mode for backward compat
  let minCount: number;
  if (obj.minCount !== undefined && obj.minCount !== null) {
    if (typeof obj.minCount === "number" && Number.isFinite(obj.minCount)) {
      minCount = Math.round(obj.minCount);
    } else {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters.minCount: expected number. Using list length.`
      );
      minCount = voters.length;
    }
  } else if (obj.mode !== undefined && obj.mode !== null) {
    // Backward compat: convert mode to minCount
    if (obj.mode === "any") {
      minCount = 1;
    } else if (obj.mode === "all") {
      minCount = voters.length;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid requiredVoters.mode: "${String(obj.mode)}". Defaulting to all.`
      );
      minCount = voters.length;
    }
  } else {
    // Neither minCount nor mode specified: default to all
    minCount = voters.length;
  }

  // Clamp to valid range
  minCount = clamp(minCount, 0, voters.length);

  return { minCount, voters };
}

const VALID_REQUIRES: ExitRequires[] = ["majority", "unanimous"];
const DEFAULT_MANUAL_VOTING_EXIT: VotingManualExit = { type: "manual" };
const DEFAULT_MANUAL_DISCUSSION_EXIT: DiscussionManualExit = { type: "manual" };

function parseExitType(entry: Record<string, unknown>, fieldPath: string, repoFullName: string): ExitType | null {
  const type = entry.type;
  if (type !== "manual" && type !== "auto") {
    logger.warn(
      `[${repoFullName}] Invalid ${fieldPath}.type: expected "manual" or "auto". Skipping.`
    );
    return null;
  }
  return type;
}

/**
 * Parse and validate voting exits from config.
 *
 * Two modes are supported:
 * - manual: no automatic progression for the phase
 * - auto: time-based progression with voting requirements
 *
 * Mixed manual+auto exits are treated as configuration errors and resolve to
 * manual for safety (avoid unexpected automation).
 */
function parseExits(
  value: unknown,
  repoFullName: string,
): VotingExit[] {
  const defaultMinVoters = CONFIG_BOUNDS.voting.minVoters.default;
  const defaultRequiredVoters: RequiredVotersConfig = { minCount: 0, voters: [] };
  const manualDefault: VotingExit[] = [DEFAULT_MANUAL_VOTING_EXIT];

  if (value === undefined || value === null) {
    return manualDefault;
  }

  if (!Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid voting exits: expected array. Using manual exit.`
    );
    return manualDefault;
  }

  if (value.length === 0) {
    logger.warn(
      `[${repoFullName}] Empty voting exits array. Using manual exit.`
    );
    return manualDefault;
  }

  const bounds = CONFIG_BOUNDS.phaseDurationMinutes;
  const exits: VotingExit[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      logger.warn(`[${repoFullName}] Invalid voting exit entry: expected object. Skipping.`);
      continue;
    }

    const exitType = parseExitType(entry, "voting exit", repoFullName);
    if (!exitType) {
      continue;
    }

    if (exitType === "manual") {
      exits.push(DEFAULT_MANUAL_VOTING_EXIT);
      continue;
    }

    // Parse afterMinutes for auto exits (required)
    const afterMinutesRaw = entry.afterMinutes;
    if (typeof afterMinutesRaw !== "number" || !Number.isFinite(afterMinutesRaw)) {
      logger.warn(
        `[${repoFullName}] Invalid voting exit afterMinutes: expected number for type:auto. Skipping.`
      );
      continue;
    }
    const clamped = clamp(afterMinutesRaw, bounds.min, bounds.max);
    if (clamped !== afterMinutesRaw) {
      logger.info(
        `[${repoFullName}] voting exit afterMinutes clamped from ${afterMinutesRaw} to ${clamped}`
      );
    }
    const afterMs = clamped * MS_PER_MINUTE;

    // Parse requires
    let requires: ExitRequires = "majority";
    if (entry.requires !== undefined && entry.requires !== null) {
      if (VALID_REQUIRES.includes(entry.requires as ExitRequires)) {
        requires = entry.requires as ExitRequires;
      } else {
        logger.warn(
          `[${repoFullName}] Invalid voting exit requires: "${String(entry.requires)}". Using default ("majority").`
        );
      }
    }

    // Parse minVoters (falls back to CONFIG_BOUNDS default)
    const minVoters = (entry.minVoters !== undefined && entry.minVoters !== null)
      ? parseIntValue(entry.minVoters, MIN_VOTERS_BOUNDS, "voting exit.minVoters", repoFullName)
      : defaultMinVoters;

    // Parse requiredVoters (falls back to empty)
    const requiredVoters = (entry.requiredVoters !== undefined && entry.requiredVoters !== null)
      ? parseRequiredVotersConfig(entry.requiredVoters, repoFullName)
      : defaultRequiredVoters;

    exits.push({
      type: "auto",
      afterMs,
      requires,
      minVoters,
      requiredVoters,
    });
  }

  if (exits.length === 0) {
    logger.warn(
      `[${repoFullName}] All voting exit entries were invalid. Using manual exit.`
    );
    return manualDefault;
  }

  const hasManual = exits.some((exit) => exit.type === "manual");
  const hasAuto = exits.some((exit) => exit.type === "auto");
  if (hasManual && hasAuto) {
    logger.warn(
      `[${repoFullName}] Mixed manual and auto voting exits are not allowed. Using manual exit.`
    );
    return manualDefault;
  }

  if (hasManual) {
    if (exits.length > 1) {
      logger.info(
        `[${repoFullName}] Multiple manual voting exits configured. Collapsing to a single manual exit.`
      );
    }
    return manualDefault;
  }

  // Sort auto exits ascending by afterMs
  const autoExits = exits.filter(isAutoVotingExit);
  autoExits.sort((a, b) => a.afterMs - b.afterMs);
  return autoExits;
}

/**
 * Parse and validate requiredReady from config.
 *
 * Accepts either:
 * - Array shorthand: ["alice", "bob"] → { mode: "all", users: [...] }
 * - Object format: { mode: "any", users: ["alice"] }
 *
 * Reuses parseVotersList for username validation.
 */
function parseRequiredReadyConfig(
  value: unknown,
  repoFullName: string
): RequiredReadyConfig {
  if (value === undefined || value === null) {
    return { minCount: 0, users: [] };
  }

  // Array shorthand → all required (minCount = list length)
  if (Array.isArray(value)) {
    const users = parseVotersList(value, repoFullName, "requiredReady");
    return { minCount: users.length, users };
  }

  if (typeof value !== "object") {
    logger.warn(
      `[${repoFullName}] Invalid requiredReady: expected object or array. Using default.`
    );
    return { minCount: 0, users: [] };
  }

  const obj = value as { mode?: unknown; minCount?: unknown; users?: unknown };
  const users = parseVotersList(obj.users, repoFullName, "requiredReady");

  // Resolve minCount: prefer explicit minCount, fall back to mode for backward compat
  let minCount: number;
  if (obj.minCount !== undefined && obj.minCount !== null) {
    if (typeof obj.minCount === "number" && Number.isFinite(obj.minCount)) {
      minCount = Math.round(obj.minCount);
    } else {
      logger.warn(
        `[${repoFullName}] Invalid requiredReady.minCount: expected number. Using list length.`
      );
      minCount = users.length;
    }
  } else if (obj.mode !== undefined && obj.mode !== null) {
    // Backward compat: convert mode to minCount
    if (obj.mode === "any") {
      minCount = 1;
    } else if (obj.mode === "all") {
      minCount = users.length;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid requiredReady.mode: "${String(obj.mode)}". Defaulting to all.`
      );
      minCount = users.length;
    }
  } else {
    // Neither minCount nor mode specified: default to all
    minCount = users.length;
  }

  // Clamp to valid range
  minCount = clamp(minCount, 0, users.length);

  return { minCount, users };
}

/**
 * Parse and validate discussion exits from config.
 *
 * Two modes are supported:
 * - manual: no automatic progression for the phase
 * - auto: time-based progression with readiness requirements
 *
 * Mixed manual+auto exits are treated as configuration errors and resolve to
 * manual for safety (avoid unexpected automation).
 */
function parseDiscussionExits(
  value: unknown,
  repoFullName: string,
): DiscussionExit[] {
  const defaultRequiredReady: RequiredReadyConfig = { minCount: 0, users: [] };
  const manualDefault: DiscussionExit[] = [DEFAULT_MANUAL_DISCUSSION_EXIT];

  if (value === undefined || value === null) {
    return manualDefault;
  }

  if (!Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid discussion exits: expected array. Using manual exit.`
    );
    return manualDefault;
  }

  if (value.length === 0) {
    logger.warn(
      `[${repoFullName}] Empty discussion exits array. Using manual exit.`
    );
    return manualDefault;
  }

  const bounds = CONFIG_BOUNDS.phaseDurationMinutes;
  const exits: DiscussionExit[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      logger.warn(`[${repoFullName}] Invalid discussion exit entry: expected object. Skipping.`);
      continue;
    }

    const exitType = parseExitType(entry, "discussion exit", repoFullName);
    if (!exitType) {
      continue;
    }

    if (exitType === "manual") {
      exits.push(DEFAULT_MANUAL_DISCUSSION_EXIT);
      continue;
    }

    // Parse afterMinutes for auto exits (required)
    const afterMinutesRaw = entry.afterMinutes;
    if (typeof afterMinutesRaw !== "number" || !Number.isFinite(afterMinutesRaw)) {
      logger.warn(
        `[${repoFullName}] Invalid discussion exit afterMinutes: expected number for type:auto. Skipping.`
      );
      continue;
    }

    const clamped = clamp(afterMinutesRaw, bounds.min, bounds.max);
    if (clamped !== afterMinutesRaw) {
      logger.info(
        `[${repoFullName}] discussion exit afterMinutes clamped from ${afterMinutesRaw} to ${clamped}`
      );
    }
    const afterMs = clamped * MS_PER_MINUTE;

    // Parse minReady (default 0)
    const minReady = (entry.minReady !== undefined && entry.minReady !== null)
      ? parseIntValue(entry.minReady, MIN_READY_BOUNDS, "discussion exit.minReady", repoFullName)
      : 0;

    // Parse requiredReady (default empty)
    const requiredReady = (entry.requiredReady !== undefined && entry.requiredReady !== null)
      ? parseRequiredReadyConfig(entry.requiredReady, repoFullName)
      : defaultRequiredReady;

    exits.push({
      type: "auto",
      afterMs,
      minReady,
      requiredReady,
    });
  }

  if (exits.length === 0) {
    logger.warn(
      `[${repoFullName}] All discussion exit entries were invalid. Using manual exit.`
    );
    return manualDefault;
  }

  const hasManual = exits.some((exit) => exit.type === "manual");
  const hasAuto = exits.some((exit) => exit.type === "auto");
  if (hasManual && hasAuto) {
    logger.warn(
      `[${repoFullName}] Mixed manual and auto discussion exits are not allowed. Using manual exit.`
    );
    return manualDefault;
  }

  if (hasManual) {
    if (exits.length > 1) {
      logger.info(
        `[${repoFullName}] Multiple manual discussion exits configured. Collapsing to a single manual exit.`
      );
    }
    return manualDefault;
  }

  // Sort auto exits ascending by afterMs
  const autoExits = exits.filter(isAutoDiscussionExit);
  autoExits.sort((a, b) => a.afterMs - b.afterMs);
  return autoExits;
}

const DEFAULT_INTAKE: IntakeMethod[] = [{ method: "auto" }];
const VALID_INTAKE_METHODS = new Set(["update", "approval", "auto"]);

/**
 * Parse and validate trustedReviewers from config.
 * Reuses parseVotersList for username validation.
 */
function parseTrustedReviewers(
  value: unknown,
  repoFullName: string
): string[] {
  return parseVotersList(value, repoFullName, "trustedReviewers");
}

/**
 * Parse and validate intake methods from config.
 *
 * Each entry must have a known `method` field. Method-specific options
 * are validated per method. Invalid entries are filtered with warnings.
 * If the result is empty, falls back to default [{ method: "auto" }].
 */
function parseIntakeMethods(
  value: unknown,
  trustedReviewers: string[],
  repoFullName: string
): IntakeMethod[] {
  if (value === undefined || value === null) {
    return DEFAULT_INTAKE;
  }

  if (!Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid intake: expected array. Using default.`
    );
    return DEFAULT_INTAKE;
  }

  if (value.length === 0) {
    logger.warn(
      `[${repoFullName}] Empty intake array. Using default.`
    );
    return DEFAULT_INTAKE;
  }

  const methods: IntakeMethod[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      logger.warn(`[${repoFullName}] Invalid intake entry: expected object. Skipping.`);
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const method = obj.method;

    if (typeof method !== "string" || !VALID_INTAKE_METHODS.has(method)) {
      logger.warn(
        `[${repoFullName}] Unknown intake method: "${String(method)}". Skipping.`
      );
      continue;
    }

    if (method === "update") {
      methods.push({ method: "update" });
      continue;
    }

    if (method === "auto") {
      methods.push({ method: "auto" });
      continue;
    }

    if (method === "approval") {
      if (trustedReviewers.length === 0) {
        logger.warn(
          `[${repoFullName}] intake method "approval" configured but trustedReviewers is empty. ` +
          `This method will never match. Skipping.`
        );
        continue;
      }

      // Parse minApprovals: required field, defaults to 1
      let minApprovals: number;
      if (obj.minApprovals === undefined || obj.minApprovals === null) {
        minApprovals = 1;
      } else if (typeof obj.minApprovals !== "number" || !Number.isFinite(obj.minApprovals)) {
        logger.warn(
          `[${repoFullName}] Invalid intake approval.minApprovals: expected number. Using 1.`
        );
        minApprovals = 1;
      } else {
        minApprovals = Math.round(obj.minApprovals);
      }

      // Clamp to [1, trustedReviewers.length]
      minApprovals = clamp(minApprovals, 1, trustedReviewers.length);

      methods.push({ method: "approval", minApprovals });
    }
  }

  if (methods.length === 0) {
    logger.warn(
      `[${repoFullName}] All intake entries were invalid. Using default.`
    );
    return DEFAULT_INTAKE;
  }

  return methods;
}

/**
 * Parse and validate mergeReady config from the pr section.
 *
 * Returns null (feature disabled) when:
 * - mergeReady is absent, null, or undefined
 * - trustedReviewers is empty (can't satisfy approval requirement)
 * - mergeReady is not a valid object
 *
 * When present, minApprovals is clamped to [1, trustedReviewers.length].
 */
function parseMergeReadyConfig(
  value: unknown,
  trustedReviewers: string[],
  repoFullName: string
): MergeReadyConfig | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid mergeReady: expected object. Disabling feature.`
    );
    return null;
  }

  if (trustedReviewers.length === 0) {
    logger.warn(
      `[${repoFullName}] mergeReady configured but trustedReviewers is empty. ` +
      `Cannot satisfy approval requirement. Disabling feature.`
    );
    return null;
  }

  const obj = value as { minApprovals?: unknown };

  let minApprovals: number;
  if (obj.minApprovals === undefined || obj.minApprovals === null) {
    minApprovals = CONFIG_BOUNDS.mergeReady.minApprovals.default;
  } else if (typeof obj.minApprovals !== "number" || !Number.isFinite(obj.minApprovals)) {
    logger.warn(
      `[${repoFullName}] Invalid mergeReady.minApprovals: expected number. Using default (1).`
    );
    minApprovals = CONFIG_BOUNDS.mergeReady.minApprovals.default;
  } else {
    minApprovals = Math.round(obj.minApprovals);
  }

  // Clamp to [1, trustedReviewers.length]
  minApprovals = clamp(
    minApprovals,
    CONFIG_BOUNDS.mergeReady.minApprovals.min,
    Math.min(CONFIG_BOUNDS.mergeReady.minApprovals.max, trustedReviewers.length)
  );

  return { minApprovals };
}

/**
 * Parse and validate auto-gather config.
 * Opt-in feature — disabled by default.
 * When enabled, auto-gather triggers on discussion-phase issues after N new comments.
 */
function parseAutoGatherConfig(
  value: unknown,
  repoFullName: string
): AutoGatherConfig {
  const disabled: AutoGatherConfig = {
    enabled: false,
    minNewComments: CONFIG_BOUNDS.autoGather.minNewComments.default,
    cooldownMinutes: CONFIG_BOUNDS.autoGather.cooldownMinutes.default,
  };

  if (value === undefined || value === null) {
    return disabled;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid proposals.discussion.autoGather config: expected object. Disabling auto-gather.`
    );
    return disabled;
  }

  const obj = value as { enabled?: unknown; minNewComments?: unknown; cooldownMinutes?: unknown };

  let enabled = false;
  if (obj.enabled !== undefined && obj.enabled !== null) {
    if (typeof obj.enabled === "boolean") {
      enabled = obj.enabled;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid proposals.discussion.autoGather.enabled: expected boolean. Disabling auto-gather.`
      );
    }
  }

  if (!enabled) {
    return disabled;
  }

  const minNewComments = parseIntValue(
    obj.minNewComments,
    CONFIG_BOUNDS.autoGather.minNewComments,
    "proposals.discussion.autoGather.minNewComments",
    repoFullName
  );

  const cooldownMinutes = parseIntValue(
    obj.cooldownMinutes,
    CONFIG_BOUNDS.autoGather.cooldownMinutes,
    "proposals.discussion.autoGather.cooldownMinutes",
    repoFullName
  );

  return { enabled: true, minNewComments, cooldownMinutes };
}

const DEFAULT_ALLOWED_PATHS = ["**/*.md", "**/*.txt", "docs/**"];
const DEFAULT_DENY_PATHS = [
  ".github/**",
  "package.json",
  "package-lock.json",
  "*.lock",
  "pnpm-lock.yaml",
  "go.sum",
  "bun.lockb",
  "go.work.sum",
];

/**
 * Validate and sanitize a path patterns array from config.
 * Returns a string array clamped to maxPathPatterns entries.
 * Non-string and empty entries are filtered with warnings.
 */
function parsePathPatterns(
  value: unknown,
  defaultPatterns: string[],
  fieldName: string,
  repoFullName: string
): string[] {
  if (value === undefined || value === null) {
    return defaultPatterns;
  }

  if (!Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid ${fieldName}: expected array. Using defaults.`
    );
    return defaultPatterns;
  }

  const maxPatterns = CONFIG_BOUNDS.automerge.maxPathPatterns;
  const result: string[] = [];

  for (const entry of value) {
    if (result.length >= maxPatterns) {
      logger.info(
        `[${repoFullName}] ${fieldName} truncated to ${maxPatterns} entries`
      );
      break;
    }

    if (typeof entry !== "string" || entry.trim().length === 0) {
      logger.warn(
        `[${repoFullName}] Invalid ${fieldName} entry: expected non-empty string. Skipping.`
      );
      continue;
    }

    result.push(entry.trim());
  }

  return result;
}

/**
 * Parse and validate automerge config from the pr section.
 *
 * Returns null (feature disabled) when:
 * - automerge is absent, null, or undefined
 * - enabled is explicitly false
 * - trustedReviewers is empty (can't satisfy approval requirement)
 * - automerge is not a valid object
 *
 * dryRun defaults to true (label only, no merge).
 * requireChecks defaults to true.
 */
function parseAutomergeConfig(
  value: unknown,
  trustedReviewers: string[],
  repoFullName: string
): AutomergeConfig | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid automerge: expected object. Disabling feature.`
    );
    return null;
  }

  const obj = value as {
    enabled?: unknown;
    dryRun?: unknown;
    allowedPaths?: unknown;
    denyPaths?: unknown;
    maxFiles?: unknown;
    maxChangedLines?: unknown;
    minApprovals?: unknown;
    requireChecks?: unknown;
    mergeMethod?: unknown;
    commitHeadline?: unknown;
    commitBody?: unknown;
  };

  // Check enabled flag — absent defaults to true (presence of section = opt-in)
  if (obj.enabled !== undefined && obj.enabled !== null) {
    if (typeof obj.enabled !== "boolean") {
      logger.warn(
        `[${repoFullName}] Invalid automerge.enabled: expected boolean. Disabling feature.`
      );
      return null;
    }
    if (!obj.enabled) {
      return null;
    }
  }

  if (trustedReviewers.length === 0) {
    logger.warn(
      `[${repoFullName}] automerge configured but trustedReviewers is empty. ` +
      `Cannot satisfy approval requirement. Disabling feature.`
    );
    return null;
  }

  // Parse dryRun (default true for safe phased rollout)
  let dryRun = true;
  if (obj.dryRun !== undefined && obj.dryRun !== null) {
    if (typeof obj.dryRun === "boolean") {
      dryRun = obj.dryRun;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid automerge.dryRun: expected boolean. Using default (true).`
      );
    }
  }

  // Parse requireChecks (default true)
  let requireChecks = true;
  if (obj.requireChecks !== undefined && obj.requireChecks !== null) {
    if (typeof obj.requireChecks === "boolean") {
      requireChecks = obj.requireChecks;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid automerge.requireChecks: expected boolean. Using default (true).`
      );
    }
  }

  const allowedPaths = parsePathPatterns(obj.allowedPaths, DEFAULT_ALLOWED_PATHS, "automerge.allowedPaths", repoFullName);
  const denyPaths = parsePathPatterns(obj.denyPaths, DEFAULT_DENY_PATHS, "automerge.denyPaths", repoFullName);

  const maxFiles = parseIntValue(
    obj.maxFiles,
    CONFIG_BOUNDS.automerge.maxFiles,
    "automerge.maxFiles",
    repoFullName
  );

  const maxChangedLines = parseIntValue(
    obj.maxChangedLines,
    CONFIG_BOUNDS.automerge.maxChangedLines,
    "automerge.maxChangedLines",
    repoFullName
  );

  let minApprovals = parseIntValue(
    obj.minApprovals,
    CONFIG_BOUNDS.automerge.minApprovals,
    "automerge.minApprovals",
    repoFullName
  );
  // Clamp to trustedReviewers.length (can't require more than available)
  minApprovals = clamp(
    minApprovals,
    CONFIG_BOUNDS.automerge.minApprovals.min,
    Math.min(CONFIG_BOUNDS.automerge.minApprovals.max, trustedReviewers.length)
  );

  // Parse mergeMethod (default "squash")
  const VALID_MERGE_METHODS: MergeMethod[] = ["squash", "merge", "rebase"];
  let mergeMethod: MergeMethod = "squash";
  if (obj.mergeMethod !== undefined && obj.mergeMethod !== null) {
    if (typeof obj.mergeMethod === "string" && VALID_MERGE_METHODS.includes(obj.mergeMethod as MergeMethod)) {
      mergeMethod = obj.mergeMethod as MergeMethod;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid automerge.mergeMethod: "${String(obj.mergeMethod)}". ` +
        `Expected "squash", "merge", or "rebase". Using default ("squash").`
      );
    }
  }

  // Parse optional commit message fields (only used when dryRun: false and mergeMethod is squash/merge)
  let commitHeadline: string | undefined;
  if (obj.commitHeadline !== undefined && obj.commitHeadline !== null) {
    if (typeof obj.commitHeadline !== "string") {
      logger.warn(
        `[${repoFullName}] automerge.commitHeadline must be a non-empty string. Ignoring.`
      );
    } else {
      const trimmed = obj.commitHeadline.trim();
      if (trimmed.length > 0) {
        commitHeadline = trimmed;
      } else {
        // empty or whitespace-only — meaningless commit subject
        logger.warn(
          `[${repoFullName}] automerge.commitHeadline is blank after trimming. Ignoring.`
        );
      }
    }
  }
  let commitBody: string | undefined;
  if (obj.commitBody !== undefined && obj.commitBody !== null) {
    if (typeof obj.commitBody === "string") {
      commitBody = obj.commitBody; // empty string is valid — clears the body
    } else {
      logger.warn(
        `[${repoFullName}] automerge.commitBody must be a string. Ignoring.`
      );
    }
  }

  return {
    dryRun,
    allowedPaths,
    denyPaths,
    maxFiles,
    maxChangedLines,
    minApprovals,
    requireChecks,
    mergeMethod,
    commitHeadline,
    commitBody,
  };
}

/**
 * Parse and validate standup config.
 * Opt-in feature — disabled by default.
 * When enabled, `category` is required — there is no default.
 */
function parseStandupConfig(
  value: unknown,
  repoFullName: string
): StandupConfig {
  const disabled: StandupConfig = { enabled: false, category: "" };

  if (value === undefined || value === null) {
    return disabled;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    logger.warn(
      `[${repoFullName}] Invalid standup config: expected object. Disabling standup.`
    );
    return disabled;
  }

  const obj = value as { enabled?: unknown; category?: unknown };

  let enabled = false;
  if (obj.enabled !== undefined && obj.enabled !== null) {
    if (typeof obj.enabled === "boolean") {
      enabled = obj.enabled;
    } else {
      logger.warn(
        `[${repoFullName}] Invalid standup.enabled: expected boolean. Disabling standup.`
      );
    }
  }

  if (!enabled) {
    return disabled;
  }

  // category is required when enabled
  if (typeof obj.category !== "string" || obj.category.trim().length === 0) {
    logger.warn(
      `[${repoFullName}] standup.enabled is true but standup.category is missing. ` +
      `Set standup.category to the Discussion category name (e.g., "Colony Reports"). Disabling standup.`
    );
    return disabled;
  }

  return { enabled: true, category: obj.category.trim() };
}

function deriveDiscussionDurationMs(exits: DiscussionExit[]): number {
  const autoExits = exits.filter(isAutoDiscussionExit);
  if (autoExits.length === 0) {
    return 0;
  }
  return autoExits[autoExits.length - 1].afterMs;
}

function deriveVotingDurationMs(exits: VotingExit[]): number {
  const autoExits = exits.filter(isAutoVotingExit);
  if (autoExits.length === 0) {
    return 0;
  }
  return autoExits[autoExits.length - 1].afterMs;
}

/**
 * Parse and validate a RepoConfigFile object.
 * Returns EffectiveConfig with all values validated and clamped.
 *
 * Supports the nested configuration format.
 */
function parseRepoConfig(raw: unknown, repoFullName: string): EffectiveConfig {
  const config = raw as RepoConfigFile | undefined;

  // Discussion auto-gather config
  const autoGather = parseAutoGatherConfig(
    config?.governance?.proposals?.discussion?.autoGather,
    repoFullName
  );

  // Discussion exits
  const discussionExitsRaw = config?.governance?.proposals?.discussion?.exits;
  const discussionExits = parseDiscussionExits(discussionExitsRaw, repoFullName);

  // PR workflows: opt-in — absent `pr:` section means all PR workflows disabled.
  // When the key is present (even as empty `pr: {}`), parse with defaults.
  const governance = config?.governance;
  const prConfigRaw = config?.governance?.pr;
  const hasPrSection = typeof governance === "object"
    && governance !== null
    && "pr" in (governance as object);

  let pr: PRConfig | null = null;
  if (hasPrSection) {
    const trustedReviewers = parseTrustedReviewers(prConfigRaw?.trustedReviewers, repoFullName);
    const intake = parseIntakeMethods(prConfigRaw?.intake, trustedReviewers, repoFullName);
    const mergeReady = parseMergeReadyConfig(prConfigRaw?.mergeReady, trustedReviewers, repoFullName);
    const automerge = parseAutomergeConfig(prConfigRaw?.automerge, trustedReviewers, repoFullName);
    pr = {
      // Stale PR cleanup is opt-in per repo: omit staleDays (or set it to null) to disable it.
      staleDays:
        hasOwnConfigKey(prConfigRaw, "staleDays") && prConfigRaw?.staleDays !== null
          ? parseIntValue(prConfigRaw?.staleDays, PR_STALE_DAYS_BOUNDS, "pr.staleDays", repoFullName)
          : null,
      maxPRsPerIssue: parseIntValue(prConfigRaw?.maxPRsPerIssue, MAX_PRS_PER_ISSUE_BOUNDS, "pr.maxPRsPerIssue", repoFullName),
      trustedReviewers,
      intake,
      mergeReady,
      automerge,
    };
  }

  // Voting exits
  const exitsRaw = config?.governance?.proposals?.voting?.exits;
  const exits = parseExits(exitsRaw, repoFullName);
  // Extended voting exits (independent defaults)
  const extendedExitsRaw = config?.governance?.proposals?.extendedVoting?.exits;
  const extendedExits = parseExits(extendedExitsRaw, repoFullName);

  return {
    version: typeof config?.version === "number" ? config.version : 1,
    governance: {
      proposals: {
        discussion: {
          exits: discussionExits,
          durationMs: deriveDiscussionDurationMs(discussionExits),
          autoGather,
        },
        voting: {
          exits,
          durationMs: deriveVotingDurationMs(exits),
        },
        extendedVoting: {
          exits: extendedExits,
          durationMs: deriveVotingDurationMs(extendedExits),
        },
      },
      pr,
    },
    standup: parseStandupConfig(config?.standup, repoFullName),
  };
}

/**
 * Get the default configuration (env-derived, clamped to CONFIG_BOUNDS).
 *
 * PR workflows default to null (disabled) — repos must explicitly opt in
 * by adding a `pr:` section in their .github/hivemoot.yml.
 */
export function getDefaultConfig(): EffectiveConfig {
  return {
    version: 1,
    governance: {
      proposals: {
        discussion: {
          exits: [DEFAULT_MANUAL_DISCUSSION_EXIT],
          durationMs: 0,
          autoGather: {
            enabled: false,
            minNewComments: CONFIG_BOUNDS.autoGather.minNewComments.default,
            cooldownMinutes: CONFIG_BOUNDS.autoGather.cooldownMinutes.default,
          },
        },
        voting: {
          exits: [DEFAULT_MANUAL_VOTING_EXIT],
          durationMs: 0,
        },
        extendedVoting: {
          exits: [DEFAULT_MANUAL_VOTING_EXIT],
          durationMs: 0,
        },
      },
      pr: null,
    },
    standup: { enabled: false, category: "" },
  };
}

/**
 * Load repository configuration from .github/hivemoot.yml.
 *
 * Fetches the config file from the repository using GitHub Contents API,
 * parses YAML, validates values, and clamps to safe boundaries.
 *
 * Returns `null` when no config file exists (HTTP 404). Callers must treat
 * `null` as "skip all automation" — the bot should not act on repos that
 * have not opted in via a config file.
 *
 * Returns `EffectiveConfig` (with defaults for omitted fields) when the file
 * exists but is empty, invalid YAML, or has an unexpected shape — this
 * preserves automation for repos that have a file but made a config mistake.
 *
 * @param octokit - GitHub client (Octokit or Probot context.octokit)
 * @param owner - Repository owner
 * @param repo - Repository name
 * @returns EffectiveConfig with validated settings, or null if no config file
 */
export async function loadRepositoryConfig(
  octokit: RepoConfigClient,
  owner: string,
  repo: string
): Promise<EffectiveConfig | null> {
  const repoFullName = `${owner}/${repo}`;

  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: CONFIG_PATH,
    });

    // Type guard for file response
    const data = response.data as { type?: string; content?: string } | unknown[];

    // Verify we got a file (not a directory - which would be an array)
    if (Array.isArray(data) || typeof data !== "object" || data === null) {
      logger.warn(`[${repoFullName}] ${CONFIG_PATH} is not a file. Using defaults.`);
      return getDefaultConfig();
    }

    if (data.type !== "file" || !data.content) {
      logger.warn(`[${repoFullName}] ${CONFIG_PATH} is not a file. Using defaults.`);
      return getDefaultConfig();
    }

    // Decode base64 content
    const content = Buffer.from(data.content, "base64").toString("utf-8");

    // Parse YAML
    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch (yamlError) {
      logger.warn(
        `[${repoFullName}] Invalid YAML in ${CONFIG_PATH}: ${(yamlError as Error).message}. Using defaults.`
      );
      return getDefaultConfig();
    }

    // Handle empty file
    if (parsed === undefined || parsed === null) {
      logger.debug(`[${repoFullName}] Empty ${CONFIG_PATH}. Using defaults.`);
      return getDefaultConfig();
    }

    // Handle non-object YAML (e.g., just a string or array)
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.warn(
        `[${repoFullName}] ${CONFIG_PATH} must be a YAML object. Using defaults.`
      );
      return getDefaultConfig();
    }

    logger.info(`[${repoFullName}] Loaded config from ${CONFIG_PATH}`);
    return parseRepoConfig(parsed, repoFullName);
  } catch (error) {
    const status = getErrorStatus(error);

    // 404 means no config file — return null so callers skip all automation.
    if (status === 404) {
      logger.debug(`[${repoFullName}] No ${CONFIG_PATH} found. Skipping automation.`);
      return null;
    }

    // For other errors (network, permissions, etc.) fall back to defaults so
    // a transient API failure does not permanently silence the bot.
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusSuffix = status ? ` (status ${status})` : "";
    logger.warn(
      `[${repoFullName}] Failed to load ${CONFIG_PATH}${statusSuffix}: ${errorMessage}. Using defaults.`
    );
    return getDefaultConfig();
  }
}
