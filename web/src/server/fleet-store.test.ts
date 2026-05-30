/**
 * Store-layer tests for the READ path (parseStoredAgent via getAgent).
 *
 * parseStoredAgent fail-closes on a single corrupt record so it can't break a
 * list read OR hand a tampered record to the reconciler. The security-sensitive
 * field is `plugins.github.repos`: every entry must still be a string in
 * `owner/name` format on read — a row whose repos were tampered with (non-string,
 * traversal, malformed) is rejected (getAgent → null) rather than returned.
 */

import { describe, it, expect } from "vitest";
import { getAgent, type FleetAgent } from "@/server/fleet-store";

/** Minimal Redis stub: only `get` is exercised by getAgent. */
function redisReturning(value: unknown) {
  return { get: async () => value } as never;
}

function validRecord(over: Partial<FleetAgent> = {}): Record<string, unknown> {
  const base: FleetAgent = {
    name: "builder",
    engine: "claude",
    skills: [],
    system_prompt: "",
    plugins: {
      github: {
        enabled: true,
        repos: ["owner/repo"],
        watch_new_prs: true,
        watch_review_requests: false,
        watch_mentions: false,
        poll_interval_secs: 90,
      },
    },
    enabled: true,
    managed: true,
    agent_token_name: "builder-token",
    created_at: "2026-05-29T00:00:00.000Z",
    created_by: "op",
    updated_at: "2026-05-29T00:00:00.000Z",
    config_version: 2,
    ...over,
  };
  return base as unknown as Record<string, unknown>;
}

async function parseVia(record: unknown): Promise<FleetAgent | null> {
  return getAgent({ installationId: "inst", name: "builder", redis: redisReturning(record) });
}

describe("parseStoredAgent (read path, via getAgent)", () => {
  it("parses a well-formed plugin record", async () => {
    const r = await parseVia(validRecord());
    expect(r).not.toBeNull();
    expect(r?.plugins.github?.repos).toEqual(["owner/repo"]);
  });

  it("returns null for a missing record", async () => {
    expect(await parseVia(null)).toBeNull();
  });

  it("rejects a record whose github.repos is not an array", async () => {
    const rec = validRecord();
    (rec.plugins as { github: { repos: unknown } }).github.repos = "owner/repo";
    expect(await parseVia(rec)).toBeNull();
  });

  it.each([
    ["a non-string entry", [123]],
    ["a path-traversal entry", ["owner/../../etc"]],
    ["a malformed (no slash) entry", ["ownerrepo"]],
    ["a whitespace entry", ["owner /repo"]],
    ["a mix of valid + tampered", ["owner/ok", "owner/../evil"]],
  ])("rejects a tampered github.repos with %s (fail-closed)", async (_label, repos) => {
    const rec = validRecord();
    (rec.plugins as { github: { repos: unknown } }).github.repos = repos;
    expect(await parseVia(rec)).toBeNull();
  });

  it("rejects a record carrying the LEGACY top-level shape (no plugins)", async () => {
    const legacy = {
      name: "builder",
      engine: "claude",
      skills: [],
      system_prompt: "",
      repos: ["owner/repo"],
      triggers: { schedule: { enabled: true, settings: {} } },
      enabled: true,
      managed: true,
      agent_token_name: "builder-token",
      created_at: "t",
      created_by: "op",
      updated_at: "t",
      config_version: 1,
    };
    expect(await parseVia(legacy)).toBeNull();
  });

  it("rejects a record with NO enabled plugin (corrupt)", async () => {
    const rec = validRecord({
      plugins: {
        github: {
          enabled: false,
          repos: ["owner/repo"],
          watch_new_prs: false,
          watch_review_requests: false,
          watch_mentions: false,
          poll_interval_secs: 90,
        },
      },
    });
    expect(await parseVia(rec)).toBeNull();
  });
});
