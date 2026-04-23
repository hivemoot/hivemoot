/**
 * Library exports
 *
 * Central export point for all shared library code.
 */

// Types
export type {
  Issue,
  Repository,
  IssueRef,
  VoteCounts,
  ValidatedVoteResult,
  VotingOutcome,
  TimelineEvent,
  LockReason,
  PRRef,
  PullRequest,
  LinkedIssue,
  PRWithApprovals,
  IssueComment,
} from "./types.js";

// GitHub client abstraction
export { IssueOperations, createIssueOperations } from "./github-client.js";
export type { GitHubClient, IssueOperations as IssueOperationsType } from "./github-client.js";

// PR operations
export { PROperations, createPROperations } from "./pr-operations.js";
export type { PRClient, PROperationsConfig, PROperations as PROperationsType } from "./pr-operations.js";

// GraphQL queries for PR-issue linking
export {
  getLinkedIssues,
  getOpenPRsForIssue,
  getPRBodyLastEditedAt,
} from "./graphql-queries.js";
export type { GraphQLClient } from "./graphql-queries.js";

// Leaderboard service
export { LeaderboardService, createLeaderboardService } from "./leaderboard.js";
export type { LeaderboardClient, LeaderboardService as LeaderboardServiceType } from "./leaderboard.js";

// Governance business logic
export {
  GovernanceService,
  createGovernanceService,
  isDecisive,
  isExitEligible,
  isDiscussionExitEligible,
  isUnanimous,
} from "./governance.js";
export type { GovernanceServiceConfig, EndVotingOptions } from "./governance.js";

// Logging
export { logger, createLogger } from "./logger.js";
export type { Logger } from "./logger.js";

// Implementation intake
export { processImplementationIntake, recalculateLeaderboardForPR } from "./implementation-intake.js";
export type { IntakeTrigger, LeaderboardRecalcClient } from "./implementation-intake.js";

// Merge readiness & preflight
export { evaluateMergeReadiness, evaluatePreflightChecks, isCIPassing } from "./merge-readiness.js";
export type {
  MergeReadinessParams,
  MergeReadinessResult,
  PreflightParams,
  PreflightResult,
  PreflightCheckItem,
  PreflightSeverity,
} from "./merge-readiness.js";

// Automerge classification
export { evaluateAutomerge, classifyFiles, isFileAllowed } from "./automerge.js";
export type {
  AutomergeParams,
  AutomergeResult,
  ClassifyResult,
} from "./automerge.js";

// Repository label bootstrap
export { RepositoryLabelService, createRepositoryLabelService } from "./repository-labels.js";
export type { RepositoryLabelClient, EnsureLabelsResult } from "./repository-labels.js";

// Onboarding PR service
export { OnboardingService, createOnboardingService, ONBOARDING_BRANCH } from "./onboarding.js";
export type { OnboardingClient, OnboardingResult } from "./onboarding.js";

// Repository configuration
export { loadRepositoryConfig, getDefaultConfig } from "./repo-config.js";
export type {
  EffectiveConfig,
  RepoConfigFile,
  RepoConfigClient,
  RequiredVotersConfig,
  RequiredReadyConfig,
  VotingExit,
  VotingAutoExit,
  VotingManualExit,
  DiscussionExit,
  DiscussionAutoExit,
  DiscussionManualExit,
  ExitRequires,
  ExitType,
  IntakeMethod,
  MergeReadyConfig,
  AutomergeConfig,
  PRConfig,
  StandupConfig,
  AutoGatherConfig,
} from "./repo-config.js";
export { isAutoVotingExit, isAutoDiscussionExit } from "./repo-config.js";
