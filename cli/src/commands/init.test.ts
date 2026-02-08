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
});
