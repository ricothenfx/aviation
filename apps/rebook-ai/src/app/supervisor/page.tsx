import { eq } from "drizzle-orm";

import { AppPage } from "@/components/app-shell";
import { PoisonPanel, ScenarioConsole, type ConsoleFlight } from "@/components/scenario-console";
import { flights as flightsTable } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";

export const dynamic = "force-dynamic";

/**
 * Supervisor console (architecture.md §3.1 scenario control + §6 poison
 * surfacing). Flight list is read server-side from the seeded reference day;
 * injection + poison events go through the documented REST surface.
 */
export default async function SupervisorPage() {
  const db = getSingletonDb();
  const rows = await db
    .select({
      flightNo: flightsTable.flightNo,
      dest: flightsTable.dest,
      schedDep: flightsTable.schedDep,
    })
    .from(flightsTable)
    .where(eq(flightsTable.status, "scheduled"))
    .orderBy(flightsTable.schedDep);

  const flights: ConsoleFlight[] = rows.map((row) => ({
    flightNo: row.flightNo,
    dest: row.dest,
    schedDep: row.schedDep.toISOString(),
  }));

  return (
    <AppPage minimumRole="supervisor">
      <div className="rb-fade-in">
        <h1 className="text-lg font-semibold text-fg">Supervisor console</h1>
        <p className="mt-1 text-xs text-muted">
          IROP scenario control and honest failure surfacing — every injected disruption flows
          through the event log and the orchestrator pipeline.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ScenarioConsole flights={flights} />
          <PoisonPanel />
        </div>
      </div>
    </AppPage>
  );
}
