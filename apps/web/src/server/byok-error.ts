import { NextResponse } from "next/server";
export { BYOK_ERROR, type ByokErrorCode } from "@/constants/byok-errors";
import type { ByokErrorCode } from "@/constants/byok-errors";

export function byokError(
  code: ByokErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      code,
      message,
      ...(details ?? {}),
    },
    { status },
  );
}
