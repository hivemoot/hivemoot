/**
 * Route tests for the reconciler's desired-state endpoint. Load-bearing
 * properties: it requires the `fleet.read` capability, derives installationId
 * ONLY from the token envelope (ignoring any query override — no cross-tenant),
 * and 304s on a matching ETag.
 */

import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/server/agent-token-v1-auth", () => ({ authenticateAgentRequestV1: vi.fn() }));

vi.mock("@/server/fleet-store", async () => {
  const real = await vi.importActual<typeof import("@/server/fleet-store")>("@/server/fleet-store");
  return { ...real, getRosterVersion: vi.fn(), listAgents: vi.fn() };
});

import { authenticateAgentRequestV1 } from "@/server/agent-token-v1-auth";
import { getRosterVersion, listAgents } from "@/server/fleet-store";
import { rosterEtag } from "@/server/fleet-desired-state";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateAgentRequestV1);
const mockedRosterVersion = vi.mocked(getRosterVersion);
const mockedList = vi.mocked(listAgents);

const TENANT = "tenant-A";

function authOk() {
  mockedAuth.mockResolvedValue({
    ok: true as const,
    installationId: TENANT,
    name: "reconciler",
    agent_role: "reconciler",
    capabilities: ["fleet.read"],
    envelope: {} as never,
    redis: {} as never,
  });
}

function reqWith(query = "", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://www.hivemoot.dev/api/fleet/desired-state${query}`, {
    headers: { authorization: "Bearer hmt_x", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRosterVersion.mockResolvedValue(5);
  mockedList.mockResolvedValue([]);
});

it("requires the fleet.read capability", async () => {
  mockedAuth.mockResolvedValue({ ok: false as const, response: NextResponse.json({ code: "x" }, { status: 403 }) });
  const res = await GET(reqWith());
  expect(res.status).toBe(403);
  expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requires: "fleet.read" });
});

it("derives installationId from the envelope ONLY, ignoring an installationId query override", async () => {
  authOk();
  const res = await GET(reqWith("?installationId=tenant-B"));
  expect(res.status).toBe(200);
  // Both store reads are scoped to the token's tenant — never the query value.
  expect(mockedRosterVersion).toHaveBeenCalledWith(TENANT, expect.anything());
  expect(mockedList).toHaveBeenCalledWith(expect.objectContaining({ installationId: TENANT }));
  expect(mockedRosterVersion).not.toHaveBeenCalledWith("tenant-B", expect.anything());
});

it("304s when If-None-Match matches the current roster ETag (no roster read)", async () => {
  authOk();
  const res = await GET(reqWith("", { "if-none-match": `"${rosterEtag(5)}"` }));
  expect(res.status).toBe(304);
  expect(mockedList).not.toHaveBeenCalled();
});

it("200 returns the roster with an ETag header on a fresh poll", async () => {
  authOk();
  const res = await GET(reqWith());
  expect(res.status).toBe(200);
  expect(res.headers.get("etag")).toBe(`"${rosterEtag(5)}"`);
  const body = await res.json();
  expect(body.etag).toBe(rosterEtag(5));
  expect(Array.isArray(body.agents)).toBe(true);
});
