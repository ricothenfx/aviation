import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getSession } from "@/lib/auth/session";
import { roleAtLeast } from "@/lib/auth/rbac";

import { PageContainer, RebookNav } from "./rebook-nav";

/**
 * Server-side shell for every app page: resolves the session (route handlers
 * re-check authorization, rebook-ai architecture.md §5) and renders the nav +
 * page container. `minimumRole` gates whole surfaces (console = agent+).
 */
export async function AppPage({
  children,
  minimumRole = "passenger",
}: {
  children: ReactNode;
  minimumRole?: "passenger" | "agent" | "supervisor";
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  if (!roleAtLeast(session.role, minimumRole)) {
    redirect("/trip");
  }
  return (
    <>
      <RebookNav user={{ email: session.email, role: session.role }} />
      <PageContainer>{children}</PageContainer>
    </>
  );
}
