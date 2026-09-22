import { runMigrations } from "@aviation/db/migrate";
import { upsertReferenceDay } from "@aviation/db/baseline";
import { createDb } from "@aviation/db/client";
import { users } from "@aviation/db/schema";
import { buildReferenceDay, eventLogHash } from "@aviation/tiq-domain";

import { hashPassword } from "../src/lib/auth/password";
import { SEED_USERS } from "./users";

/**
 * Seed (engineering-standards.md §8): migrations + demo users + the canonical
 * reference day (stands, aircraft types, 60 flights, 720 ground tasks, the
 * dependency DAG). Re-runnable by design (deterministic UUID upserts) so scenario
 * resets stay cheap. The event log itself is produced by the simulator.
 */
async function main(): Promise<void> {
  await runMigrations();

  const { db, close } = createDb();
  try {
    for (const user of SEED_USERS) {
      const passwordHash = await hashPassword(user.password);
      await db
        .insert(users)
        .values({
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          passwordHash,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { displayName: user.displayName, role: user.role, passwordHash, isActive: true },
        });
    }

    const day = buildReferenceDay();
    await upsertReferenceDay(db, day);

    const taskCount = day.flights.reduce((sum, flight) => sum + flight.tasks.length, 0);
    console.info(
      JSON.stringify({
        level: "info",
        module: "seed",
        msg: "seed complete",
        users: SEED_USERS.length,
        stands: day.stands.length,
        flights: day.flights.length,
        tasks: taskCount,
        dependencies: day.dependencies.length,
        emptyLogHash: eventLogHash([]),
      }),
    );
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      module: "seed",
      msg: "seed failed",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
