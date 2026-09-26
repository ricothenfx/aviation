import { eq } from "drizzle-orm";

import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { hashPassword } from "../src/lib/auth/password";
import {
  loadInventory,
  loadPnrs,
  loadPolicy,
  loadReferenceDay,
} from "../src/lib/seed/fixture-schema";
import { flights, pnr, pnrSegments, users } from "../src/db/schema";
import seedUsers from "./users.json";

/**
 * Seed (engineering-standards.md §8, rebook-ai data-model.md §6): ensure
 * database + migrations + upsert users (F1, D-09) + load reference day:
 * schedule + PNRs + segments (F2), then validate inventory + policy fixtures.
 * Re-runnable by design (upserts + conflict-safe inserts; re-seeding resets the
 * reference day to its committed scheduled state).
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
    // 1. Seeded demo users (D-09): passenger/agent/supervisor ladder (PRD F-7).
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

    // 2. Reference-day schedule (data-model.md §4): upsert resets each flight to
    // its committed scheduled state so re-seeds are deterministic.
    const referenceDay = loadReferenceDay();
    for (const flight of referenceDay.flights) {
      const row = {
        ...flight,
        schedDep: new Date(flight.schedDep),
        schedArr: new Date(flight.schedArr),
      };
      await db
        .insert(flights)
        .values(row)
        .onConflictDoUpdate({
          target: flights.flightNo,
          set: {
            airline: row.airline,
            origin: row.origin,
            dest: row.dest,
            schedDep: row.schedDep,
            schedArr: row.schedArr,
            aircraft: row.aircraft,
            status: "scheduled",
            delayMinutes: 0,
          },
        });
    }

    // 3. PNRs + segments (data-model.md §4): demo-cast rows link to their seeded
    // login users via email (pnr.user_id, D-09); segments replace wholesale to
    // keep re-seeds conflict-safe.
    const pnrSeed = loadPnrs();
    const userRows = await db.select({ id: users.id, email: users.email }).from(users);
    const userIdByEmail = new Map(userRows.map((u) => [u.email, u.id]));
    for (const record of pnrSeed.pnrs) {
      const linkedUserId = record.email ? (userIdByEmail.get(record.email) ?? null) : null;
      const [row] = await db
        .insert(pnr)
        .values({
          locator: record.locator,
          userId: linkedUserId,
          passengerName: record.passengerName,
          tier: record.tier,
          fareClass: record.fareClass,
          partySize: record.partySize,
          contactHandle: record.contactHandle,
          document: record.document,
        })
        .onConflictDoUpdate({
          target: pnr.locator,
          set: {
            userId: linkedUserId,
            passengerName: record.passengerName,
            tier: record.tier,
            fareClass: record.fareClass,
            partySize: record.partySize,
            contactHandle: record.contactHandle,
            document: record.document,
          },
        })
        .returning({ id: pnr.id });
      if (!row) throw new Error(`seed: pnr ${record.locator} did not return a row`);
      await db.delete(pnrSegments).where(eq(pnrSegments.pnrId, row.id));
      await db.insert(pnrSegments).values(
        record.segments.map((segment) => ({
          ...segment,
          pnrId: row.id as string,
          flightDate: new Date(segment.flightDate),
        })),
      );
    }

    // 4. Inventory + policy are file-based ranking/policy inputs (data-model.md
    // §2/§4 — no tables); validated here so a malformed fixture fails the seed.
    const inventory = loadInventory();
    const policy = loadPolicy();

    console.info(
      JSON.stringify({
        level: "info",
        module: "seed",
        msg: "seed complete",
        users: seedUsers.length,
        referenceDay: referenceDay.referenceDay,
        flights: referenceDay.flights.length,
        pnrs: pnrSeed.pnrs.length,
        inventoryCandidates: inventory.candidates.length,
        policyCurrency: policy.currency,
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
