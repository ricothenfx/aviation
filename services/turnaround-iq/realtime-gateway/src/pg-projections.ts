import { eq } from "drizzle-orm";

import type { Db } from "@aviation/db/client";
import { flights, groundTasks } from "@aviation/db/schema";
import type { FlightProjection } from "@aviation/contracts";

/**
 * PostgreSQL projection columns (data-model.md §2): `flights.status`,
 * `flights.est_off_block` and `ground_tasks.state` are maintained BY the event
 * handler — this module is the only writer (ADR-0001 compliance: no out-of-band
 * projection mutations). The live read model stays in Redis; PG keeps the
 * durable, replay-derivable copy.
 */
export async function persistProjectionToPg(db: Db, flight: FlightProjection): Promise<void> {
  await db
    .update(flights)
    .set({
      status: flight.status,
      estOffBlock: flight.estOffBlock ? new Date(flight.estOffBlock) : null,
    })
    .where(eq(flights.id, flight.id));

  for (const task of flight.tasks) {
    await db.update(groundTasks).set({ state: task.state }).where(eq(groundTasks.id, task.id));
  }
}
