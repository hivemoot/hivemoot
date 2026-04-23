import { describe, it, expect, vi, beforeEach } from "vitest";
import { GovernanceService, createGovernanceService, isUnanimous, isDecisive, isExitEligible, isDiscussionExitEligible, type EndVotingOptions } from "./governance.js";
import type { DiscussionExit, VotingExit } from "./repo-config.js";
import type { IssueOperations } from "./github-client.js";
import type { IssueRef, VoteCounts, ValidatedVoteResult } from "./types.js";
import { LABELS, MESSAGES, SIGNATURE } from "../config.js";
import { SIGNATURES, ERROR_CODES } from "./bot-comments.js";
import { createModelFromEnv } from "./llm/provider.js";
import { DiscussionSummarizer, formatVotingMessage } from "./llm/summarizer.js";

// Mock LLM provider to control createModelFromEnv behavior
vi.mock("./llm/provider.js", () => ({
  createModelFromEnv: vi.fn(() => null), // Default: LLM not configured
}));

// Mock summarizer
vi.mock("./llm/summarizer.js", () => ({
  DiscussionSummarizer: vi.fn(),
  formatVotingMessage: vi.fn(() => "Formatted voting message with LLM summary"),
}));

/**
 * Tests for GovernanceService
 *
 * These tests verify the governance business logic:
 * - Phase transitions
 * - Voting outcome determination
 */

describe("GovernanceService", () => {
  let mockIssues: IssueOperations;
  let governance: GovernanceService;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    mockIssues = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue(undefined),
      getVoteCounts: vi.fn().mockResolvedValue({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 }),
      findVotingCommentId: vi.fn().mockResolvedValue(12345),
      getValidatedVoteCounts: vi.fn().mockResolvedValue({ votes: { thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 }, voters: [], participants: [] }),
      countVotingComments: vi.fn().mockResolvedValue(0),
      hasHumanHelpComment: vi.fn().mockResolvedValue(false),
      hasNotificationComment: vi.fn().mockResolvedValue(false),
      hasWelcomeComment: vi.fn().mockResolvedValue(false),
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date()),
      transition: vi.fn().mockResolvedValue(undefined),
      pinComment: vi.fn().mockResolvedValue(undefined),
      // getIssueContext should NOT be called when LLM is not configured
      getIssueContext: vi.fn(),
      getIssueLabels: vi.fn().mockResolvedValue([]),
    } as unknown as IssueOperations;

    governance = new GovernanceService(mockIssues);
  });

  describe("startDiscussion", () => {
    it("should add phase:discussion label and post welcome comment with metadata", async () => {
      await governance.startDiscussion(testRef);

      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.DISCUSSION]);
      expect(mockIssues.comment).toHaveBeenCalledTimes(1);

      const commentBody = vi.mocked(mockIssues.comment).mock.calls[0][1];
      // Should contain welcome metadata tag and the welcome message
      expect(commentBody).toContain("hivemoot-metadata:");
      expect(commentBody).toContain('"type":"welcome"');
      expect(commentBody).toContain(MESSAGES.ISSUE_WELCOME_VOTING);
    });

    it("should use provided welcome message override", async () => {
      await governance.startDiscussion(testRef, MESSAGES.ISSUE_WELCOME_MANUAL);

      const commentBody = vi.mocked(mockIssues.comment).mock.calls[0][1];
      expect(commentBody).toContain(MESSAGES.ISSUE_WELCOME_MANUAL);
      expect(commentBody).not.toContain("Ready to vote?");
    });

    it("should skip duplicate welcome comment but still apply label (replay-safe)", async () => {
      vi.mocked(mockIssues.hasWelcomeComment).mockResolvedValue(true);

      await governance.startDiscussion(testRef);

      // Label must always be applied — it is idempotent and ensures recovery
      // when a prior delivery posted the comment but failed before adding the label.
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.DISCUSSION]);
      expect(mockIssues.hasWelcomeComment).toHaveBeenCalledWith(testRef);
      // Comment must NOT be posted again
      expect(mockIssues.comment).not.toHaveBeenCalled();
    });
  });

  describe("transitionToVoting", () => {
    it("should call transition with generic message when LLM not configured", async () => {
      await governance.transitionToVoting(testRef);

      // Should NOT fetch issue context when LLM is not configured (avoids unnecessary API calls)
      expect(mockIssues.getIssueContext).not.toHaveBeenCalled();
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.DISCUSSION,
        addLabel: LABELS.VOTING,
        comment: expect.stringContaining(MESSAGES.votingStart()),
      });
      // Verify metadata is prepended
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toMatch(/^<!-- hivemoot-metadata:/);
      expect(callArgs.comment).toContain('"type":"voting"');
      expect(callArgs.comment).toContain('"cycle":1');
    });

    it("should skip GitHub API call when API key is missing (createModelFromEnv throws)", async () => {
      // Simulate API key missing - createModelFromEnv throws instead of returning null
      vi.mocked(createModelFromEnv).mockImplementation(() => {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      });

      await governance.transitionToVoting(testRef);

      // Critical: Should NOT fetch issue context when API key is missing
      // This is the core behavior this fix addresses
      expect(mockIssues.getIssueContext).not.toHaveBeenCalled();
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.DISCUSSION,
        addLabel: LABELS.VOTING,
        comment: expect.stringContaining(MESSAGES.votingStart()),
      });
    });

    it("should fall back to generic message and log warn when BYOK resolution fails", async () => {
      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const govWithLogger = new GovernanceService(mockIssues, mockLogger);

      vi.mocked(createModelFromEnv).mockRejectedValue(
        new Error("BYOK Redis lookup failed with HTTP 503"),
      );

      await govWithLogger.transitionToVoting(testRef);

      expect(mockIssues.getIssueContext).not.toHaveBeenCalled();
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.DISCUSSION,
        addLabel: LABELS.VOTING,
        comment: expect.stringContaining(MESSAGES.votingStart()),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("BYOK Redis lookup failed with HTTP 503"),
      );
    });

    describe("with LLM configured", () => {
      const mockSummary = {
        proposal: "Test proposal",
        alignedOn: ["Point 1"],
        openForPR: [],
        notIncluded: [],
        metadata: { commentCount: 5, participantCount: 3 },
      };

      const mockContext = {
        title: "Test Issue",
        body: "Issue body",
        author: "testuser",
        comments: [{ body: "Comment", author: "user1" }],
      };

      // Mock model result returned by createModelFromEnv when LLM is configured
      const mockModelResult = {
        model: {} as never, // Mock LanguageModelV1
        config: { provider: "anthropic" as const, model: "claude-3-haiku", maxTokens: 2000 },
      };

      beforeEach(() => {
        // Enable LLM by returning a mock model result
        vi.mocked(createModelFromEnv).mockResolvedValue(mockModelResult);

        // Setup mock issue context
        vi.mocked(mockIssues.getIssueContext).mockResolvedValue(mockContext);
      });

      it("should use LLM summary when configured and successful", async () => {
        // Setup successful summarization
        const mockSummarize = vi.fn().mockResolvedValue({
          success: true,
          summary: mockSummary,
        });
        vi.mocked(DiscussionSummarizer).mockImplementation(function () {
          return { summarize: mockSummarize };
        } as any);

        await governance.transitionToVoting(testRef);

        expect(mockIssues.getIssueContext).toHaveBeenCalledWith(testRef);
        expect(DiscussionSummarizer).toHaveBeenCalled();
        // Now passes the pre-created model as second argument
        expect(mockSummarize).toHaveBeenCalledWith(mockContext, mockModelResult);
        expect(formatVotingMessage).toHaveBeenCalledWith(
          mockSummary,
          mockContext.title,
          SIGNATURE,
          SIGNATURES.VOTING,
          undefined
        );
        // Verify comment includes both metadata and LLM message
        const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
        expect(callArgs.comment).toMatch(/^<!-- hivemoot-metadata:/);
        expect(callArgs.comment).toContain("Formatted voting message with LLM summary");
      });

      it("should fall back to generic message when LLM summarization fails", async () => {
        const mockSummarize = vi.fn().mockResolvedValue({
          success: false,
          reason: "API rate limited",
        });
        vi.mocked(DiscussionSummarizer).mockImplementation(function () {
          return { summarize: mockSummarize };
        } as any);

        await governance.transitionToVoting(testRef);

        expect(mockIssues.getIssueContext).toHaveBeenCalledWith(testRef);
        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.votingStart()),
        });
      });

      it("should fall back to generic message when LLM throws an error", async () => {
        const mockSummarize = vi.fn().mockRejectedValue(new Error("Network error"));
        vi.mocked(DiscussionSummarizer).mockImplementation(function () {
          return { summarize: mockSummarize };
        } as any);

        await governance.transitionToVoting(testRef);

        // Should still complete the transition with generic message
        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.votingStart()),
        });
      });

      it("should fall back to generic message when getIssueContext throws", async () => {
        vi.mocked(mockIssues.getIssueContext).mockRejectedValue(new Error("GitHub API error"));

        await governance.transitionToVoting(testRef);

        // Should still complete the transition with generic message
        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.votingStart()),
        });
      });

      it("should handle non-Error exceptions gracefully", async () => {
        vi.mocked(mockIssues.getIssueContext).mockRejectedValue("string error");

        await governance.transitionToVoting(testRef);

        expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
          removeLabel: LABELS.DISCUSSION,
          addLabel: LABELS.VOTING,
          comment: expect.stringContaining(MESSAGES.votingStart()),
        });
      });
    });

    it("should pin voting comment after transition", async () => {
      // findVotingCommentId returns 12345 by default in beforeEach mock
      await governance.transitionToVoting(testRef);

      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.pinComment).toHaveBeenCalledWith(testRef, 12345);
    });

    it("should not fail when pinning throws", async () => {
      vi.mocked(mockIssues.pinComment).mockRejectedValueOnce(new Error("403 Forbidden"));

      await expect(governance.transitionToVoting(testRef)).resolves.toBeUndefined();
    });
  });

  describe("postVotingComment", () => {
    it("should post voting comment when none exists", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);

      const result = await governance.postVotingComment(testRef);

      expect(result).toBe("posted");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.comment).toHaveBeenCalledTimes(1);
      // Should contain voting metadata
      const commentBody = vi.mocked(mockIssues.comment).mock.calls[0][1];
      expect(commentBody).toContain('"type":"voting"');
      expect(commentBody).toContain(MESSAGES.votingStart());
    });

    it("should skip when voting comment already exists", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(12345);

      const result = await governance.postVotingComment(testRef);

      expect(result).toBe("skipped");
      expect(mockIssues.comment).not.toHaveBeenCalled();
    });

    it("should pin voting comment after posting", async () => {
      vi.mocked(mockIssues.findVotingCommentId)
        .mockResolvedValueOnce(null)   // initial check: no existing comment
        .mockResolvedValueOnce(99999); // pin step: find newly posted comment

      const result = await governance.postVotingComment(testRef);

      expect(result).toBe("posted");
      expect(mockIssues.pinComment).toHaveBeenCalledWith(testRef, 99999);
    });

    it("should not fail when pinning throws after posting", async () => {
      vi.mocked(mockIssues.findVotingCommentId)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(99999);
      vi.mocked(mockIssues.pinComment).mockRejectedValueOnce(new Error("403 Forbidden"));

      await expect(governance.postVotingComment(testRef)).resolves.toBe("posted");
    });
  });

  describe("handleMissingVotingComment (via endVoting)", () => {
    it("should self-heal by posting voting comment when comment not found", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      // Self-heal posts the voting comment, NOT the human help comment
      expect(mockIssues.comment).toHaveBeenCalledTimes(1);
      const commentBody = vi.mocked(mockIssues.comment).mock.calls[0][1];
      expect(commentBody).toContain('"type":"voting"');
      // Human help path should NOT be reached
      expect(mockIssues.hasHumanHelpComment).not.toHaveBeenCalled();
      expect(mockIssues.addLabels).not.toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
    });

    it("should fall back to human help when self-heal fails", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      // First comment call (self-heal) fails; second (human help) succeeds
      vi.mocked(mockIssues.comment)
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce(undefined);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.hasHumanHelpComment).toHaveBeenCalledWith(testRef, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
      // Two comment calls: failed self-heal + successful human help
      expect(mockIssues.comment).toHaveBeenCalledTimes(2);
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
      expect(mockIssues.removeLabel).toHaveBeenCalledWith(testRef, LABELS.VOTING);
    });

    it("should skip duplicate human help after self-heal failure", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(true);
      // Self-heal fails
      vi.mocked(mockIssues.comment)
        .mockRejectedValueOnce(new Error("API error"));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      // Only the failed self-heal attempt; human help was already posted
      expect(mockIssues.comment).toHaveBeenCalledTimes(1);
      expect(mockIssues.addLabels).not.toHaveBeenCalled();
    });

    it("should survive addLabels failure in human help fallback", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      vi.mocked(mockIssues.comment)
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce(undefined);
      vi.mocked(mockIssues.addLabels).mockRejectedValue(new Error("Label not found"));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
      expect(mockIssues.removeLabel).not.toHaveBeenCalled();
    });

    it("should survive removeLabel failure in human help fallback", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      vi.mocked(mockIssues.comment)
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce(undefined);
      vi.mocked(mockIssues.removeLabel).mockRejectedValue(new Error("Remove label failed"));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
      expect(mockIssues.removeLabel).toHaveBeenCalledWith(testRef, LABELS.VOTING);
    });

    it("should not post human help when race condition causes skipped result", async () => {
      // endVoting sees null (no voting comment), but by the time postVotingComment
      // checks, the comment appeared (race with webhook handler or cron)
      vi.mocked(mockIssues.findVotingCommentId)
        .mockResolvedValueOnce(null)    // endVoting check
        .mockResolvedValueOnce(99999);  // postVotingComment check (comment appeared)

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      // No voting comment posted (it already exists)
      expect(mockIssues.comment).not.toHaveBeenCalled();
      // Human help path should NOT be reached
      expect(mockIssues.hasHumanHelpComment).not.toHaveBeenCalled();
      expect(mockIssues.addLabels).not.toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
    });

    it("should fall back to human help when findVotingCommentId throws in postVotingComment", async () => {
      vi.mocked(mockIssues.findVotingCommentId)
        .mockResolvedValueOnce(null)                     // endVoting check
        .mockRejectedValueOnce(new Error("API timeout")); // postVotingComment check throws
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      vi.mocked(mockIssues.comment).mockResolvedValue(undefined);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      // Self-heal threw, so we should see human help
      expect(mockIssues.hasHumanHelpComment).toHaveBeenCalledWith(testRef, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
      expect(mockIssues.removeLabel).toHaveBeenCalledWith(testRef, LABELS.VOTING);
    });

    it("should fall back to human help when comment() throws in postVotingComment", async () => {
      // findVotingCommentId returns null both times (no race), but comment() throws
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      vi.mocked(mockIssues.comment)
        .mockRejectedValueOnce(new Error("Comment creation failed"))  // postVotingComment
        .mockResolvedValueOnce(undefined);                            // human help comment

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.hasHumanHelpComment).toHaveBeenCalledWith(testRef, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
      // Two calls: failed voting comment + successful human help comment
      expect(mockIssues.comment).toHaveBeenCalledTimes(2);
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
      expect(mockIssues.removeLabel).toHaveBeenCalledWith(testRef, LABELS.VOTING);
    });
  });

  describe("endVoting", () => {
    /** Helper: create a ValidatedVoteResult where every vote is from a unique single-reaction voter */
    function validatedFrom(votes: VoteCounts): ValidatedVoteResult {
      const total = votes.thumbsUp + votes.thumbsDown + votes.confused + votes.eyes;
      const names = Array.from({ length: total }, (_, i) => `voter-${i}`);
      return { votes, voters: names, participants: names };
    }

    it("should mark ready-to-implement when thumbsUp > thumbsDown", async () => {
      const votes: VoteCounts = { thumbsUp: 5, thumbsDown: 2, confused: 1, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("ready-to-implement");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.getValidatedVoteCounts).toHaveBeenCalledWith(testRef, 12345);
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.READY_TO_IMPLEMENT,
        comment: MESSAGES.votingEndReadyToImplement(votes),
        close: false,
        lock: false,
      });
    });

    it("should reject and close when thumbsDown > thumbsUp", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 5, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("rejected");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.REJECTED,
        comment: MESSAGES.votingEndRejected(votes),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should be inconclusive when votes are tied", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 3, confused: 2, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("inconclusive");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.EXTENDED_VOTING,
        comment: MESSAGES.votingEndInconclusive(votes),
        close: false,
        lock: false,
      });
    });

    it("should be inconclusive when no votes", async () => {
      const votes: VoteCounts = { thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("inconclusive");
    });

    it("should return to discussion when confused > thumbsUp + thumbsDown (needs-more-discussion)", async () => {
      const votes: VoteCounts = { thumbsUp: 2, thumbsDown: 1, confused: 5, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("needs-more-discussion");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.DISCUSSION,
        comment: MESSAGES.votingEndNeedsMoreDiscussion(votes),
        close: false,
        lock: false,
        unlock: true,
      });
    });

    it("should apply needs-human-input when eyes > all other reactions combined", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 1, confused: 1, eyes: 5 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("needs-human-input");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.VOTING,
        addLabel: LABELS.NEEDS_HUMAN,
        comment: MESSAGES.votingEndNeedsHumanInput(votes),
        close: false,
        lock: false,
      });
    });

    it("should NOT trigger needs-human-input when eyes equals other reactions combined", async () => {
      // eyes (3) = thumbsUp (1) + thumbsDown (1) + confused (1) — should NOT trigger needs-human-input
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 1, confused: 1, eyes: 3 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      // Should proceed with normal outcome (tie → inconclusive)
      expect(outcome).toBe("inconclusive");
    });

    it("should prioritize needs-human-input over needs-more-discussion", async () => {
      // Both eyes and confused would normally trigger, but eyes has higher priority
      const votes: VoteCounts = { thumbsUp: 0, thumbsDown: 0, confused: 1, eyes: 3 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("needs-human-input");
    });

    it("should NOT trigger needs-more-discussion when confused equals thumbsUp + thumbsDown", async () => {
      // confused (3) = thumbsUp (2) + thumbsDown (1) - should NOT trigger needs-more-discussion
      const votes: VoteCounts = { thumbsUp: 2, thumbsDown: 1, confused: 3, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(validatedFrom(votes));

      const outcome = await governance.endVoting(testRef);

      // Should proceed with normal outcome (thumbsUp > thumbsDown)
      expect(outcome).toBe("ready-to-implement");
    });

    it("should return skipped and self-heal when voting comment not found", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);

      const outcome = await governance.endVoting(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      // Self-heal posts the voting comment
      expect(mockIssues.comment).toHaveBeenCalledTimes(1);
      expect(mockIssues.getValidatedVoteCounts).not.toHaveBeenCalled();
    });
  });

  describe("endVoting with options", () => {
    it("should prepend early decision note with 'quorum reached' when no required voters", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue({
        votes, voters: ["a", "b", "c", "d"], participants: ["a", "b", "c", "d"],
      });

      await governance.endVoting(testRef, { earlyDecision: true });

      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("Early decision");
      expect(callArgs.comment).toContain("quorum reached");
    });

    it("should prepend early decision with 'all required voters' for minCount = voters.length", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue({
        votes, voters: ["a", "b", "c", "d"], participants: ["a", "b", "c", "d"],
      });

      await governance.endVoting(testRef, {
        earlyDecision: true,
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 2, voters: ["a", "b"] } },
      });

      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("all required voters have participated");
    });

    it("should prepend early decision with 'a required voter' for minCount: 1", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue({
        votes, voters: ["a", "b", "c", "d"], participants: ["a", "b", "c", "d"],
      });

      await governance.endVoting(testRef, {
        earlyDecision: true,
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 1, voters: ["a", "b"] } },
      });

      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("a required voter has participated");
    });

    it("should NOT prepend early decision note when earlyDecision is false", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue({
        votes, voters: ["a", "b", "c", "d"], participants: ["a", "b", "c", "d"],
      });

      await governance.endVoting(testRef);

      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).not.toContain("Early decision");
    });

    it("should NOT prepend early decision note when outcome is inconclusive (tied vote)", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 3, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue({
        votes, voters: ["a", "b", "c", "d", "e", "f"], participants: ["a", "b", "c", "d", "e", "f"],
      });

      const outcome = await governance.endVoting(testRef, { earlyDecision: true });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).not.toContain("Early decision");
    });

    it("should force inconclusive when valid voters < minVoters", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 3, requiredVoters: { minCount: 0, voters: [] } },
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["alice"],
          participants: ["alice"],
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("Requirements Not Met");
      expect(callArgs.comment).toContain("Quorum: 1/3");
    });

    it("should not let one user satisfy minVoters with multiple reactions", async () => {
      // One user added 👍, 👎, and 😕 — multi-reaction discard means 0 valid voters, 0 counted votes
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 3, requiredVoters: { minCount: 0, voters: [] } },
        validatedVotes: {
          votes: { thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 }, // discarded from tally
          voters: [],                                           // discarded from quorum
          participants: ["alice"],                               // still a participant
        },
      });

      expect(outcome).toBe("inconclusive");
    });

    it("should force inconclusive when required voter is missing", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-a", "agent-c", "agent-d"],
          participants: ["agent-a", "agent-c", "agent-d"], // agent-b missing
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("Requirements Not Met");
      expect(callArgs.comment).toContain("Missing required voters");
      expect(callArgs.comment).toContain("@agent-b");
    });

    it("should allow normal outcome when all requirements met", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 2, requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-a", "agent-b", "agent-c"],
          participants: ["agent-a", "agent-b", "agent-c"],
        },
      });

      expect(outcome).toBe("ready-to-implement");
    });

    it("should count thumbsDown reactions as participation for requiredVoters", async () => {
      // agent-b voted 👎, which counts as participation
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 2, requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 2, confused: 0, eyes: 0 },
          voters: ["agent-a", "agent-b", "agent-c"],
          participants: ["agent-a", "agent-b", "agent-c"],
        },
      });

      // Normal outcome — agent-b participated via thumbsDown
      expect(outcome).toBe("rejected");
    });

    it("should still count multi-reaction user as participant for requiredVoters", async () => {
      // agent-a cast both 👍 and 👎 — invalid vote but still participated
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 1, voters: ["agent-a"] } },
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-b"],      // agent-a excluded from voters (multi-reaction)
          participants: ["agent-a", "agent-b"], // agent-a still a participant
        },
      });

      // agent-a participated, so requiredVoters passes. 1 valid voter >= minVoters 1.
      expect(outcome).toBe("ready-to-implement");
    });

    it("should use pre-fetched validatedVotes and skip API call", async () => {
      await governance.endVoting(testRef, {
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["alice"],
          participants: ["alice"],
        },
      });

      expect(mockIssues.getValidatedVoteCounts).not.toHaveBeenCalled();
    });
  });

  describe("resolveInconclusive", () => {
    /** Helper: create a ValidatedVoteResult with no enforcement concerns */
    function resolveValidated(votes: VoteCounts): ValidatedVoteResult {
      const total = votes.thumbsUp + votes.thumbsDown + votes.confused + votes.eyes;
      const names = Array.from({ length: total }, (_, i) => `voter-${i}`);
      return { votes, voters: names, participants: names };
    }

    it("should transition to ready-to-implement when thumbsUp > thumbsDown after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 5, thumbsDown: 2, confused: 1, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(resolveValidated(votes));

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("ready-to-implement");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      expect(mockIssues.getValidatedVoteCounts).toHaveBeenCalledWith(testRef, 12345);
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.EXTENDED_VOTING,
        addLabel: LABELS.READY_TO_IMPLEMENT,
        comment: MESSAGES.votingEndInconclusiveResolved(votes, "ready-to-implement"),
        close: false,
        lock: false,
      });
    });

    it("should transition to rejected when thumbsDown > thumbsUp after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 5, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(resolveValidated(votes));

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("rejected");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.EXTENDED_VOTING,
        addLabel: LABELS.REJECTED,
        comment: MESSAGES.votingEndInconclusiveResolved(votes, "rejected"),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should close and lock when still tied after extended voting (final)", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 3, confused: 2, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(resolveValidated(votes));

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("inconclusive");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.EXTENDED_VOTING,
        addLabel: LABELS.INCONCLUSIVE,
        comment: MESSAGES.votingEndInconclusiveFinal(votes),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should close and lock when no votes after extended voting (final)", async () => {
      const votes: VoteCounts = { thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(resolveValidated(votes));

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("inconclusive");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.EXTENDED_VOTING,
        addLabel: LABELS.INCONCLUSIVE,
        comment: MESSAGES.votingEndInconclusiveFinal(votes),
        close: true,
        closeReason: "not_planned",
        lock: true,
        lockReason: "resolved",
      });
    });

    it("should self-heal when voting comment not found in resolveInconclusive", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.findVotingCommentId).toHaveBeenCalledWith(testRef);
      // Self-heal posts the voting comment
      expect(mockIssues.comment).toHaveBeenCalledTimes(1);
      const commentBody = vi.mocked(mockIssues.comment).mock.calls[0][1];
      expect(commentBody).toContain('"type":"voting"');
      expect(mockIssues.getValidatedVoteCounts).not.toHaveBeenCalled();
    });

    it("should fall back to human help when self-heal fails in resolveInconclusive", async () => {
      vi.mocked(mockIssues.findVotingCommentId).mockResolvedValue(null);
      vi.mocked(mockIssues.hasHumanHelpComment).mockResolvedValue(false);
      vi.mocked(mockIssues.comment)
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce(undefined);

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("skipped");
      expect(mockIssues.hasHumanHelpComment).toHaveBeenCalledWith(testRef, ERROR_CODES.VOTING_COMMENT_NOT_FOUND);
      expect(mockIssues.addLabels).toHaveBeenCalledWith(testRef, [LABELS.NEEDS_HUMAN]);
      expect(mockIssues.removeLabel).toHaveBeenCalledWith(testRef, LABELS.EXTENDED_VOTING);
    });

    it("should apply needs-human-input when eyes > all others after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 0, confused: 1, eyes: 4 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(resolveValidated(votes));

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("needs-human-input");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.EXTENDED_VOTING,
        addLabel: LABELS.NEEDS_HUMAN,
        comment: MESSAGES.votingEndInconclusiveResolved(votes, "needs-human-input"),
        close: false,
        lock: false,
      });
    });

    it("should return to discussion when confused > thumbsUp + thumbsDown after extended voting", async () => {
      const votes: VoteCounts = { thumbsUp: 1, thumbsDown: 2, confused: 6, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue(resolveValidated(votes));

      const outcome = await governance.resolveInconclusive(testRef);

      expect(outcome).toBe("needs-more-discussion");
      expect(mockIssues.transition).toHaveBeenCalledWith(testRef, {
        removeLabel: LABELS.EXTENDED_VOTING,
        addLabel: LABELS.DISCUSSION,
        comment: MESSAGES.votingEndNeedsMoreDiscussion(votes),
        close: false,
        lock: false,
        unlock: true,
      });
    });

    it("should force inconclusive when valid voters < minVoters after extended voting", async () => {
      const outcome = await governance.resolveInconclusive(testRef, {
        votingConfig: { minVoters: 3, requiredVoters: { minCount: 0, voters: [] } },
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["alice"],
          participants: ["alice"],
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("Requirements Not Met");
      expect(callArgs.comment).toContain("Quorum: 1/3");
      expect(callArgs.comment).toContain("Closing this issue");
    });

    it("should force inconclusive when required voter missing after extended voting", async () => {
      const outcome = await governance.resolveInconclusive(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-a", "agent-c", "agent-d"],
          participants: ["agent-a", "agent-c", "agent-d"],
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("Requirements Not Met");
      expect(callArgs.comment).toContain("Missing required voters");
      expect(callArgs.comment).toContain("@agent-b");
      expect(callArgs.comment).toContain("Closing this issue");
    });

    it("should allow normal outcome when requirements met after extended voting", async () => {
      const outcome = await governance.resolveInconclusive(testRef, {
        votingConfig: { minVoters: 2, requiredVoters: { minCount: 1, voters: ["agent-a"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 },
          voters: ["agent-a", "agent-b", "agent-c", "agent-d"],
          participants: ["agent-a", "agent-b", "agent-c", "agent-d"],
        },
      });

      expect(outcome).toBe("ready-to-implement");
    });

    it("should use pre-fetched validatedVotes and skip API call", async () => {
      await governance.resolveInconclusive(testRef, {
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["alice"],
          participants: ["alice"],
        },
      });

      expect(mockIssues.getValidatedVoteCounts).not.toHaveBeenCalled();
    });
  });

  describe("enforceVotingRequirements with minCount: 1", () => {
    it("should pass when at least one required voter participated (minCount: 1)", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 1, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-a", "agent-c", "agent-d"],
          participants: ["agent-a", "agent-c", "agent-d"],
        },
      });

      expect(outcome).toBe("ready-to-implement");
    });

    it("should force inconclusive when no required voter participated (minCount: 1)", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 1, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-c", "agent-d", "agent-e"],
          participants: ["agent-c", "agent-d", "agent-e"],
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      // N-of-M (1 of 2): uses "Need X more" phrasing, not "Missing required voters"
      expect(callArgs.comment).toContain("Need 1 more required voter from:");
      expect(callArgs.comment).toContain("@agent-a");
      expect(callArgs.comment).toContain("@agent-b");
    });

    it("should pass with empty voters array (minCount: 0)", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 0, voters: [] } },
        validatedVotes: {
          votes: { thumbsUp: 1, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["alice"],
          participants: ["alice"],
        },
      });

      expect(outcome).toBe("ready-to-implement");
    });
  });

  describe("N-of-M required voters messaging", () => {
    it("should use 'Need X more' phrasing for true N-of-M (minCount < voters.length)", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b", "agent-c"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["agent-a", "x", "y"],
          participants: ["agent-a", "x", "y"],
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      // N-of-M: 1 participated, need 2, so "Need 1 more required voter from:"
      expect(callArgs.comment).toContain("Need 1 more required voter from:");
      expect(callArgs.comment).not.toContain("Missing required voters");
    });

    it("should use 'Missing required voters' when all are needed (minCount = voters.length)", async () => {
      const outcome = await governance.endVoting(testRef, {
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b"] } },
        validatedVotes: {
          votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
          voters: ["x", "y", "z"],
          participants: ["x", "y", "z"],
        },
      });

      expect(outcome).toBe("inconclusive");
      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("Missing required voters");
      expect(callArgs.comment).not.toContain("Need");
    });
  });

  describe("early decision with minCount: 0 and non-empty voters", () => {
    it("should say 'quorum reached' when minCount is 0 even with voters listed", async () => {
      const votes: VoteCounts = { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 };
      vi.mocked(mockIssues.getValidatedVoteCounts).mockResolvedValue({
        votes, voters: ["a", "b", "c"], participants: ["a", "b", "c"],
      });

      await governance.endVoting(testRef, {
        earlyDecision: true,
        votingConfig: { minVoters: 1, requiredVoters: { minCount: 0, voters: ["agent-a"] } },
      });

      const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
      expect(callArgs.comment).toContain("quorum reached");
      expect(callArgs.comment).not.toContain("0 of");
    });
  });
});

describe("isUnanimous", () => {
  it("should return true when all votes are thumbsUp", () => {
    expect(isUnanimous({ thumbsUp: 5, thumbsDown: 0, confused: 0, eyes: 0 })).toBe(true);
  });

  it("should return true when all votes are thumbsDown", () => {
    expect(isUnanimous({ thumbsUp: 0, thumbsDown: 3, confused: 0, eyes: 0 })).toBe(true);
  });

  it("should return true when all votes are confused", () => {
    expect(isUnanimous({ thumbsUp: 0, thumbsDown: 0, confused: 2, eyes: 0 })).toBe(true);
  });

  it("should return true when all votes are eyes", () => {
    expect(isUnanimous({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 4 })).toBe(true);
  });

  it("should return false when votes are mixed", () => {
    expect(isUnanimous({ thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 })).toBe(false);
  });

  it("should return false when no votes", () => {
    expect(isUnanimous({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 })).toBe(false);
  });
});

describe("isDecisive", () => {
  it("should return true when thumbsUp > thumbsDown", () => {
    expect(isDecisive({ thumbsUp: 3, thumbsDown: 1, confused: 0, eyes: 0 })).toBe(true);
  });

  it("should return true when thumbsDown > thumbsUp", () => {
    expect(isDecisive({ thumbsUp: 1, thumbsDown: 3, confused: 0, eyes: 0 })).toBe(true);
  });

  it("should return true when confused majority (needs-more-discussion)", () => {
    expect(isDecisive({ thumbsUp: 1, thumbsDown: 1, confused: 3, eyes: 0 })).toBe(true);
  });

  it("should return true when eyes majority (needs-human-input)", () => {
    expect(isDecisive({ thumbsUp: 1, thumbsDown: 1, confused: 1, eyes: 5 })).toBe(true);
  });

  it("should return false when thumbsUp === thumbsDown (tie)", () => {
    expect(isDecisive({ thumbsUp: 3, thumbsDown: 3, confused: 0, eyes: 0 })).toBe(false);
  });

  it("should return false when all zeros (tie at zero)", () => {
    expect(isDecisive({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 })).toBe(false);
  });

  it("should return false when tied with non-majority confused", () => {
    expect(isDecisive({ thumbsUp: 3, thumbsDown: 3, confused: 2, eyes: 0 })).toBe(false);
  });
});

describe("GovernanceService voting cycle tracking", () => {
  let mockIssues: IssueOperations;
  let governance: GovernanceService;
  const testRef: IssueRef = { owner: "test-org", repo: "test-repo", issueNumber: 42 };

  beforeEach(() => {
    mockIssues = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      comment: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue(undefined),
      getVoteCounts: vi.fn().mockResolvedValue({ thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 }),
      findVotingCommentId: vi.fn().mockResolvedValue(12345),
      getValidatedVoteCounts: vi.fn().mockResolvedValue({ votes: { thumbsUp: 0, thumbsDown: 0, confused: 0, eyes: 0 }, voters: [], participants: [] }),
      countVotingComments: vi.fn().mockResolvedValue(0),
      hasHumanHelpComment: vi.fn().mockResolvedValue(false),
      getLabelAddedTime: vi.fn().mockResolvedValue(new Date()),
      transition: vi.fn().mockResolvedValue(undefined),
      pinComment: vi.fn().mockResolvedValue(undefined),
      getIssueContext: vi.fn(),
    } as unknown as IssueOperations;

    governance = new GovernanceService(mockIssues);
  });

  it("should include cycle:1 in metadata for first voting transition", async () => {
    vi.mocked(mockIssues.countVotingComments).mockResolvedValue(0);

    await governance.transitionToVoting(testRef);

    const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
    expect(callArgs.comment).toContain('"cycle":1');
    expect(callArgs.comment).toContain('"issueNumber":42');
  });

  it("should include cycle:2 in metadata for second voting transition (after needs-more-discussion)", async () => {
    // Simulate one existing voting comment
    vi.mocked(mockIssues.countVotingComments).mockResolvedValue(1);

    await governance.transitionToVoting(testRef);

    const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
    expect(callArgs.comment).toContain('"cycle":2');
  });

  it("should include cycle:3 in metadata for third voting transition", async () => {
    // Simulate two existing voting comments
    vi.mocked(mockIssues.countVotingComments).mockResolvedValue(2);

    await governance.transitionToVoting(testRef);

    const callArgs = vi.mocked(mockIssues.transition).mock.calls[0][1];
    expect(callArgs.comment).toContain('"cycle":3');
  });

  it("should call countVotingComments to determine cycle number", async () => {
    await governance.transitionToVoting(testRef);

    expect(mockIssues.countVotingComments).toHaveBeenCalledWith(testRef);
  });
});

describe("createGovernanceService", () => {
  const mockIssues = {
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
    comment: vi.fn(),
    close: vi.fn(),
    lock: vi.fn(),
    getVoteCounts: vi.fn(),
    findVotingCommentId: vi.fn(),
    getValidatedVoteCounts: vi.fn(),
    countVotingComments: vi.fn(),
    hasHumanHelpComment: vi.fn(),
    getLabelAddedTime: vi.fn(),
    transition: vi.fn(),
    pinComment: vi.fn(),
    getIssueContext: vi.fn(),
  } as unknown as IssueOperations;

  it("should throw if issues is null", () => {
    expect(() => createGovernanceService(null as unknown as IssueOperations)).toThrow(
      "Invalid IssueOperations: expected a valid IssueOperations instance"
    );
  });

  it("should throw if issues is undefined", () => {
    expect(() => createGovernanceService(undefined as unknown as IssueOperations)).toThrow(
      "Invalid IssueOperations: expected a valid IssueOperations instance"
    );
  });

  it("should create service with valid issues", () => {
    const service = createGovernanceService(mockIssues);
    expect(service).toBeInstanceOf(GovernanceService);
  });

  it("should accept optional config with logger", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      group: vi.fn(),
      groupEnd: vi.fn(),
    };

    const service = createGovernanceService(mockIssues, { logger: mockLogger });
    expect(service).toBeInstanceOf(GovernanceService);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDiscussionExitEligible
// ─────────────────────────────────────────────────────────────────────────────

describe("isDiscussionExitEligible", () => {
  const baseExit: DiscussionExit = {
    afterMs: 30 * 60 * 1000,
    minReady: 0,
    requiredReady: { minCount: 0, users: [] },
  };

  it("should return true when no conditions (pure time gate)", () => {
    const readyUsers = new Set<string>();
    expect(isDiscussionExitEligible(baseExit, readyUsers)).toBe(true);
  });

  it("should return true when minReady met", () => {
    const exit = { ...baseExit, minReady: 2 };
    const readyUsers = new Set(["alice", "bob"]);
    expect(isDiscussionExitEligible(exit, readyUsers)).toBe(true);
  });

  it("should return false when minReady not met", () => {
    const exit = { ...baseExit, minReady: 3 };
    const readyUsers = new Set(["alice", "bob"]);
    expect(isDiscussionExitEligible(exit, readyUsers)).toBe(false);
  });

  it("should return true when all required users ready (minCount = users.length)", () => {
    const exit: DiscussionExit = {
      ...baseExit,
      requiredReady: { minCount: 2, users: ["alice", "bob"] },
    };
    const readyUsers = new Set(["alice", "bob", "charlie"]);
    expect(isDiscussionExitEligible(exit, readyUsers)).toBe(true);
  });

  it("should return false when some required users missing (minCount = users.length)", () => {
    const exit: DiscussionExit = {
      ...baseExit,
      requiredReady: { minCount: 2, users: ["alice", "bob"] },
    };
    const readyUsers = new Set(["alice"]);
    expect(isDiscussionExitEligible(exit, readyUsers)).toBe(false);
  });

  it("should return true when any required user ready (minCount: 1)", () => {
    const exit: DiscussionExit = {
      ...baseExit,
      requiredReady: { minCount: 1, users: ["alice", "bob"] },
    };
    const readyUsers = new Set(["bob"]);
    expect(isDiscussionExitEligible(exit, readyUsers)).toBe(true);
  });

  it("should return false when no required user ready (minCount: 1)", () => {
    const exit: DiscussionExit = {
      ...baseExit,
      requiredReady: { minCount: 1, users: ["alice", "bob"] },
    };
    const readyUsers = new Set(["charlie"]);
    expect(isDiscussionExitEligible(exit, readyUsers)).toBe(false);
  });

  it("should support N of M with minCount: 3 of 4 users", () => {
    const exit: DiscussionExit = {
      ...baseExit,
      requiredReady: { minCount: 3, users: ["alice", "bob", "charlie", "dave"] },
    };
    // Only 2 of 4 ready → not enough
    expect(isDiscussionExitEligible(exit, new Set(["alice", "bob"]))).toBe(false);
    // 3 of 4 ready → passes
    expect(isDiscussionExitEligible(exit, new Set(["alice", "bob", "charlie"]))).toBe(true);
    // 4 of 4 ready → passes
    expect(isDiscussionExitEligible(exit, new Set(["alice", "bob", "charlie", "dave"]))).toBe(true);
  });

  it("should check both minReady and requiredReady together", () => {
    const exit: DiscussionExit = {
      ...baseExit,
      minReady: 3,
      requiredReady: { minCount: 1, users: ["alice"] },
    };
    // Alice is ready but total < 3
    expect(isDiscussionExitEligible(exit, new Set(["alice", "bob"]))).toBe(false);
    // Total >= 3 and alice is ready
    expect(isDiscussionExitEligible(exit, new Set(["alice", "bob", "charlie"]))).toBe(true);
    // Total >= 3 but alice is NOT ready
    expect(isDiscussionExitEligible(exit, new Set(["bob", "charlie", "dave"]))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isExitEligible with minCount
// ─────────────────────────────────────────────────────────────────────────────

describe("isExitEligible", () => {
  const baseExit: VotingExit = {
    afterMs: 15 * 60 * 1000,
    requires: "majority",
    minVoters: 0,
    requiredVoters: { minCount: 0, voters: [] },
  };

  it("should support N of M with minCount: 2 of 3 voters", () => {
    const exit: VotingExit = {
      ...baseExit,
      requiredVoters: { minCount: 2, voters: ["agent-a", "agent-b", "agent-c"] },
    };
    // Only 1 of 3 participated → not enough
    expect(isExitEligible(exit, {
      votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
      voters: ["agent-a", "x", "y"],
      participants: ["agent-a", "x", "y"],
    })).toBe(false);
    // 2 of 3 participated → passes
    expect(isExitEligible(exit, {
      votes: { thumbsUp: 3, thumbsDown: 0, confused: 0, eyes: 0 },
      voters: ["agent-a", "agent-b", "x"],
      participants: ["agent-a", "agent-b", "x"],
    })).toBe(true);
  });
});
