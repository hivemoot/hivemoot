import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRoot(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function extractEngineMajor(packageJson: string): string {
  const parsed = JSON.parse(packageJson) as { engines?: { node?: string } };
  const nodeRange = parsed.engines?.node;
  if (!nodeRange) {
    throw new Error("package.json engines.node is missing");
  }
  const match = nodeRange.match(/\d+/);
  if (!match) {
    throw new Error(`Could not parse Node major from engines.node: ${nodeRange}`);
  }
  return match[0];
}

describe("node runtime contract", () => {
  const packageJson = readRoot("package.json");
  const engineMajor = extractEngineMajor(packageJson);

  it("matches .nvmrc major with package engines major", () => {
    const nvmrc = readRoot(".nvmrc").trim();
    expect(nvmrc).toBe(engineMajor);
  });

  it("pins setup-node to package engines major across workflows", () => {
    const workflows = [
      ".github/workflows/ci.yml",
      ".github/workflows/dependency-audit.yml",
      ".github/workflows/cleanup-stale-prs.yml",
      ".github/workflows/close-discussions.yml",
      ".github/workflows/reconcile-pr-notifications.yml",
      ".github/workflows/reconcile-merge-ready.yml",
      ".github/workflows/daily-standup.yml",
    ];

    for (const workflow of workflows) {
      const content = readRoot(workflow);
      const matches = [...content.matchAll(/node-version:\s*"(\d+)"/g)];
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches) {
        expect(match[1]).toBe(engineMajor);
      }
    }
  });

  it("documents the same Node major in contributor docs", () => {
    const contributing = readRoot("CONTRIBUTING.md");
    const readme = readRoot("README.md");

    expect(contributing).toContain(`Node.js ${engineMajor}.x and npm`);
    expect(readme).toContain(`Node.js ${engineMajor}.x`);
    expect(readme).toContain("nvm use");
  });
});
