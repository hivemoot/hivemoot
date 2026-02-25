import { NextResponse } from "next/server";

import { BYOK_ERROR, type ByokErrorCode } from "@/constants/byok-errors";

export { BYOK_ERROR, type ByokErrorCode };

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
