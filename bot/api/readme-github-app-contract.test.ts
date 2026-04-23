import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const README_PATH = new URL("../README.md", import.meta.url);

function readReadme(): string {
  return readFileSync(README_PATH, "utf8");
}

function extractSection(readme: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(`## GitHub App Setup[\\s\\S]*?${escapedHeading}:\\n\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^\\n]*:|\\n## )`);
  const match = readme.match(sectionPattern);

  if (!match) {
    throw new Error(`Could not find section: ${heading}`);
  }

  return match[1];
}

function extractBullets(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

describe("README GitHub App setup contract", () => {
  it("documents all required GitHub App permissions", () => {
    const permissions = extractBullets(extractSection(readReadme(), "Permissions"));
    expect(permissions).toHaveLength(7);

    expect(permissions).toEqual(
      expect.arrayContaining([
        "Contents: Read & Write (required for onboarding PR file creation)",
        "Issues: Read & Write",
        "Pull Requests: Read & Write",
        "Discussions: Read & Write (required for standup discussion posting)",
        "Checks: Read (required for merge-readiness evaluation)",
        "Commit statuses: Read (required for legacy CI status integration)",
        "Metadata: Read",
      ]),
    );
  });

  it("documents all required webhook event subscriptions", () => {
    const events = extractBullets(extractSection(readReadme(), "Events"));
    expect(events).toHaveLength(9);

    expect(events).toEqual(
      expect.arrayContaining([
        "Issues (including labeled and unlabeled actions)",
        "Issue comments",
        "Installation",
        "Installation repositories",
        "Pull requests",
        "Pull request reviews",
        "Check suites",
        "Check runs",
        "Statuses",
      ]),
    );
  });
});
