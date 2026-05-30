/**
 * Form metadata for the agent config UI: the skills catalog + engine catalog.
 * Cookie-auth (no installation required — it's static reference data, but we
 * still require a valid session so it isn't a public endpoint).
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateByokRequest } from "@/server/byok-auth";
import { SKILLS_CATALOG } from "@/server/skills-catalog";
import { ENGINE_CATALOG } from "@/server/engine-catalog";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateByokRequest(request, { requireFresh: false });
  if (!auth.ok) return auth.response;

  return NextResponse.json({
    skills_catalog: SKILLS_CATALOG,
    engine_catalog: ENGINE_CATALOG.map((e) => ({ id: e.id, label: e.label })),
  });
}
