import { NextResponse } from "next/server";
import { validateEnv } from "@/server/env";

export function GET() {
  const env = validateEnv();

  if (!env.ok) {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }

  const isProduction = env.config.nodeEnv === "production";
  return NextResponse.json({
    status: "ok",
    ...(!isProduction && { env: env.config.nodeEnv }),
    timestamp: new Date().toISOString(),
  });
}
