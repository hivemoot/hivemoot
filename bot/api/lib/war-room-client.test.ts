/**
 * Tests for WarRoomClient.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WarRoomClient,
  WarRoomApiError,
  prSubjectRef,
} from "./war-room-client.js";

const TOKEN = "hmt_test_bearer";
const BASE_URL = "https://www.hivemoot.dev";

function makeFetch(response: {
  status: number;
  body?: unknown;
  ok?: boolean;
}): typeof fetch {
  return vi.fn(async () => {
    const ok =
      response.ok ?? (response.status >= 200 && response.status < 300);
    return {
      ok,
      status: response.status,
      json: async () => response.body ?? {},
    } as Response;
  }) as never;
}

describe("WarRoomClient — construction", () => {
  beforeEach(() => {
    delete process.env.HIVEMOOT_BOT_AGENT_TOKEN;
    delete process.env.HIVEMOOT_API_BASE_URL;
  });

  it("throws when no agent token is supplied via option or env", () => {
    expect(() => new WarRoomClient()).toThrow(/HIVEMOOT_BOT_AGENT_TOKEN/);
  });

  it("accepts agentToken via option", () => {
    expect(() => new WarRoomClient({ agentToken: TOKEN })).not.toThrow();
  });

  it("accepts agentToken via env", () => {
    process.env.HIVEMOOT_BOT_AGENT_TOKEN = TOKEN;
    expect(() => new WarRoomClient()).not.toThrow();
  });

  it("rejects baseUrl without scheme", () => {
    expect(
      () => new WarRoomClient({ agentToken: TOKEN, baseUrl: "hivemoot.dev" }),
    ).toThrow(/must start with http/);
  });

  it("strips trailing slash from baseUrl", () => {
    const fetchSpy = makeFetch({ status: 201, body: { roomId: "x" } });
    const client = new WarRoomClient({
      agentToken: TOKEN,
      baseUrl: "https://www.hivemoot.dev/",
      fetch: fetchSpy,
    });
    void client.createRoom({
      subject: { type: "pr_review", ref: "x/y#1" },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://www.hivemoot.dev/api/rooms",
      expect.anything(),
    );
  });
});

describe("WarRoomClient.createRoom", () => {
  it("happy path → 201 returns RoomCoreResponse", async () => {
    const fetchSpy = makeFetch({
      status: 201,
      body: {
        roomId: "01234567-89ab-4cde-9012-3456789abcde",
        manager: "bot-queen",
        subject_type: "pr_review",
        subject_ref: "owner/repo#42",
        status: "awaiting_rsvp",
        opened_at: "2026-04-28T10:00:00.000Z",
      },
    });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    const room = await client.createRoom({
      subject: { type: "pr_review", ref: "owner/repo#42" },
    });
    expect(room.subject_ref).toBe("owner/repo#42");
    expect(room.status).toBe("awaiting_rsvp");
  });

  it("sends Authorization: Bearer header", async () => {
    const fetchSpy = makeFetch({ status: 201, body: { roomId: "x" } });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    await client.createRoom({
      subject: { type: "pr_review", ref: "owner/repo#1" },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
        }),
      }),
    );
  });

  it("includes optional manager / timing / roomId in body", async () => {
    const fetchSpy = makeFetch({ status: 201, body: { roomId: "x" } });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    await client.createRoom({
      subject: { type: "pr_review", ref: "owner/repo#1" },
      manager: "queen-1",
      timing: { max_age_secs: 7200 },
      roomId: "01234567-89ab-4cde-9012-3456789abcde",
    });
    const callArgs = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.manager).toBe("queen-1");
    expect(body.timing.max_age_secs).toBe(7200);
    expect(body.roomId).toBe("01234567-89ab-4cde-9012-3456789abcde");
  });

  it("subject_already_open 409 → WarRoomApiError(code='subject_already_open')", async () => {
    const fetchSpy = makeFetch({
      status: 409,
      body: {
        code: "subject_already_open",
        message: "Already open",
        existingRoomId: "EXISTING_ID",
      },
    });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    try {
      await client.createRoom({
        subject: { type: "pr_review", ref: "owner/repo#1" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WarRoomApiError);
      const apiErr = err as WarRoomApiError;
      expect(apiErr.code).toBe("subject_already_open");
      expect(apiErr.status).toBe(409);
      expect(apiErr.response.existingRoomId).toBe("EXISTING_ID");
    }
  });

  it("non-JSON 5xx → WarRoomApiError(code='unknown')", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    })) as never;
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    try {
      await client.createRoom({
        subject: { type: "pr_review", ref: "owner/repo#1" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WarRoomApiError);
      expect((err as WarRoomApiError).code).toBe("unknown");
      expect((err as WarRoomApiError).status).toBe(502);
    }
  });

  it("AbortError on timeout → throws timeout error with timeoutMs in message", async () => {
    const fetchSpy = vi.fn(async (_url: string, opts: RequestInit) => {
      // Simulate slow response by waiting for the abort signal.
      await new Promise<void>((_, reject) => {
        opts.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      // unreachable
      return {} as Response;
    }) as never;
    const client = new WarRoomClient({
      agentToken: TOKEN,
      fetch: fetchSpy,
      timeoutMs: 10,
    });
    await expect(
      client.createRoom({
        subject: { type: "pr_review", ref: "owner/repo#1" },
      }),
    ).rejects.toThrow(/timed out after 10ms/);
  });
});

describe("prSubjectRef helper", () => {
  it("returns canonical pr_review subject ref", () => {
    expect(prSubjectRef({ owner: "hivemoot", repo: "hivemoot", prNumber: 42 }))
      .toEqual({ type: "pr_review", ref: "hivemoot/hivemoot#42" });
  });
});

describe("WarRoomClient.appendEvent (E.2)", () => {
  const ROOM_ID = "01234567-89ab-4cde-9012-3456789abcde";

  it("happy path → 200 returns sequence", async () => {
    const fetchSpy = makeFetch({ status: 200, body: { sequence: 5 } });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    const result = await client.appendEvent({
      roomId: ROOM_ID,
      eventType: "subject_updated",
      body: { change_kind: "synchronize" },
      idempotencyKey: "stable-key",
    });
    expect(result.sequence).toBe(5);
  });

  it("hits the correct path with roomId URI-encoded", async () => {
    const fetchSpy = makeFetch({ status: 200, body: { sequence: 1 } });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    await client.appendEvent({
      roomId: ROOM_ID,
      eventType: "subject_updated",
      body: {},
      idempotencyKey: "k",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://www.hivemoot.dev/api/rooms/${ROOM_ID}/event`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("body includes event_type, body, idempotencyKey", async () => {
    const fetchSpy = makeFetch({ status: 200, body: { sequence: 1 } });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    await client.appendEvent({
      roomId: ROOM_ID,
      eventType: "subject_updated",
      body: { change_kind: "synchronize", head_sha: "abc" },
      idempotencyKey: "key-1",
    });
    const callArgs = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body).toEqual({
      event_type: "subject_updated",
      body: { change_kind: "synchronize", head_sha: "abc" },
      idempotencyKey: "key-1",
    });
  });

  it("replay (200 with replay flag) deserializes correctly", async () => {
    const fetchSpy = makeFetch({
      status: 200,
      body: { sequence: 3, replay: true },
    });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    const result = await client.appendEvent({
      roomId: ROOM_ID,
      eventType: "subject_updated",
      body: {},
      idempotencyKey: "k",
    });
    expect(result.sequence).toBe(3);
    expect(result.replay).toBe(true);
  });

  it("404 room_not_found → WarRoomApiError(code='room_not_found')", async () => {
    const fetchSpy = makeFetch({
      status: 404,
      body: { code: "room_not_found", message: "missing" },
    });
    const client = new WarRoomClient({ agentToken: TOKEN, fetch: fetchSpy });
    try {
      await client.appendEvent({
        roomId: ROOM_ID,
        eventType: "subject_updated",
        body: {},
        idempotencyKey: "k",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WarRoomApiError);
      expect((err as WarRoomApiError).code).toBe("room_not_found");
      expect((err as WarRoomApiError).status).toBe(404);
    }
  });
});
