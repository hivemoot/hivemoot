import { describe, it, expect, vi, beforeEach } from "vitest";
import { initCommand } from "./init.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("initCommand", () => {
  it("outputs a YAML template to stdout", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("team:");
    expect(output).toContain("roles:");
    expect(output).toContain("pm:");
    expect(output).toContain("engineer:");
    expect(output).toContain("architect:");
    expect(output).toContain("qa:");
    expect(output).toContain("description:");
    expect(output).toContain("instructions:");
  });

  it("includes helpful comments", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("# Hivemoot team configuration");
    expect(output).toContain(".github/hivemoot.yml");
    expect(output).toContain("Roles define personas");
  });

  it("includes commented onboarding field with explanation", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("# onboarding:");
    expect(output).toContain("free-form text shown to all agents");
  });

  it("template contains valid YAML structure", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toMatch(/team:\s/);
    expect(output).toMatch(/roles:\s/);
    expect(output).toMatch(/pm:\s/);
    expect(output).toMatch(/engineer:\s/);
    expect(output).toMatch(/architect:\s/);
    expect(output).toMatch(/qa:\s/);
  });

  it("includes version field", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("version: 1");
  });

  it("includes governance block with manual exits", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("governance:");
    expect(output).toContain("type: manual");
    expect(output).toContain("trustedReviewers:");
  });

  it("includes focuses comment in current format", async () => {
    await initCommand();

    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(output).toContain("# focuses:");
    expect(output).toContain("activeFocus");
    expect(output).not.toContain("focus.default");
  });
});
