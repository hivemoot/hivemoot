import { describe, it, expect } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  describe("recognized mentions", () => {
    it("should parse @hivemoot /vote", () => {
      const result = parseCommand("@hivemoot /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should parse @hivemoot /implement", () => {
      const result = parseCommand("@hivemoot /implement");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should not recognize @queen (real GitHub user, not a bot handle)", () => {
      expect(parseCommand("@queen /vote")).toBeNull();
      expect(parseCommand("@queen /implement")).toBeNull();
    });
  });

  describe("slashless commands (aliases)", () => {
    it("should parse @hivemoot vote (no slash)", () => {
      const result = parseCommand("@hivemoot vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should parse @hivemoot implement (no slash)", () => {
      const result = parseCommand("@hivemoot implement");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should parse @hivemoot preflight (no slash)", () => {
      const result = parseCommand("@hivemoot preflight");
      expect(result).toEqual({ verb: "preflight", freeText: undefined });
    });

    it("should parse @hivemoot squash (no slash)", () => {
      const result = parseCommand("@hivemoot squash");
      expect(result).toEqual({ verb: "squash", freeText: undefined });
    });

    it("should parse @hivemoot gather (no slash)", () => {
      const result = parseCommand("@hivemoot gather");
      expect(result).toEqual({ verb: "gather", freeText: undefined });
    });

    it("should capture free text with slashless command", () => {
      const result = parseCommand("@hivemoot implement security fix needs fast-track");
      expect(result).toEqual({ verb: "implement", freeText: "security fix needs fast-track" });
    });

    it("should be case-insensitive for slashless commands", () => {
      expect(parseCommand("@hivemoot Vote")).toEqual({ verb: "vote", freeText: undefined });
      expect(parseCommand("@hivemoot IMPLEMENT")).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should not match unknown verbs without a slash", () => {
      expect(parseCommand("@hivemoot please help")).toBeNull();
      expect(parseCommand("@hivemoot great work")).toBeNull();
      expect(parseCommand("@hivemoot thanks")).toBeNull();
    });

    it("should find slashless command on its own line in a larger comment", () => {
      const result = parseCommand("I think this is ready.\n\n@hivemoot implement");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should reject slashless command embedded mid-sentence", () => {
      expect(parseCommand("Let's ask @hivemoot implement this")).toBeNull();
    });
  });

  describe("case insensitivity", () => {
    it("should match @Hivemoot /Vote", () => {
      const result = parseCommand("@Hivemoot /Vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should match @HIVEMOOT /IMPLEMENT", () => {
      const result = parseCommand("@HIVEMOOT /IMPLEMENT");
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });
  });

  describe("free-text arguments", () => {
    it("should capture free text after verb", () => {
      const result = parseCommand("@hivemoot /implement security fix needs fast-track");
      expect(result).toEqual({ verb: "implement", freeText: "security fix needs fast-track" });
    });

    it("should capture free text with @mentions", () => {
      const result = parseCommand("@hivemoot /implement and co-author with @hivemoot-builder");
      expect(result).toEqual({ verb: "implement", freeText: "and co-author with @hivemoot-builder" });
    });

    it("should trim whitespace from free text", () => {
      const result = parseCommand("@hivemoot /vote   good idea   ");
      expect(result).toEqual({ verb: "vote", freeText: "good idea" });
    });
  });

  describe("command on its own line in larger comment", () => {
    it("should find command on its own line after other text", () => {
      const result = parseCommand("Hey team, I think we should proceed.\n\n@hivemoot /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should find command on indented line", () => {
      const result = parseCommand("Some context:\n  @hivemoot /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should reject command embedded mid-sentence", () => {
      expect(parseCommand("This looks good to me. @hivemoot /implement")).toBeNull();
    });

    it("should reject command embedded in prose", () => {
      expect(parseCommand("Text before @hivemoot /implement")).toBeNull();
    });
  });

  describe("code context handling", () => {
    it("should ignore commands inside inline code", () => {
      expect(parseCommand("Please run `@hivemoot /vote` later")).toBeNull();
    });

    it("should ignore commands inside fenced code blocks", () => {
      const body = "Example:\n```\n@hivemoot /vote\n```\nThat's how you do it.";
      expect(parseCommand(body)).toBeNull();
    });

    it("should ignore commands inside fenced code blocks with language", () => {
      const body = "```bash\n@hivemoot /vote\n```";
      expect(parseCommand(body)).toBeNull();
    });

    it("should still match commands outside code contexts", () => {
      const body = "Here is an example: `@hivemoot /vote`\n@hivemoot /implement";
      const result = parseCommand(body);
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should ignore slashless commands inside inline code", () => {
      expect(parseCommand("Use `@hivemoot vote` to start voting")).toBeNull();
    });

    it("should ignore slashless commands inside fenced code blocks", () => {
      const body = "```\n@hivemoot implement\n```";
      expect(parseCommand(body)).toBeNull();
    });
  });

  describe("non-matching inputs", () => {
    it("should return null for empty string", () => {
      expect(parseCommand("")).toBeNull();
    });

    it("should return null for regular comment", () => {
      expect(parseCommand("This is a regular comment")).toBeNull();
    });

    it("should return null for unrecognized mention", () => {
      expect(parseCommand("@someuser /vote")).toBeNull();
    });

    it("should return null for mention without slash command", () => {
      expect(parseCommand("@hivemoot please help")).toBeNull();
    });

    it("should return null for bare slash command without mention", () => {
      expect(parseCommand("/vote")).toBeNull();
    });

    it("should return null for mention without space before slash", () => {
      expect(parseCommand("@hivemoot/vote")).toBeNull();
    });
  });

  describe("whitespace handling", () => {
    it("should handle multiple spaces between mention and command", () => {
      const result = parseCommand("@hivemoot   /vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should handle tab between mention and command", () => {
      const result = parseCommand("@hivemoot\t/vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });

    it("should handle multiple spaces between mention and slashless command", () => {
      const result = parseCommand("@hivemoot   vote");
      expect(result).toEqual({ verb: "vote", freeText: undefined });
    });
  });

  describe("quoted reply handling", () => {
    it("should ignore commands inside GitHub-style quoted replies", () => {
      const body = "> @hivemoot /vote\nI disagree with this";
      expect(parseCommand(body)).toBeNull();
    });

    it("should ignore commands in indented quotes", () => {
      const body = "  > @hivemoot /vote\nI disagree with this";
      expect(parseCommand(body)).toBeNull();
    });

    it("should still match unquoted commands after quoted lines", () => {
      const body = "> @hivemoot /vote\nActually, let me do it.\n@hivemoot /implement";
      const result = parseCommand(body);
      expect(result).toEqual({ verb: "implement", freeText: undefined });
    });

    it("should ignore multi-line quoted blocks", () => {
      const body = "> @hivemoot /vote\n> More context here\nJust a reply";
      expect(parseCommand(body)).toBeNull();
    });

    it("should ignore slashless commands in quotes", () => {
      const body = "> @hivemoot vote\nI disagree";
      expect(parseCommand(body)).toBeNull();
    });
  });

  describe("multi-command comments", () => {
    it("should only match the first line-start command when multiple are on the same line", () => {
      // Second command is not at line start, so only the first matches
      const body = "@hivemoot /vote @hivemoot /implement";
      const result = parseCommand(body);
      expect(result).toEqual({ verb: "vote", freeText: "@hivemoot /implement" });
    });

    it("should match first command when multiple appear on separate lines", () => {
      const body = "@hivemoot /vote\n@hivemoot /implement";
      const result = parseCommand(body);
      expect(result).not.toBeNull();
      expect(result!.verb).toBe("vote");
    });
  });

  describe("slash vs slashless behavior", () => {
    it("should accept any verb with a slash (forwarded to handler for dispatch)", () => {
      const result = parseCommand("@hivemoot /unknowncmd");
      expect(result).toEqual({ verb: "unknowncmd", freeText: undefined });
    });

    it("should reject unknown verbs without a slash", () => {
      expect(parseCommand("@hivemoot unknowncmd")).toBeNull();
    });

    it("should produce identical results for slashed and slashless known verbs", () => {
      expect(parseCommand("@hivemoot /vote")).toEqual(parseCommand("@hivemoot vote"));
      expect(parseCommand("@hivemoot /implement")).toEqual(parseCommand("@hivemoot implement"));
      expect(parseCommand("@hivemoot /preflight")).toEqual(parseCommand("@hivemoot preflight"));
      expect(parseCommand("@hivemoot /squash")).toEqual(parseCommand("@hivemoot squash"));
      expect(parseCommand("@hivemoot /gather")).toEqual(parseCommand("@hivemoot gather"));
    });

    it("should produce identical results for slashed and slashless with free text", () => {
      expect(parseCommand("@hivemoot /vote sounds good")).toEqual(
        parseCommand("@hivemoot vote sounds good"),
      );
    });
  });
});
