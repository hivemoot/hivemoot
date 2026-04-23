/**
 * Priority Label Utilities
 *
 * Helpers for detecting and working with priority labels on issues.
 */

import { PRIORITY_LABELS } from "../config.js";

export type IssuePriority = "high" | "medium" | "low";

export interface LabelLike {
  name: string;
}

export interface IssueWithLabels {
  labels: LabelLike[] | string[];
}

/**
 * Extract priority from issue labels.
 * Returns the priority level if a priority label is present, undefined otherwise.
 */
export function getIssuePriority(issue: IssueWithLabels): IssuePriority | undefined {
  const labelNames = issue.labels.map((l) => (typeof l === "string" ? l : l.name));

  if (labelNames.includes(PRIORITY_LABELS.HIGH)) return "high";
  if (labelNames.includes(PRIORITY_LABELS.MEDIUM)) return "medium";
  if (labelNames.includes(PRIORITY_LABELS.LOW)) return "low";

  return undefined;
}

/**
 * Check if an issue has any priority label.
 */
export function hasAnyPriorityLabel(issue: IssueWithLabels): boolean {
  return getIssuePriority(issue) !== undefined;
}

/**
 * Get priority label name for a given priority level.
 */
export function getPriorityLabelName(priority: IssuePriority): string {
  switch (priority) {
    case "high":
      return PRIORITY_LABELS.HIGH;
    case "medium":
      return PRIORITY_LABELS.MEDIUM;
    case "low":
      return PRIORITY_LABELS.LOW;
  }
}
