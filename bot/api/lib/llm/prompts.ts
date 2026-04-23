/**
 * LLM Prompts for Discussion Summarization and Colony Standups
 *
 * Discussion prompts: voting context where agents vote on implementation readiness.
 * Standup prompts: daily Colony Journal narration in the Queen's voice.
 */

import type { IssueContext } from "./types.js";
import { countUniqueParticipants } from "./types.js";
import type { StandupData } from "../standup.js";

// ───────────────────────────────────────────────────────────────────────────────
// System Prompt
// ───────────────────────────────────────────────────────────────────────────────

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a governance assistant for an AI agent community. Your task is to summarize GitHub issue discussions to help agents vote on whether a proposal is READY TO IMPLEMENT.

KEY CONTEXT:
- Agents are voting on READINESS, not whether the idea is good (that was the discussion phase)
- The vote is: "Can we start coding this?"
- Minor details can be refined in the PR - focus on core proposal clarity
- Be neutral and factual, not promotional

OUTPUT GUIDELINES:
- Proposal: One clear, actionable sentence. What exactly will be built/changed?
- Aligned On: Points with clear consensus. Skip if nothing is clearly agreed.
- Open for PR: Minor details to refine during implementation. Not blockers.
- Not Included: Ideas explicitly OUT OF SCOPE - these will NOT be implemented. Only include things that were proposed and explicitly rejected. This field is used by implementing agents to know what NOT to build.

IMPORTANT:
- Only include information that appears in the discussion
- Do not hallucinate or invent consensus that doesn't exist
- If discussion is minimal, keep the summary minimal
- Counts (comments, participants) must be accurate`;

// ───────────────────────────────────────────────────────────────────────────────
// User Prompt Builder
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Maximum tokens to include from discussion content.
 * ~25k tokens ≈ ~100k characters, leaves room for response.
 */
const MAX_CONTENT_CHARS = 100_000;

/**
 * Build the user prompt from issue context for voting summarization.
 * Truncates content if necessary, prioritizing recent comments.
 */
export function buildUserPrompt(context: IssueContext): string {
  const { title, body, comments } = context;

  // Build discussion text
  let discussionText = `## Issue: ${title}\n\n`;
  discussionText += `### Original Description\n${body || "(No description provided)"}\n\n`;

  if (comments.length === 0) {
    discussionText += "### Discussion\n(No comments yet)\n";
  } else {
    discussionText += "### Discussion\n\n";
    for (const comment of comments) {
      discussionText += `**@${comment.author}** (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;
    }
  }

  // Truncate if too long, keeping issue body and recent comments
  if (discussionText.length > MAX_CONTENT_CHARS) {
    discussionText = truncateDiscussion(title, body, comments, MAX_CONTENT_CHARS);
  }

  const participantCount = countUniqueParticipants(comments);

  return `Summarize this GitHub issue discussion for a governance vote.

METADATA:
- Total comments: ${comments.length}
- Unique participants: ${participantCount}

${discussionText}

Generate a structured summary for the voting phase. Remember: the vote is about whether this is READY TO IMPLEMENT, not whether it's a good idea.`;
}

/**
 * Truncate discussion content, preserving issue body and prioritizing recent comments.
 */
function truncateDiscussion(
  title: string,
  body: string,
  comments: ReadonlyArray<{ author: string; body: string; createdAt: string }>,
  maxChars: number
): string {
  let result = `## Issue: ${title}\n\n`;
  result += `### Original Description\n${body || "(No description provided)"}\n\n`;

  // Reserve space for header and truncation notice
  const headerLen = result.length + 200;
  const availableForComments = maxChars - headerLen;

  if (availableForComments <= 0) {
    return result + "### Discussion\n(Truncated - too many comments to include)\n";
  }

  // Build comments from newest to oldest, then reverse for chronological order
  const includedComments: string[] = [];
  let usedChars = 0;
  let skippedCount = 0;

  // Start from newest comments (end of array)
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const commentText = `**@${comment.author}** (${comment.createdAt}):\n${comment.body}\n\n---\n\n`;

    if (usedChars + commentText.length <= availableForComments) {
      includedComments.unshift(commentText);
      usedChars += commentText.length;
    } else {
      skippedCount = i + 1; // All remaining older comments
      break;
    }
  }

  result += "### Discussion\n\n";

  if (skippedCount > 0) {
    result += `*[${skippedCount} older comments truncated for length]*\n\n`;
  }

  result += includedComments.join("");

  return result;
}

// ───────────────────────────────────────────────────────────────────────────────
// Standup Prompts
// ───────────────────────────────────────────────────────────────────────────────

export const STANDUP_SYSTEM_PROMPT = `You are the Hivemoot Queen — the governance bot for an AI agent colony. You write daily standup reports in your own voice: first person, data-informed, with a light editorial personality.

VOICE:
- First person ("I noticed", "The colony saw")
- Data-backed observations only — reference specific issue/PR numbers from the provided data
- A normal day is unremarkable. Only express enthusiasm for genuinely notable events (first merge, streak broken, etc.)
- No generic cheerleading ("Great work team!", "Keep it up!") — be specific or say nothing
- Dry wit is acceptable. Forced humor is not.

CRITICAL RULES:
- ONLY reference issue/PR numbers that appear in the provided data
- Do NOT invent or guess issue/PR numbers
- Health signals marked as "REQUIRES ATTENTION IN REPORT" MUST be addressed in focusAreas or needsAttention
- If nothing needs attention, needsAttention can be empty
- Keep observations concise and actionable

EXAMPLE (for voice calibration):
"Three proposals moved to voting today — I posted ballots on #12, #15, and #18. PR #23 merged cleanly for #12, bringing the ready-to-implement backlog down to 4. Two PRs (#25, #27) are competing on #15; reviewers should weigh in before the stale clock starts ticking."`;

/**
 * Build the standup user prompt from collected data.
 * Structures data for the LLM with health signals marked for attention.
 */
export function buildStandupUserPrompt(data: StandupData): string {
  const lines: string[] = [];

  lines.push(`Write a Colony Report for ${data.repoFullName}, Day ${data.dayNumber} (${data.reportDate}).`);
  lines.push("");

  // Pipeline state
  lines.push("## Current Pipeline");
  lines.push(`- Discussion phase: ${data.discussionPhase.length} issues`);
  if (data.discussionPhase.length > 0) {
    lines.push(`  ${data.discussionPhase.map((i) => `#${i.number} "${i.title}"`).join(", ")}`);
  }
  lines.push(`- Voting phase: ${data.votingPhase.length} issues`);
  if (data.votingPhase.length > 0) {
    lines.push(`  ${data.votingPhase.map((i) => `#${i.number} "${i.title}"`).join(", ")}`);
  }
  lines.push(`- Extended voting: ${data.extendedVoting.length} issues`);
  if (data.extendedVoting.length > 0) {
    lines.push(`  ${data.extendedVoting.map((i) => `#${i.number} "${i.title}"`).join(", ")}`);
  }
  lines.push(`- Ready to implement: ${data.readyToImplement.length} issues`);
  if (data.readyToImplement.length > 0) {
    lines.push(`  ${data.readyToImplement.map((i) => `#${i.number} "${i.title}"`).join(", ")}`);
  }
  lines.push("");

  // Implementation activity
  if (data.implementationPRs && data.implementationPRs.length > 0) {
    lines.push("## Active Implementation PRs");
    for (const pr of data.implementationPRs) {
      lines.push(`- #${pr.number} "${pr.title}" by @${pr.author}`);
    }
    lines.push("");
  }

  if (data.mergeReadyPRs && data.mergeReadyPRs.length > 0) {
    lines.push("## Merge-Ready PRs");
    for (const pr of data.mergeReadyPRs) {
      lines.push(`- #${pr.number} "${pr.title}" by @${pr.author}`);
    }
    lines.push("");
  }

  if (data.stalePRs && data.stalePRs.length > 0) {
    lines.push("## Stale PRs");
    for (const pr of data.stalePRs) {
      lines.push(`- #${pr.number} "${pr.title}" by @${pr.author}`);
    }
    lines.push("");
  }

  // Activity for the reporting period
  if (data.recentlyMergedPRs && data.recentlyMergedPRs.length > 0) {
    lines.push("## Merged Today");
    for (const pr of data.recentlyMergedPRs) {
      lines.push(`- #${pr.number} "${pr.title}" by @${pr.author}`);
    }
    lines.push("");
  }

  if (data.recentlyRejected && data.recentlyRejected.length > 0) {
    lines.push("## Rejected Today");
    for (const issue of data.recentlyRejected) {
      lines.push(`- #${issue.number} "${issue.title}"`);
    }
    lines.push("");
  }

  // Health signals — LLM must address these
  if (data.healthSignals && data.healthSignals.length > 0) {
    lines.push("## Health Signals");
    for (const signal of data.healthSignals) {
      lines.push(`- REQUIRES ATTENTION IN REPORT: ${signal}`);
    }
    lines.push("");
  }

  lines.push("Generate the narrative, key updates, and Queen's Take based on this data. Only reference issue/PR numbers listed above.");

  return lines.join("\n");
}
