import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const README_PATH = new URL("../README.md", import.meta.url);

function readReadme(): string {
  return readFileSync(README_PATH, "utf8");
}

function extractSection(readme: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(`## ${escapedHeading}\\n\\n([\\s\\S]*?)(?:\\n## |$)`);
  const match = readme.match(sectionPattern);

  if (!match) {
    throw new Error(`Could not find section: ${heading}`);
  }

  return match[1];
}

describe("README troubleshooting contract", () => {
  it("documents first-run recovery around the actual webhook health check", () => {
    const troubleshooting = extractSection(readReadme(), "Troubleshooting First Run");

    expect(troubleshooting).toContain("/api/github/webhooks");
    expect(troubleshooting).toContain('"status":"ok"');
    expect(troubleshooting).toContain('"status":"misconfigured"');
    expect(troubleshooting).toContain("APP_ID");
    expect(troubleshooting).toContain("PRIVATE_KEY");
    expect(troubleshooting).toContain("APP_PRIVATE_KEY");
    expect(troubleshooting).toContain("WEBHOOK_SECRET");
  });

  it("documents the operator recovery path and success signal", () => {
    const troubleshooting = extractSection(readReadme(), "Troubleshooting First Run");

    expect(troubleshooting).toContain("@hivemoot /doctor");
    expect(troubleshooting).toContain("hivemoot:discussion");
    expect(troubleshooting).toContain("bot welcome comment");
  });
});
