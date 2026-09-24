import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getSession } from "@/lib/auth/session";

import { MroNav, PageContainer } from "./mro-nav";

/**
 * Server-side shell for every app page: resolves the session (middleware only
 * guards routes, architecture.md §5) and renders the nav + page container.
 */
export async function AppPage({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return (
    <>
      <MroNav user={{ email: session.email, role: session.role }} />
      <PageContainer>{children}</PageContainer>
    </>
  );
}
