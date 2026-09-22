import { runMigrations } from "@aviation/db/migrate";
import { createDb } from "@aviation/db/client";
import { users } from "@aviation/db/schema";

import { hashPassword } from "../src/lib/auth/password";
import { SEED_USERS } from "./users";

/**
 * Seed skeleton (F1): applies migrations then upserts the demo users.
 * Re-runnable by design (upsert on email) so scenario resets stay cheap.
 * The full reference day (stands, flights, tasks) is F2 scope.
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
    console.info(
      JSON.stringify({
        level: "info",
        module: "seed",
        msg: `seeded ${SEED_USERS.length} users; reference-day flights land with the F2 schema`,
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
