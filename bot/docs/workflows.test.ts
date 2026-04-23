import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const VOTING_REACTIONS = ["👍", "👎", "😕", "👀"] as const;

function readFixture(relativePath: string): string {
  return readFileSync(resolve(__dirname, relativePath), "utf-8");
}

describe("doc-contract: voting signals", () => {
  const readme = readFixture("../README.md");
  const workflows = readFixture("./WORKFLOWS.md");

  describe("README.md", () => {
    it.each(VOTING_REACTIONS)(
      "should document the %s voting reaction",
      (emoji) => {
        expect(readme).toContain(emoji);
      },
    );

    it("should document needs:human escalation", () => {
      expect(readme).toMatch(/needs[:\-]human/i);
    });
  });

  describe("docs/WORKFLOWS.md", () => {
    it.each(VOTING_REACTIONS)(
      "should document the %s voting reaction",
      (emoji) => {
        expect(workflows).toContain(emoji);
      },
    );

    it("should document needs:human escalation outcome", () => {
      expect(workflows).toMatch(/needs[:\-]human/i);
    });

    it("should state that only the four voting reactions are counted", () => {
      const countedSentence =
        workflows.match(/only[^.\n]*counted/i)?.[0] ?? "";

      expect(countedSentence).not.toBe("");

      for (const emoji of VOTING_REACTIONS) {
        expect(countedSentence).toContain(emoji);
      }
    });
  });
});
