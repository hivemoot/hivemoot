/**
 * Legacy redirect: /dashboard/credentials -> /dashboard/settings/byok.
 *
 * The BYOK UI moved to its canonical location under /dashboard/settings
 * per RFC PR 6 (Queen Execution Mode RFC's 6-PR stack). The old path
 * stays around so any bookmarks or stale links keep landing on the
 * right page; once analytics show zero hits over a couple of weeks
 * we can drop this stub.
 *
 * The actual page + panel components moved (`git mv`) to:
 *   web/src/app/dashboard/settings/byok/page.tsx
 *   web/src/app/dashboard/settings/byok/ByokPanel.tsx
 *
 * Storage key (`hive:byok:{installationId}`) is NOT relocated -
 * only the dashboard route moved.
 */

import { redirect } from "next/navigation";

export default function LegacyCredentialsRedirect(): never {
  redirect("/dashboard/settings/byok");
}
