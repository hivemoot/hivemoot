import { describe, it, expect } from "vitest";
import {
  getIssuePriority,
  hasAnyPriorityLabel,
  getPriorityLabelName,
  type IssuePriority,
  type IssueWithLabels,
} from "./priority.js";
import { PRIORITY_LABELS } from "../config.js";

/**
 * Tests for Priority Label Utilities
 *
 * Verifies:
 * - Priority detection from issue labels
 * - Handling of both string[] and object[] label formats
 * - Priority level mapping
 * - Edge cases (no priority, multiple priorities)
 */

describe("getIssuePriority", () => {
  it("should return 'high' for high priority label", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: PRIORITY_LABELS.HIGH }, { name: "bug" }],
    };
    expect(getIssuePriority(issue)).toBe("high");
  });

  it("should return 'medium' for medium priority label", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: PRIORITY_LABELS.MEDIUM }, { name: "feature" }],
    };
    expect(getIssuePriority(issue)).toBe("medium");
  });

  it("should return 'low' for low priority label", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: PRIORITY_LABELS.LOW }, { name: "enhancement" }],
    };
    expect(getIssuePriority(issue)).toBe("low");
  });

  it("should return undefined when no priority label present", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: "bug" }, { name: "good-first-issue" }],
    };
    expect(getIssuePriority(issue)).toBeUndefined();
  });

  it("should return undefined for empty labels array", () => {
    const issue: IssueWithLabels = {
      labels: [],
    };
    expect(getIssuePriority(issue)).toBeUndefined();
  });

  it("should handle string array format for labels", () => {
    const issue: IssueWithLabels = {
      labels: [PRIORITY_LABELS.HIGH, "bug", "critical"],
    };
    expect(getIssuePriority(issue)).toBe("high");
  });

  it("should handle mixed object and string labels", () => {
    const issue: IssueWithLabels = {
      labels: ["bug", { name: PRIORITY_LABELS.MEDIUM }],
    };
    expect(getIssuePriority(issue)).toBe("medium");
  });

  it("should return highest priority when multiple priority labels present", () => {
    // This tests current behavior - high is checked first
    const issue: IssueWithLabels = {
      labels: [
        { name: PRIORITY_LABELS.HIGH },
        { name: PRIORITY_LABELS.LOW },
      ],
    };
    expect(getIssuePriority(issue)).toBe("high");
  });

  it("should handle medium priority when high is not present but medium and low are", () => {
    const issue: IssueWithLabels = {
      labels: [
        { name: PRIORITY_LABELS.MEDIUM },
        { name: PRIORITY_LABELS.LOW },
      ],
    };
    expect(getIssuePriority(issue)).toBe("medium");
  });
});

describe("hasAnyPriorityLabel", () => {
  it("should return true when high priority label present", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: PRIORITY_LABELS.HIGH }],
    };
    expect(hasAnyPriorityLabel(issue)).toBe(true);
  });

  it("should return true when medium priority label present", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: PRIORITY_LABELS.MEDIUM }],
    };
    expect(hasAnyPriorityLabel(issue)).toBe(true);
  });

  it("should return true when low priority label present", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: PRIORITY_LABELS.LOW }],
    };
    expect(hasAnyPriorityLabel(issue)).toBe(true);
  });

  it("should return false when no priority label present", () => {
    const issue: IssueWithLabels = {
      labels: [{ name: "bug" }, { name: "enhancement" }],
    };
    expect(hasAnyPriorityLabel(issue)).toBe(false);
  });

  it("should return false for empty labels array", () => {
    const issue: IssueWithLabels = {
      labels: [],
    };
    expect(hasAnyPriorityLabel(issue)).toBe(false);
  });
});

describe("getPriorityLabelName", () => {
  it("should return high priority label name for 'high'", () => {
    expect(getPriorityLabelName("high")).toBe(PRIORITY_LABELS.HIGH);
  });

  it("should return medium priority label name for 'medium'", () => {
    expect(getPriorityLabelName("medium")).toBe(PRIORITY_LABELS.MEDIUM);
  });

  it("should return low priority label name for 'low'", () => {
    expect(getPriorityLabelName("low")).toBe(PRIORITY_LABELS.LOW);
  });

  it("should return correct label names matching config constants", () => {
    expect(getPriorityLabelName("high")).toBe("hivemoot:high-priority");
    expect(getPriorityLabelName("medium")).toBe("hivemoot:medium-priority");
    expect(getPriorityLabelName("low")).toBe("hivemoot:low-priority");
  });
});
