import { describe, it, expect } from "vitest";

import {
  describeCapabilityGaps,
  detectCapabilityGaps,
  requiredCapabilitiesForPlugins,
  TASKS_REQUIREMENTS,
  WAR_ROOMS_CONTRIBUTE_REQUIREMENT,
  WAR_ROOMS_OBSERVE_REQUIREMENTS,
} from "./capabilities";
import { defaultPlugins, type FleetPlugins } from "./types";

function pluginsWith(overrides: Partial<FleetPlugins>): FleetPlugins {
  return { ...defaultPlugins(), ...overrides };
}

describe("requiredCapabilitiesForPlugins", () => {
  it("returns nothing for github/schedule-only agents (no token capability needed)", () => {
    const plugins = pluginsWith({
      github: { ...defaultPlugins().github, enabled: true, repos: ["o/r"] },
      schedule: { ...defaultPlugins().schedule, enabled: true, prompt: "x" },
    });
    expect(requiredCapabilitiesForPlugins(plugins)).toEqual([]);
  });

  it("includes tasks requirements when tasks enabled", () => {
    const plugins = pluginsWith({ tasks: { enabled: true } });
    const caps = requiredCapabilitiesForPlugins(plugins).map((r) => r.capability);
    expect(caps).toEqual(TASKS_REQUIREMENTS.map((r) => r.capability));
    expect(caps).toContain("tasks.claim");
  });

  it("includes observe requirements for war_rooms (observe only)", () => {
    const plugins = pluginsWith({ war_rooms: { enabled: true, contribute: false } });
    const caps = requiredCapabilitiesForPlugins(plugins).map((r) => r.capability);
    expect(caps).toEqual(WAR_ROOMS_OBSERVE_REQUIREMENTS.map((r) => r.capability));
    expect(caps).not.toContain("rooms.contribute");
  });

  it("adds rooms.contribute when war_rooms contribute is on", () => {
    const plugins = pluginsWith({ war_rooms: { enabled: true, contribute: true } });
    const caps = requiredCapabilitiesForPlugins(plugins).map((r) => r.capability);
    expect(caps).toContain(WAR_ROOMS_CONTRIBUTE_REQUIREMENT.capability);
  });

  it("ignores plugins that are present but disabled", () => {
    const plugins = pluginsWith({
      tasks: { enabled: false },
      war_rooms: { enabled: false, contribute: true },
    });
    expect(requiredCapabilitiesForPlugins(plugins)).toEqual([]);
  });
});

describe("detectCapabilityGaps", () => {
  it("reports no gap when nothing is enabled", () => {
    expect(detectCapabilityGaps(defaultPlugins(), [])).toEqual([]);
  });

  it("flags tasks when the token lacks tasks.claim", () => {
    const plugins = pluginsWith({ tasks: { enabled: true } });
    const gaps = detectCapabilityGaps(plugins, ["agent_health.report"]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].plugin).toBe("tasks");
    expect(gaps[0].missing).toContain("tasks.claim");
  });

  it("does not flag tasks when the token has the full tasks bundle", () => {
    const plugins = pluginsWith({ tasks: { enabled: true } });
    const gaps = detectCapabilityGaps(plugins, ["tasks.claim", "tasks.progress", "tasks.complete"]);
    expect(gaps).toEqual([]);
  });

  it("expands a tasks.* wildcard token to cover the whole bundle", () => {
    const plugins = pluginsWith({ tasks: { enabled: true } });
    expect(detectCapabilityGaps(plugins, ["tasks.*"])).toEqual([]);
  });

  it("expands a bare * token to cover every plugin need", () => {
    const plugins = pluginsWith({
      tasks: { enabled: true },
      war_rooms: { enabled: true, contribute: true },
    });
    expect(detectCapabilityGaps(plugins, ["*"])).toEqual([]);
  });

  it("flags war_rooms observe gaps", () => {
    const plugins = pluginsWith({ war_rooms: { enabled: true, contribute: false } });
    const gaps = detectCapabilityGaps(plugins, ["rooms.watch"]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].plugin).toBe("war_rooms");
    expect(gaps[0].missing).toEqual(["rooms.read"]);
  });

  it("requires rooms.contribute only when contribute is on", () => {
    const observeOnly = pluginsWith({ war_rooms: { enabled: true, contribute: false } });
    expect(detectCapabilityGaps(observeOnly, ["rooms.watch", "rooms.read"])).toEqual([]);

    const contributing = pluginsWith({ war_rooms: { enabled: true, contribute: true } });
    const gaps = detectCapabilityGaps(contributing, ["rooms.watch", "rooms.read"]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missing).toEqual(["rooms.contribute"]);
  });

  it("reports multiple plugin gaps at once", () => {
    const plugins = pluginsWith({
      tasks: { enabled: true },
      war_rooms: { enabled: true, contribute: true },
    });
    const gaps = detectCapabilityGaps(plugins, []);
    expect(gaps.map((g) => g.plugin).sort()).toEqual(["tasks", "war_rooms"]);
  });

  it("never flags github/schedule (no token capability needed)", () => {
    const plugins = pluginsWith({
      github: { ...defaultPlugins().github, enabled: true, repos: ["o/r"] },
      schedule: { ...defaultPlugins().schedule, enabled: true, prompt: "x" },
    });
    expect(detectCapabilityGaps(plugins, [])).toEqual([]);
  });
});

describe("describeCapabilityGaps", () => {
  it("returns null when there are no gaps", () => {
    expect(describeCapabilityGaps([])).toBeNull();
  });

  it("phrases the warning in plugin terms and notes it is non-blocking", () => {
    const msg = describeCapabilityGaps([{ plugin: "tasks", missing: ["tasks.claim"] }]);
    expect(msg).toContain("Tasks needs tasks.claim");
    expect(msg).toContain("can still be created");
  });
});
