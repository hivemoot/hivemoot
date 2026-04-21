import { describe, it, expect } from "vitest";
import { parseGoalProgress } from "./goals.js";

describe("parseGoalProgress", () => {
  it("counts checked and unchecked task items", () => {
    const body = `
## Tasks
- [x] hivemoot/hivemoot-agent#330 — Plugin infrastructure
- [x] hivemoot/apiary#25 — Fleet config support
- [ ] hivemoot/colony#603 — Deploy to production
- [ ] Write documentation
`;
    const result = parseGoalProgress(body);
    expect(result.total).toBe(4);
    expect(result.complete).toBe(2);
  });

  it("returns zero counts for body with no task items", () => {
    const body = "Just a description with no checkboxes.";
    const result = parseGoalProgress(body);
    expect(result.total).toBe(0);
    expect(result.complete).toBe(0);
  });

  it("handles all tasks complete", () => {
    const body = "- [x] Task A\n- [x] Task B\n- [x] Task C\n";
    const result = parseGoalProgress(body);
    expect(result.total).toBe(3);
    expect(result.complete).toBe(3);
  });

  it("handles all tasks incomplete", () => {
    const body = "- [ ] Task A\n- [ ] Task B\n";
    const result = parseGoalProgress(body);
    expect(result.total).toBe(2);
    expect(result.complete).toBe(0);
  });

  it("is case-insensitive for checked marker", () => {
    const body = "- [X] uppercase checked\n- [x] lowercase checked\n- [ ] unchecked\n";
    const result = parseGoalProgress(body);
    expect(result.total).toBe(3);
    expect(result.complete).toBe(2);
  });

  it("ignores non-task lines even if they contain brackets", () => {
    const body = `
Some text [not a task] here
- [x] Real task one
- [ ] Real task two
A code block: - [ ] this is NOT a task (indented differently)
`;
    const result = parseGoalProgress(body);
    expect(result.total).toBe(2);
    expect(result.complete).toBe(1);
  });

  it("handles empty string body", () => {
    const result = parseGoalProgress("");
    expect(result.total).toBe(0);
    expect(result.complete).toBe(0);
  });
});
