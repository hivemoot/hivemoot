import { describe, it, expect } from "vitest";
import { formatBuzz, formatStatus, formatRoles } from "./formatter.js";
import type { RepoSummary, RoleConfig, TeamConfig } from "../config/types.js";

const summary: RepoSummary = {
  repo: { owner: "hivemoot", repo: "colony" },
  currentUser: "alice",
  driveDiscussion: [],
  driveImplementation: [],
  voteOn: [{ number: 50, title: "Auth redesign", tags: ["vote", "security"], author: "alice", comments: 2, age: "3 days ago" }],
  discuss: [],
  implement: [
    { number: 45, title: "User Dashboard", tags: ["enhancement"], author: "bob", comments: 0, age: "3 days ago" },
    { number: 47, title: "Notifications", tags: [], author: "alice", comments: 0, age: "yesterday" },
  ],
  reviewPRs: [{ number: 49, title: "Search", tags: ["feature"], author: "carol", comments: 0, age: "2 days ago", status: "waiting", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } }],
  addressFeedback: [],
  alerts: [{ icon: "\u26a0\ufe0f", message: "PR #49 waiting on review 2 days" }],
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

  it("includes REQUIRES YOUR ATTENTION section at the top", () => {
    const output = formatBuzz("engineer", role, summary);
    expect(output).toContain("REQUIRES YOUR ATTENTION");
    expect(output).toContain("PR #49 waiting on review 2 days");
    // Attention section should appear before VOTE ON ISSUES
    const attentionIdx = output.indexOf("REQUIRES YOUR ATTENTION");
    const voteIdx = output.indexOf("VOTE ON ISSUES");
    expect(attentionIdx).toBeLessThan(voteIdx);
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
    expect(output).toContain("0 approved, 0 changes-requested");
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
      driveDiscussion: [],
      driveImplementation: [],
      voteOn: [],
      discuss: [],
      implement: [],
      reviewPRs: [],
      addressFeedback: [],
      alerts: [],
      notes: [],
    };
    const output = formatStatus(empty);
    expect(output).toContain("No open issues or PRs");
  });

  it("renders implement items with assigned key", () => {
    const output = formatStatus(summary);
    expect(output).toContain("assigned:");
  });
});

describe("DRIVE sections", () => {
  const driveSummary: RepoSummary = {
    repo: { owner: "hivemoot", repo: "colony" },
    currentUser: "alice",
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
    addressFeedback: [
      { number: 60, title: "Bob PR", tags: [], author: "bob", comments: 0, age: "2 days ago", status: "changes-requested", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } },
    ],
    alerts: [{ icon: "\u26a0\ufe0f", message: "test alert" }],
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

  it("places DRIVE sections after ATTENTION and before VOTE/DISCUSS", () => {
    const output = formatStatus(driveSummary);
    const attentionIdx = output.indexOf("REQUIRES YOUR ATTENTION");
    const driveDiscIdx = output.indexOf("DRIVE THE DISCUSSION");
    const driveImplIdx = output.indexOf("DRIVE THE IMPLEMENTATION");
    const discussIdx = output.indexOf("DISCUSS ISSUES");
    const feedbackIdx = output.indexOf("ADDRESS FEEDBACK");

    expect(attentionIdx).toBeLessThan(driveDiscIdx);
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
