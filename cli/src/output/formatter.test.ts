import { describe, it, expect } from "vitest";
import { formatBuzz, formatStatus, formatRoles } from "./formatter.js";
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
  reviewPRs: [{ number: 49, title: "Search", tags: ["feature"], author: "carol", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } }],
  draftPRs: [],
  addressFeedback: [],
  unclassified: [],
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
        { number: 53, title: "WIP settings panel", tags: [], author: "bob", comments: 2, age: "yesterday", status: "draft", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } },
      ],
    };

    const output = formatStatus(withDrafts);
    expect(output).toContain("DRAFT PRs");
    expect(output).toContain("#53");
    expect(output).toContain("WIP settings panel");
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
      { number: 61, title: "Alice PR", tags: [], author: "alice", comments: 0, age: "yesterday", status: "draft", checks: null, mergeable: null, review: { approvals: 0, changesRequested: 0 } },
      { number: 63, title: "Alice PR 2", tags: [], author: "alice", comments: 0, age: "just now", status: "changes-requested", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } },
    ],
    voteOn: [],
    discuss: [
      { number: 81, title: "Other Discussion", tags: ["discuss"], author: "bob", comments: 1, age: "yesterday" },
    ],
    implement: [],
    reviewPRs: [],
    draftPRs: [],
    addressFeedback: [
      { number: 60, title: "Bob PR", tags: [], author: "bob", comments: 0, age: "2 days ago", status: "changes-requested", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } },
    ],
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
        { number: 49, title: "Search", tags: ["feature"], author: "carol", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 }, unread: true, unreadReason: "review_requested", unreadAge: "1h ago" },
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
        { number: 49, title: "Search", tags: [], author: "carol", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 }, unread: true, unreadReason: "review_requested", unreadAge: "1h ago" },
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
