import { redirect } from "next/navigation";

// The dashboard root now lives at /dashboard/agents. The install gate + Connect
// CTA moved there so a not-yet-installed user still lands on a useful page.
export default function DashboardPage() {
  redirect("/dashboard/agents");
}
