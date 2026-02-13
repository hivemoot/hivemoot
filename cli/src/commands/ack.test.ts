import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../github/notifications.js", () => ({
  markNotificationRead: vi.fn(),
}));

vi.mock("../watch/state.js", () => ({
  appendAck: vi.fn(),
}));

import { ackCommand } from "./ack.js";
import { markNotificationRead } from "../github/notifications.js";
import { appendAck } from "../watch/state.js";

const mockedMarkRead = vi.mocked(markNotificationRead);
const mockedAppendAck = vi.mocked(appendAck);

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedAppendAck.mockResolvedValue(undefined);
  mockedMarkRead.mockResolvedValue(undefined);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("ackCommand", () => {
  it("appends key to ack journal file", async () => {
    await ackCommand("1001:2026-02-01T11:30:00.000Z", { stateFile: "/tmp/state.json" });

    expect(mockedAppendAck).toHaveBeenCalledWith(
      "/tmp/state.json",
      "1001:2026-02-01T11:30:00.000Z",
    );
  });

  it("calls markNotificationRead with correct thread ID", async () => {
    await ackCommand("1001:2026-02-01T11:30:00.000Z", { stateFile: "/tmp/state.json" });

    expect(mockedMarkRead).toHaveBeenCalledWith("1001");
  });

  it("handles markNotificationRead failure gracefully", async () => {
    mockedMarkRead.mockRejectedValue(new Error("network error"));

    // Should not throw
    await ackCommand("1001:2026-02-01T11:30:00.000Z", { stateFile: "/tmp/state.json" });

    // Journal write still happened
    expect(mockedAppendAck).toHaveBeenCalled();
    // Warning logged to stderr
    const stderrOutput = stderrSpy.mock.calls.map(([s]) => s).join("");
    expect(stderrOutput).toContain("Warning");
    expect(stderrOutput).toContain("1001");
  });

  it("rejects key without colon separator", async () => {
    await expect(
      ackCommand("invalid-key", { stateFile: "/tmp/state.json" }),
    ).rejects.toThrow("Invalid key format");
  });

  it("rejects key with colon at position 0", async () => {
    await expect(
      ackCommand(":2026-02-01T11:30:00.000Z", { stateFile: "/tmp/state.json" }),
    ).rejects.toThrow("Invalid key format");
  });

  it("extracts thread ID correctly when timestamp contains colons", async () => {
    // The timestamp part has colons too — only the first colon splits
    await ackCommand("5001:2026-02-01T11:30:00.000Z", { stateFile: "/tmp/state.json" });

    expect(mockedMarkRead).toHaveBeenCalledWith("5001");
    expect(mockedAppendAck).toHaveBeenCalledWith(
      "/tmp/state.json",
      "5001:2026-02-01T11:30:00.000Z",
    );
  });
});
