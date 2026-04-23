import { NextResponse } from "next/server";
import { validateEnv } from "@/server/env";

export function GET() {
  const env = validateEnv();

  if (!env.ok) {
    return NextResponse.json(
      { status: "error", missing: env.missing },
      { status: 503 },
    );
  }

  return NextResponse.json({
    status: "ok",
    env: env.config.nodeEnv,
    timestamp: new Date().toISOString(),
  });
}
