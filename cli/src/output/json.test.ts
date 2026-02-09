import { describe, it, expect } from "vitest";
import { jsonBuzz, jsonStatus, jsonRoles } from "./json.js";
import type { RepoSummary, RoleConfig, TeamConfig } from "../config/types.js";

const summary: RepoSummary = {
  repo: { owner: "hivemoot", repo: "colony" },
  currentUser: "alice",
  needsHuman: [],
  driveDiscussion: [],
  driveImplementation: [],
  voteOn: [{ number: 50, title: "Auth redesign", tags: ["vote", "security"], author: "alice", comments: 2, age: "3 days ago" }],
  discuss: [{ number: 52, title: "API versioning", tags: ["discuss"], author: "bob", comments: 5, age: "yesterday" }],
  implement: [{ number: 45, title: "User Dashboard", tags: ["enhancement"], author: "carol", comments: 0, age: "3 days ago" }],
  reviewPRs: [{ number: 49, title: "Search", tags: ["feature"], author: "dave", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 } }],
  addressFeedback: [{ number: 53, title: "Design system", tags: [], author: "eve", comments: 0, age: "just now", status: "draft", checks: "failing", mergeable: null, review: { approvals: 0, changesRequested: 0 } }],
  notes: [],
};

const role: RoleConfig = {
  description: "Implements features",
  instructions: "You are a senior engineer.",
};

const teamConfig: TeamConfig = {
  name: "colony",
  roles: {
    engineer: { description: "Implements features", instructions: "Do stuff" },
    tech_lead: { description: "Reviews architecture", instructions: "Review stuff" },
  },
};

describe("jsonBuzz()", () => {
  it("returns valid JSON with role and summary", () => {
    const result = JSON.parse(jsonBuzz("engineer", role, summary));
    expect(result.role.name).toBe("engineer");
    expect(result.role.description).toBe("Implements features");
    expect(result.role.instructions).toBe("You are a senior engineer.");
    expect(result.summary.repo).toBe("hivemoot/colony");
    expect(result.summary.voteOn).toHaveLength(1);
    expect(result.summary.needsHuman).toHaveLength(0);
  });
});

describe("jsonStatus()", () => {
  it("returns valid JSON with summary only", () => {
    const result = JSON.parse(jsonStatus(summary));
    expect(result.repo).toBe("hivemoot/colony");
    expect(result.voteOn).toHaveLength(1);
    expect(result.implement).toHaveLength(1);
    expect(result.reviewPRs).toHaveLength(1);
    expect(result).not.toHaveProperty("role");
  });

  it("includes tags in summary items", () => {
    const result = JSON.parse(jsonStatus(summary));
    expect(result.voteOn[0].tags).toEqual(["vote", "security"]);
    expect(result.implement[0].tags).toEqual(["enhancement"]);
    expect(result.addressFeedback[0].tags).toEqual([]);
  });

  it("includes structured fields instead of detail string", () => {
    const result = JSON.parse(jsonStatus(summary));
    // Verify issue items have comments/age
    expect(result.voteOn[0].comments).toBe(2);
    expect(result.voteOn[0].age).toBe("3 days ago");
    expect(result.voteOn[0]).not.toHaveProperty("detail");

    // Verify PR items have status/checks/mergeable/review
    expect(result.reviewPRs[0].status).toBe("pending");
    expect(result.reviewPRs[0].checks).toBe("passing");
    expect(result.reviewPRs[0].mergeable).toBe("clean");
    expect(result.reviewPRs[0].review).toEqual({ approvals: 0, changesRequested: 0 });
    expect(result.reviewPRs[0]).not.toHaveProperty("detail");

    // Verify addressFeedback items
    expect(result.addressFeedback[0].status).toBe("draft");
    expect(result.addressFeedback[0].checks).toBe("failing");
  });
});

describe("notes in JSON output", () => {
  it("includes notes in jsonBuzz output", () => {
    const withNotes: RepoSummary = { ...summary, notes: ["truncation warning"] };
    const result = JSON.parse(jsonBuzz("engineer", role, withNotes));
    expect(result.summary.notes).toEqual(["truncation warning"]);
  });

  it("includes notes in jsonStatus output", () => {
    const withNotes: RepoSummary = { ...summary, notes: ["truncation warning"] };
    const result = JSON.parse(jsonStatus(withNotes));
    expect(result.notes).toEqual(["truncation warning"]);
  });

  it("includes empty notes array when no notes", () => {
    const result = JSON.parse(jsonStatus(summary));
    expect(result.notes).toEqual([]);
  });
});

describe("unread notification fields in JSON", () => {
  const unreadSummary: RepoSummary = {
    ...summary,
    implement: [
      { number: 45, title: "User Dashboard", tags: ["enhancement"], author: "carol", comments: 0, age: "3 days ago", unread: true, unreadReason: "comment", unreadAge: "2h ago" },
    ],
    reviewPRs: [
      { number: 49, title: "Search", tags: ["feature"], author: "dave", comments: 0, age: "2 days ago", status: "pending", checks: "passing", mergeable: "clean", review: { approvals: 0, changesRequested: 0 }, unread: true, unreadReason: "review_requested", unreadAge: "1h ago" },
    ],
  };

  it("includes unread, unreadReason, and unreadAge in jsonStatus when set", () => {
    const result = JSON.parse(jsonStatus(unreadSummary));
    expect(result.implement[0].unread).toBe(true);
    expect(result.implement[0].unreadReason).toBe("comment");
    expect(result.implement[0].unreadAge).toBe("2h ago");
    expect(result.reviewPRs[0].unread).toBe(true);
    expect(result.reviewPRs[0].unreadReason).toBe("review_requested");
    expect(result.reviewPRs[0].unreadAge).toBe("1h ago");
  });

  it("includes unread, unreadReason, and unreadAge in jsonBuzz when set", () => {
    const result = JSON.parse(jsonBuzz("engineer", role, unreadSummary));
    expect(result.summary.implement[0].unread).toBe(true);
    expect(result.summary.implement[0].unreadReason).toBe("comment");
    expect(result.summary.implement[0].unreadAge).toBe("2h ago");
    expect(result.summary.reviewPRs[0].unread).toBe(true);
    expect(result.summary.reviewPRs[0].unreadReason).toBe("review_requested");
    expect(result.summary.reviewPRs[0].unreadAge).toBe("1h ago");
  });

  it("omits unread fields from items without notifications", () => {
    const result = JSON.parse(jsonStatus(summary));
    expect(result.implement[0]).not.toHaveProperty("unread");
    expect(result.implement[0]).not.toHaveProperty("unreadReason");
    expect(result.implement[0]).not.toHaveProperty("unreadAge");
    expect(result.voteOn[0]).not.toHaveProperty("unread");
    expect(result.reviewPRs[0]).not.toHaveProperty("unread");
  });
});

describe("jsonRoles()", () => {
  it("returns valid JSON with roles array", () => {
    const result = JSON.parse(jsonRoles(teamConfig));
    expect(result.roles).toHaveLength(2);
    expect(result.roles[0].name).toBe("engineer");
    expect(result.roles[0].description).toBe("Implements features");
    expect(result.roles[1].name).toBe("tech_lead");
  });
});
