import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { hashPassword } from "../src/lib/auth/password";
import { users } from "../src/db/schema";
import seedUsers from "./users.json";
import { seedEngines } from "./engines";

/**
 * Seed (engineering-standards.md §8, data-model.md §7): ensure database +
 * migrations + the three seeded demo users (D-09 pattern; roles
 * viewer/engineer/reviewer per PRD F-7) + the engine fleet with its C-MAPSS
 * sensor history (F4: real FD001 test split when downloaded, plus the
 * committed synthetic sample — see seed/engines.ts). Re-runnable by design
 * (upserts + conflict-safe inserts). Corpus ingestion is the ai-service
 * ingest CLI's job (FR-5) and runs in the compose stack right after this
 * seed; the CLI embeds and upserts chunks.
 */

interface SeedUser {
  email: string;
  displayName: string;
  role: "viewer" | "engineer" | "reviewer";
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
        msg: "seed users complete",
        users: seedUsers.length,
      }),
    );

    const fleet = await seedEngines();
    console.info(
      JSON.stringify({
        level: "info",
        module: "seed",
        msg: "seed complete",
        users: seedUsers.length,
        engineUnits: fleet.units,
        sensorRows: fleet.readings,
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
