import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

/**
 * Route by role: passengers land on their trip view, agents and supervisors on
 * the console (PRD §2 two-sided product).
 */
export default async function Home() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  redirect(session.role === "passenger" ? "/trip" : "/console");
}
