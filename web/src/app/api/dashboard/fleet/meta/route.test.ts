/**
 * Route tests for the fleet meta surface (form reference data). Load-bearing:
 * cookie-auth with a NON-fresh session (requireFresh: false), installationId
 * taken ONLY from the session (never input), and a BEST-EFFORT installation_repos
 * list that degrades to [] when the lister fails (the create/patch path re-checks
 * coverage fail-closed, so a degraded [] can only narrow the UI).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/server/byok-auth", () => ({ authenticateByokRequest: vi.fn() }));
vi.mock("@/server/require-installation", () => ({ requireInstallation: vi.fn() }));
vi.mock("@/server/github-installation-repos", () => ({ listInstallationRepos: vi.fn() }));

import { authenticateByokRequest } from "@/server/byok-auth";
import { requireInstallation } from "@/server/require-installation";
import { listInstallationRepos } from "@/server/github-installation-repos";
import { GET } from "./route";

const mockedAuth = vi.mocked(authenticateByokRequest);
const mockedRequireInstallation = vi.mocked(requireInstallation);
const mockedList = vi.mocked(listInstallationRepos);

const INSTALL = "install-1";

function authOk() {
  mockedAuth.mockResolvedValue({
    ok: true as const,
    session: { userLogin: "op", userId: 7, installationId: INSTALL } as never,
    keyring: new Map<string, Buffer>([["v1", Buffer.alloc(32)]]),
    activeKeyVersion: "v1",
    redis: {} as never,
  });
  mockedRequireInstallation.mockReturnValue({ ok: true as const, installationId: INSTALL });
}

function metaReq(): NextRequest {
  return new NextRequest("https://www.hivemoot.dev/api/dashboard/fleet/meta", { headers: { cookie: "session=mock" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  authOk();
  mockedList.mockResolvedValue(["owner/a", "owner/b"]);
});

describe("GET /api/dashboard/fleet/meta", () => {
  it("uses a NON-fresh session (requireFresh: false)", async () => {
    await GET(metaReq());
    expect(mockedAuth).toHaveBeenCalledWith(expect.anything(), { requireFresh: false });
  });

  it("returns the catalogs + installation_repos, scoping the lister to the SESSION installationId", async () => {
    const res = await GET(metaReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.skills_catalog)).toBe(true);
    expect(Array.isArray(body.engine_catalog)).toBe(true);
    expect(body.installation_repos).toEqual(["owner/a", "owner/b"]);
    expect(mockedList).toHaveBeenCalledWith(INSTALL);
  });

  it("best-effort: a lister failure degrades installation_repos to [] (form still loads 200)", async () => {
    mockedList.mockRejectedValue(new Error("github down"));
    const res = await GET(metaReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installation_repos).toEqual([]);
    expect(Array.isArray(body.skills_catalog)).toBe(true);
  });
});
