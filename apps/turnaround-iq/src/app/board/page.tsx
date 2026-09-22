import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

import { BoardShell } from "./BoardShell";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return <BoardShell user={{ displayName: session.name, role: session.role }} />;
}
