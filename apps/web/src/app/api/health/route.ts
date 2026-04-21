import { NextResponse } from "next/server";
import { validateEnv } from "@/server/env";

export function GET() {
  const env = validateEnv();

  if (!env.ok) {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
