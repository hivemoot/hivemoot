import { describe, it, expect } from "vitest";
import { formatBuzz, formatStatus, formatRole, formatRoles } from "./formatter.js";
import type { RepoSummary, RoleConfig, TeamConfig } from "../config/types.js";

const summary: RepoSummary = {
  repo: { owner: "hivemoot", repo: "colony" },
  currentUser: "alice",
  needsHuman: [],
  driveDiscussion: [],
  driveImplementation: [],
  voteOn: [{ number: 50, title: "Auth redesign", tags: ["vote", "security"], author: "alice", comments: 2, age: "3 days ago" }],
  discuss: [],
  implement: [
    { number: 45, title: "User Dashboard", tags: ["enhancement"], author: "bob", comments: 0, age: "3 days ago" },
    { number: 47, title: "Notifications", tags: [], author: "alice", comments: 0, age: "yesterday" },
  ],
  reviewPRs: [{ number: 49, title: "Search", tags: ["feature"], author: "carol", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0, commented: 0 } }],
  draftPRs: [],
  addressFeedback: [],
  unclassified: [],
  notifications: [],
  notes: [],
};

const role: RoleConfig = {
  description: "Implements features, fixes bugs",
  instructions: "You are a senior engineer.\nWrite clean code.",
};

const teamConfig: TeamConfig = {
  name: "colony",
  roles: {
    engineer: { description: "Implements features", instructions: "..." },
    tech_lead: { description: "Reviews architecture", instructions: "..." },
  },
};

describe("formatBuzz()", () => {
  it("includes role name and description", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("engineer");
    expect(output).toContain("Implements features, fixes bugs");
  });

  it("includes instructions", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("INSTRUCTIONS:");
    expect(output).toContain("You are a senior engineer.");
  });

  it("includes repo and logged-in user in header", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("hivemoot/colony");
    expect(output).toContain("logged in as");
    expect(output).toContain("alice");
  });

  it("shows team focus in header when present", () => {
    const withFocus: RepoSummary = {
      ...summary,
      focus: "Review PR backlog this week.",
    };
    const output = formatBuzz("engineer", role, withFocus);
    expect(output).toContain("Team focus: Review PR backlog this week.");
  });

  it("includes section dividers with counts", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("VOTE ON ISSUES");
    expect(output).toContain("(1)");
    expect(output).toContain("READY TO IMPLEMENT ISSUES");
    expect(output).toContain("(2)");
  });

  it("includes issue numbers and titles", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("#50");
    expect(output).toContain("Auth redesign");
    expect(output).toContain("#45");
    expect(output).toContain("User Dashboard");
  });

  it("renders all tags in brackets without filtering", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("[vote]");
    expect(output).toContain("[security]");
    expect(output).toContain("[enhancement]");
    expect(output).toContain("[feature]");
  });

  it("marks current user items with star and 'you'", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toMatch(/★.*#50/);
    expect(output).toMatch(/★.*#47/);
    expect(output).toContain("you");
  });

  it("shows other authors without star or 'you'", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("bob");
    expect(output).toContain("carol");
    expect(output).not.toMatch(/★.*#45/);
    expect(output).not.toMatch(/★.*#49/);
  });

  it("includes NEEDS HUMAN section when present", () => {
    const withHuman: RepoSummary = {
      ...summary,
      needsHuman: [{ number: 99, title: "Blocked issue", tags: ["needs:human"], author: "bob", comments: 0, age: "2 days ago" }],
    };
    const output = formatBuzz("engineer", role, withHuman);
    expect(output).toContain("NEEDS HUMAN");
    expect(output).toContain("#99");
    expect(output).toContain("Blocked issue");
    // NEEDS HUMAN should appear before VOTE ON ISSUES
    const humanIdx = output.indexOf("NEEDS HUMAN");
    const voteIdx = output.indexOf("VOTE ON ISSUES");
    expect(humanIdx).toBeLessThan(voteIdx);
  });

  it("includes onboarding section when provided", () => {
    const output = formatBuzz("engineer", role, summary, undefined, "Read CONTRIBUTING.md first.");
    expect(output).toContain("ONBOARDING:");
    expect(output).toContain("Read CONTRIBUTING.md first.");
    // Onboarding should appear before ROLE
    const onboardingIdx = output.indexOf("ONBOARDING:");
    const roleIdx = output.indexOf("ROLE:");
    expect(onboardingIdx).toBeLessThan(roleIdx);
  });

  it("omits onboarding section when not provided", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).not.toContain("ONBOARDING:");
  });

  it("respects limit parameter", () => {
    const output = formatBuzz("engineer", role, summary, 1);
    expect(output).toContain("#45");
    expect(output).not.toContain("#47");
    expect(output).toContain("... and 1 more");
  });

  it("renders two-line format with labeled metadata", () => {
    const output = formatBuzz("engineer", role, summary);
    // The metadata line should have key: value pairs
    expect(output).toContain("by:");
    expect(output).toContain("comments:");
    expect(output).toContain("created:");
  });

  it("renders PR metadata with status, checks, merge, review", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("status:");
    expect(output).toContain("checks:");
    expect(output).toContain("merge:");
    expect(output).toContain("review:");
    expect(output).toContain("0 approved");
    expect(output).not.toContain("changes-requested");
  });

  it("renders review feedback count as 'with feedback' when present", () => {
    const withFeedback: RepoSummary = {
      ...summary,
      reviewPRs: [
        {
          ...summary.reviewPRs[0],
          review: { approvals: 2, changesRequested: 0, commented: 1 },
        },
      ],
    };

    const output = formatStatus(withFeedback);
    expect(output).toContain("review:");
    expect(output).toContain("2 approved, 1 with feedback");
  });

  it("renders RECENTLY CLOSED (AUTHORED BY YOU) section when available", () => {
    const withRecent: RepoSummary = {
      ...summary,
      recentlyClosedByYou: [
        {
          number: 88,
          title: "Shipped docs",
          url: "https://github.com/hivemoot/colony/pull/88",
          itemType: "pr",
          outcome: "merged",
          closedAt: "2026-02-18T10:00:00Z",
          closedAge: "1h ago",
        },
      ],
    };

    const output = formatStatus(withRecent);
    expect(output).toContain("RECENTLY CLOSED (AUTHORED BY YOU)");
    expect(output).toContain("PR #88");
    expect(output).toContain("merged");
    expect(output).toContain("1h ago");
  });
});

describe("formatStatus()", () => {
  it("includes summary but no role", () => {
    const output = formatStatus(summary);
    expect(output).toContain("hivemoot/colony");
    expect(output).not.toContain("ROLE:");
    expect(output).not.toContain("INSTRUCTIONS:");
  });

  it("shows logged-in user in header", () => {
    const output = formatStatus(summary);
    expect(output).toContain("logged in as");
    expect(output).toContain("alice");
  });

  it("shows team focus in header when present", () => {
    const withFocus: RepoSummary = {
      ...summary,
      focus: "Close critical bugs first.",
    };
    const output = formatStatus(withFocus);
    expect(output).toContain("Team focus: Close critical bugs first.");
  });

  it("handles empty summary", () => {
    const empty: RepoSummary = {
      repo: { owner: "test", repo: "empty" },
      currentUser: "test-user",
      needsHuman: [],
      driveDiscussion: [],
      driveImplementation: [],
      voteOn: [],
      discuss: [],
      implement: [],
      reviewPRs: [],
      draftPRs: [],
      addressFeedback: [],
      notifications: [],
      notes: [],
    };
    const output = formatStatus(empty);
    expect(output).toContain("No open issues or PRs");
  });

  it("renders implement items with assigned key", () => {
    const output = formatStatus(summary);
    expect(output).toContain("assigned:");
  });

  it("renders UNCLASSIFIED section when present", () => {
    const withUnclassified: RepoSummary = {
      ...summary,
      unclassified: [
        { number: 72, title: "Investigate flaky logs", tags: [], author: "bob", comments: 1, age: "2 days ago" },
      ],
    };

    const output = formatStatus(withUnclassified);
    expect(output).toContain("UNCLASSIFIED ISSUES");
    expect(output).toContain("#72");
    expect(output).toContain("Investigate flaky logs");
  });

  it("renders DRAFT PRs section when present", () => {
    const withDrafts: RepoSummary = {
      ...summary,
      draftPRs: [
        { number: 53, title: "WIP settings panel", tags: [], author: "bob", comments: 2, age: "yesterday", status: "draft", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0, commented: 0 } },
      ],
    };

    const output = formatStatus(withDrafts);
    expect(output).toContain("DRAFT PRs");
    expect(output).toContain("#53");
    expect(output).toContain("WIP settings panel");
  });

  it("renders REPOSITORY HEALTH and PRIORITY SIGNALS sections when present", () => {
    const withHealth: RepoSummary = {
      ...summary,
      repositoryHealth: {
        openPRs: { total: 5, mergeReady: 2, changesRequested: 2, draft: 1 },
        reviewQueue: { waitingForYourReview: 2, oldestWaitingAge: "6h ago" },
        issuePipeline: { discussion: 4, voting: 1, readyToImplement: 3 },
        staleRisk: { prsOlderThan3Days: 1, issuesStaleOver24h: 2 },
      },
      prioritySignals: [
        { kind: "review-queue", score: 21, summary: "2 waiting, oldest 6h ago" },
        { kind: "implementation-gap", score: 16, summary: "3 ready issues, 1 active candidates" },
      ],
    };

    const output = formatStatus(withHealth);
    expect(output).toContain("REPOSITORY HEALTH");
    expect(output).toContain("Open PRs: 5 (2 merge-ready, 2 changes-requested, 1 draft)");
    expect(output).toContain("PRIORITY SIGNALS");
    expect(output).toContain("Highest pressure: review-queue (2 waiting, oldest 6h ago)");
    expect(output).toContain("Next pressure: implementation-gap (3 ready issues, 1 active candidates)");
  });

  it("omits Issue pipeline line when pipeline metrics are unavailable", () => {
    const withPartialHealth: RepoSummary = {
      ...summary,
      repositoryHealth: {
        openPRs: { total: 5, mergeReady: 2, changesRequested: 2, draft: 1 },
        reviewQueue: { waitingForYourReview: 2, oldestWaitingAge: "6h ago" },
        staleRisk: { prsOlderThan3Days: 1, issuesStaleOver24h: 2 },
      },
      prioritySignals: [{ kind: "review-queue", score: 21, summary: "2 waiting, oldest 6h ago" }],
      notes: [
        "Issue pipeline and implementation-gap metrics are omitted because default hivemoot phase labels were not detected.",
      ],
    };

    const output = formatStatus(withPartialHealth);
    expect(output).toContain("REPOSITORY HEALTH");
    expect(output).not.toContain("Issue pipeline:");
    expect(output).toContain("Issue pipeline and implementation-gap metrics are omitted");
  });
});

describe("DRIVE sections", () => {
  const driveSummary: RepoSummary = {
    repo: { owner: "hivemoot", repo: "colony" },
    currentUser: "alice",
    needsHuman: [],
    driveDiscussion: [
      { number: 80, title: "My Discussion", tags: ["phase:discussion"], author: "alice", comments: 3, age: "2 days ago" },
    ],
    driveImplementation: [
      { number: 61, title: "Alice PR", tags: [], author: "alice", comments: 0, age: "yesterday", status: "draft", checks: null, mergeable: null, review: { approvals: 0, changesRequested: 0, commented: 0 } },
      { number: 63, title: "Alice PR 2", tags: [], author: "alice", comments: 0, age: "just now", status: "changes-requested", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0, commented: 0 } },
    ],
    voteOn: [],
    discuss: [
      { number: 81, title: "Other Discussion", tags: ["discuss"], author: "bob", comments: 1, age: "yesterday" },
    ],
    implement: [],
    reviewPRs: [],
    draftPRs: [],
    addressFeedback: [
      { number: 60, title: "Bob PR", tags: [], author: "bob", comments: 0, age: "2 days ago", status: "changes-requested", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0, commented: 0 } },
    ],
    notifications: [],
    notes: [],
  };

  it("renders DRIVE THE DISCUSSION section", () => {
    const output = formatStatus(driveSummary);
    expect(output).toContain("DRIVE THE DISCUSSION");
    expect(output).toContain("#80");
    expect(output).toContain("My Discussion");
  });

  it("renders DRIVE THE IMPLEMENTATION section with PR metadata", () => {
    const output = formatStatus(driveSummary);
    expect(output).toContain("DRIVE THE IMPLEMENTATION");
    expect(output).toContain("#61");
    expect(output).toContain("#63");
    expect(output).toContain("status:");
  });

  it("places DRIVE sections before DISCUSS", () => {
    const output = formatStatus(driveSummary);
    const driveDiscIdx = output.indexOf("DRIVE THE DISCUSSION");
    const driveImplIdx = output.indexOf("DRIVE THE IMPLEMENTATION");
    const discussIdx = output.indexOf("DISCUSS ISSUES");
    const feedbackIdx = output.indexOf("ADDRESS FEEDBACK");

    expect(driveDiscIdx).toBeLessThan(driveImplIdx);
    expect(driveImplIdx).toBeLessThan(discussIdx);
    expect(discussIdx).toBeLessThan(feedbackIdx);
  });

  it("hides DRIVE sections when empty", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("DRIVE THE DISCUSSION");
    expect(output).not.toContain("DRIVE THE IMPLEMENTATION");
  });
});

describe("NEEDS HUMAN section", () => {
  it("renders NEEDS HUMAN section with issue metadata", () => {
    const withHuman: RepoSummary = {
      ...summary,
      needsHuman: [
        { number: 77, title: "Deploy approval needed", tags: ["needs:human", "ops"], author: "bot", comments: 1, age: "yesterday", assigned: "alice" },
      ],
    };
    const output = formatStatus(withHuman);
    expect(output).toContain("NEEDS HUMAN");
    expect(output).toContain("#77");
    expect(output).toContain("Deploy approval needed");
    expect(output).toContain("assigned:");
  });

  it("hides NEEDS HUMAN section when empty", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("NEEDS HUMAN");
  });

  it("places NEEDS HUMAN before DRIVE sections", () => {
    const withBoth: RepoSummary = {
      ...summary,
      needsHuman: [{ number: 77, title: "Blocked", tags: ["needs:human"], author: "bot", comments: 0, age: "yesterday" }],
      driveDiscussion: [{ number: 80, title: "Discussion", tags: [], author: "alice", comments: 0, age: "yesterday" }],
    };
    const output = formatStatus(withBoth);
    const humanIdx = output.indexOf("NEEDS HUMAN");
    const driveIdx = output.indexOf("DRIVE THE DISCUSSION");
    expect(humanIdx).toBeLessThan(driveIdx);
  });
});

describe("notes rendering", () => {
  it("renders notes as dim text at end of output", () => {
    const withNotes: RepoSummary = {
      ...summary,
      notes: ["Only the first 200 issues were fetched. Use --fetch-limit to increase."],
    };
    const output = formatStatus(withNotes);
    expect(output).toContain("Only the first 200 issues were fetched");
  });

  it("does not render notes section when notes array is empty", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("fetch-limit");
  });
});

describe("you: indicator on issue sections", () => {
  it("renders 'you: not voted' on voting issues with no participation", () => {
    const voteSummary: RepoSummary = {
      ...summary,
      voteOn: [{ number: 50, title: "Auth redesign", tags: ["phase:voting"], author: "bob", comments: 0, age: "3 days ago" }],
    };
    const output = formatStatus(voteSummary);
    expect(output).toContain("you:");
    expect(output).toContain("not voted");
  });

  it("renders 'you: voted 👍' on voting issues where user voted", () => {
    const voteSummary: RepoSummary = {
      ...summary,
      voteOn: [{ number: 50, title: "Auth redesign", tags: ["phase:voting"], author: "bob", comments: 0, age: "3 days ago", yourVote: "👍", yourVoteAge: "yesterday" }],
    };
    const output = formatStatus(voteSummary);
    expect(output).toContain("you:");
    expect(output).toContain("voted 👍");
    expect(output).toContain("yesterday");
  });

  it("renders 'you: commented, voted 👍' when both are present", () => {
    const voteSummary: RepoSummary = {
      ...summary,
      voteOn: [{ number: 50, title: "Auth", tags: ["vote"], author: "bob", comments: 1, age: "1 day", yourComment: "commented", yourCommentAge: "3h ago", yourVote: "👍", yourVoteAge: "yesterday" }],
    };
    const output = formatStatus(voteSummary);
    expect(output).toContain("commented (3h ago), voted 👍 (yesterday)");
  });

  it("renders 'you: commented, not voted' on voting issues where user commented but didn't vote", () => {
    const voteSummary: RepoSummary = {
      ...summary,
      voteOn: [{ number: 50, title: "Auth", tags: ["vote"], author: "bob", comments: 1, age: "1 day", yourComment: "commented", yourCommentAge: "3h ago" }],
    };
    const output = formatStatus(voteSummary);
    expect(output).toContain("commented (3h ago), not voted");
  });

  it("renders 'you: commented' on discuss issues where user commented", () => {
    const discSummary: RepoSummary = {
      ...summary,
      discuss: [{ number: 60, title: "API design", tags: ["discuss"], author: "bob", comments: 1, age: "1 day", yourComment: "commented", yourCommentAge: "5h ago" }],
    };
    const output = formatStatus(discSummary);
    expect(output).toContain("you:");
    expect(output).toContain("commented (5h ago)");
  });

  it("does not render 'you:' on discuss issues with no participation", () => {
    const discSummary: RepoSummary = {
      ...summary,
      discuss: [{ number: 60, title: "API design", tags: ["discuss"], author: "bob", comments: 0, age: "1 day" }],
    };
    const output = formatStatus(discSummary);
    // Check that there's no "you:" in the discuss section
    const discussSection = output.split("DISCUSS ISSUES")[1]?.split("──")[0] ?? "";
    expect(discussSection).not.toContain("you:");
  });

  it("renders 'you: commented' on implement issues where user commented", () => {
    const implSummary: RepoSummary = {
      ...summary,
      implement: [{ number: 70, title: "Build feature", tags: [], author: "bob", comments: 1, age: "1 day", yourComment: "commented", yourCommentAge: "2h ago" }],
    };
    const output = formatStatus(implSummary);
    expect(output).toContain("you:");
    expect(output).toContain("commented (2h ago)");
  });

  it("does not render 'you:' on implement issues with no participation", () => {
    const output = formatStatus(summary);
    // #45 by bob with no yourComment — should not have "you:" in its metadata
    const implementSection = output.split("READY TO IMPLEMENT")[1]?.split("REVIEW")[0] ?? "";
    // Only the star marker for alice's item should have "you" — as "(you)" in the author field
    expect(implementSection).not.toMatch(/\byou:.*not voted/);
  });
});

describe("unread notification indicator", () => {
  it("shows yellow dot for unread items", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      implement: [
        { number: 45, title: "User Dashboard", tags: ["enhancement"], author: "bob", comments: 0, age: "3 days ago", unread: true, unreadReason: "comment", unreadAge: "2h ago" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toContain("●");
    expect(output).toMatch(/#45.*●/);
  });

  it("does not show yellow dot for read items", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("●");
  });

  it("shows yellow dot alongside star for authored unread items", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      implement: [
        { number: 47, title: "Notifications", tags: [], author: "alice", comments: 0, age: "yesterday", unread: true, unreadReason: "mention", unreadAge: "30m ago" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toMatch(/★.*#47.*●/);
  });

  it("shows yellow dot on PR items", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      reviewPRs: [
        { number: 49, title: "Search", tags: ["feature"], author: "carol", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0, commented: 0 }, unread: true, unreadReason: "review_requested", unreadAge: "1h ago" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toMatch(/#49.*●/);
  });

  it("shows yellow dot on vote items", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      voteOn: [
        { number: 50, title: "Auth redesign", tags: ["vote"], author: "bob", comments: 0, age: "3 days ago", unread: true, unreadReason: "comment", unreadAge: "5h ago" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toMatch(/#50.*●/);
  });

  it("renders 'new: reason (age)' on metadata line for unread issues", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      implement: [
        { number: 45, title: "User Dashboard", tags: [], author: "bob", comments: 0, age: "3 days ago", unread: true, unreadReason: "mention", unreadAge: "2h ago" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toContain("new:");
    expect(output).toContain("mention (2h ago)");
  });

  it("renders 'new: reason (age)' on metadata line for unread PRs", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      reviewPRs: [
        { number: 49, title: "Search", tags: [], author: "carol", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0, commented: 0 }, unread: true, unreadReason: "review_requested", unreadAge: "1h ago" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toContain("new:");
    expect(output).toContain("review_requested (1h ago)");
  });

  it("does not render 'new:' for items without notifications", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("new:");
  });
});

describe("NOTIFICATIONS section", () => {
  it("renders NOTIFICATIONS section first when notifications exist", () => {
    const notifSummary: RepoSummary = {
      ...summary,
      notifications: [
        { number: 42, title: "Fix dashboard", itemType: "Issue", threadId: "T42", reason: "comment", timestamp: "2025-06-15T10:00:00Z", age: "2h ago", ackKey: "T42:2025-06-15T10:00:00Z", section: "implement" },
        { number: 49, title: "Add search", itemType: "PullRequest", threadId: "T49", reason: "review_requested", timestamp: "2025-06-15T11:00:00Z", age: "1h ago", ackKey: "T49:2025-06-15T11:00:00Z", section: "reviewPRs" },
      ],
    };
    const output = formatStatus(notifSummary);
    expect(output).toContain("NOTIFICATIONS");
    expect(output).toContain("(2)");
    expect(output).toContain("Issue #42");
    expect(output).toContain("Fix dashboard");
    expect(output).toContain("comment");
    expect(output).toContain("T42:2025-06-15T10:00:00Z");
    expect(output).toContain("PR #49");
    expect(output).toContain("review_requested");
    // NOTIFICATIONS should appear before other sections
    const notifIdx = output.indexOf("NOTIFICATIONS");
    const voteIdx = output.indexOf("VOTE ON ISSUES");
    expect(notifIdx).toBeLessThan(voteIdx);
  });

  it("hides NOTIFICATIONS section when empty", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("NOTIFICATIONS");
  });

  it("respects limit in NOTIFICATIONS section", () => {
    const notifSummary: RepoSummary = {
      ...summary,
      notifications: [
        // pre-sorted newest-first by buildSummary()
        { number: 88, title: "Add search", threadId: "T88", reason: "review_requested", timestamp: "2025-06-15T11:00:00Z", age: "1h ago", ackKey: "T88:2025-06-15T11:00:00Z", section: "reviewPRs" },
        { number: 42, title: "Fix dashboard", threadId: "T42", reason: "comment", timestamp: "2025-06-15T10:00:00Z", age: "2h ago", ackKey: "T42:2025-06-15T10:00:00Z", section: "implement" },
      ],
    };
    const output = formatStatus(notifSummary, 1);
    expect(output).toContain("#88");
    expect(output).not.toContain("#42");
    expect(output).toContain("... 1 more");
  });

  it("preserves pre-sorted newest-first order from builder", () => {
    const notifSummary: RepoSummary = {
      ...summary,
      notifications: [
        // buildSummary() sorts newest-first; formatter preserves that order
        { number: 49, title: "Newer PR", threadId: "T49", reason: "review_requested", timestamp: "2025-06-15T11:00:00Z", age: "1h ago", ackKey: "T49:2025-06-15T11:00:00Z", section: "reviewPRs" },
        { number: 42, title: "Older issue", threadId: "T42", reason: "comment", timestamp: "2025-06-15T10:00:00Z", age: "2h ago", ackKey: "T42:2025-06-15T10:00:00Z", section: "implement" },
      ],
    };

    const output = formatStatus(notifSummary);
    expect(output.indexOf("#49")).toBeLessThan(output.indexOf("#42"));
  });

  it("renders NOTIFICATIONS before NEEDS HUMAN", () => {
    const withBoth: RepoSummary = {
      ...summary,
      needsHuman: [{ number: 77, title: "Blocked", tags: ["needs:human"], author: "bot", comments: 0, age: "yesterday" }],
      notifications: [
        { number: 42, title: "Fix dashboard", threadId: "T42", reason: "comment", timestamp: "2025-06-15T10:00:00Z", age: "2h ago", ackKey: "T42:2025-06-15T10:00:00Z", section: "implement" },
      ],
    };
    const output = formatStatus(withBoth);
    const notifIdx = output.indexOf("NOTIFICATIONS");
    const humanIdx = output.indexOf("NEEDS HUMAN");
    expect(notifIdx).toBeLessThan(humanIdx);
  });
});

describe("UNACKED MENTIONS section", () => {
  it("renders UNACKED MENTIONS section when unacked mentions exist", () => {
    const withUnacked: RepoSummary = {
      ...summary,
      unackedMentions: [
        { number: 18, title: "Agents don't always follow up", itemType: "Issue", threadId: "T18", reason: "mention", timestamp: "2025-06-15T11:00:00Z", age: "1h ago", ackKey: "T18:2025-06-15T11:00:00Z", section: "unackedMentions" },
      ],
    };

    const output = formatStatus(withUnacked);
    expect(output).toContain("UNACKED MENTIONS");
    expect(output).toContain("Issue #18");
    expect(output).toContain("mention");
    expect(output).toContain("T18:2025-06-15T11:00:00Z");
  });

  it("hides UNACKED MENTIONS section when empty", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("UNACKED MENTIONS");
  });

  it("respects limit in UNACKED MENTIONS section", () => {
    const withUnacked: RepoSummary = {
      ...summary,
      unackedMentions: [
        { number: 22, title: "Newer mention", itemType: "Issue", threadId: "T22", reason: "mention", timestamp: "2025-06-15T12:00:00Z", age: "30m ago", ackKey: "T22:2025-06-15T12:00:00Z", section: "unackedMentions" },
        { number: 18, title: "Older mention", itemType: "Issue", threadId: "T18", reason: "mention", timestamp: "2025-06-15T11:00:00Z", age: "1h ago", ackKey: "T18:2025-06-15T11:00:00Z", section: "unackedMentions" },
      ],
    };

    const output = formatStatus(withUnacked, 1);
    expect(output).toContain("#22");
    expect(output).not.toContain("#18");
    expect(output).toContain("... 1 more");
  });
});

describe("ackKey on metadata line", () => {
  it("renders 'ack:' on metadata line for unread items with ackKey", () => {
    const unreadSummary: RepoSummary = {
      ...summary,
      implement: [
        { number: 45, title: "User Dashboard", tags: [], author: "bob", comments: 0, age: "3 days ago", unread: true, unreadReason: "mention", unreadAge: "2h ago", ackKey: "T45:2025-06-15T10:00:00Z" },
      ],
    };
    const output = formatStatus(unreadSummary);
    expect(output).toContain("ack:");
    expect(output).toContain("T45:2025-06-15T10:00:00Z");
  });

  it("does not render 'ack:' when ackKey is not set", () => {
    const output = formatStatus(summary);
    expect(output).not.toContain("ack:");
  });
});

describe("formatRole()", () => {
  it("includes onboarding section when provided", () => {
    const output = formatRole("engineer", role, "hivemoot/colony", "Read CONTRIBUTING.md for the workflow.");
    expect(output).toContain("ONBOARDING:");
    expect(output).toContain("Read CONTRIBUTING.md for the workflow.");
    const onboardingIdx = output.indexOf("ONBOARDING:");
    const roleIdx = output.indexOf("ROLE —");
    expect(onboardingIdx).toBeLessThan(roleIdx);
  });

  it("omits onboarding section when not provided", () => {
    const output = formatRole("engineer", role, "hivemoot/colony");
    expect(output).not.toContain("ONBOARDING:");
  });
});

describe("formatRoles()", () => {
  it("lists roles with descriptions", () => {
    const output = formatRoles(teamConfig, "hivemoot/colony");
    expect(output).toContain("ROLES");
    expect(output).toContain("hivemoot/colony");
    expect(output).toContain("engineer");
    expect(output).toContain("Implements features");
    expect(output).toContain("tech_lead");
    expect(output).toContain("Reviews architecture");
  });

  it("includes team name if set", () => {
    const output = formatRoles(teamConfig, "hivemoot/colony");
    expect(output).toContain("colony");
  });
});
