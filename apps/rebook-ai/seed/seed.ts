import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { hashPassword } from "../src/lib/auth/password";
import { users } from "../src/db/schema";
import seedUsers from "./users.json";

/**
 * Seed (engineering-standards.md §8, rebook-ai data-model.md §6): ensure
 * database + migrations + the three seeded demo users (D-09 pattern; roles
 * passenger/agent/supervisor per PRD F-7). Re-runnable by design (upserts +
 * conflict-safe inserts). The reference day (schedule, PNRs, inventory,
 * policy — data-model.md §4) arrives with F2 as additional seed files.
 */

interface SeedUser {
  email: string;
  displayName: string;
  role: "passenger" | "agent" | "supervisor";
  password: string;
}

async function main(): Promise<void> {
  await runMigrations();

  const { db, close } = createDb();
  try {
    for (const user of seedUsers as SeedUser[]) {
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
        msg: "seed complete",
        users: seedUsers.length,
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
