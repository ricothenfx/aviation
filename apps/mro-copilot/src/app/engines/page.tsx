import { AppPage } from "@/components/app-page";
import { FleetDashboard } from "@/components/fleet-dashboard";
import { getSession } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/rbac";

export default async function EnginesPage() {
  const session = await getSession();
  return (
    <AppPage>
      <FleetDashboard role={(session?.role ?? "viewer") as Role} />
    </AppPage>
  );
}
