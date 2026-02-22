"use server";

import { cookies } from "next/headers";
import { REMEMBERED_USER_COOKIE } from "@/server/setup-session";

/**
 * Clear the remembered-user cookie so the landing page reverts to
 * the default (non-personalized) CTA. Called from the "Not you?" form.
 */
export async function forgetUser() {
  const cookieStore = await cookies();
  cookieStore.delete(REMEMBERED_USER_COOKIE);
}
