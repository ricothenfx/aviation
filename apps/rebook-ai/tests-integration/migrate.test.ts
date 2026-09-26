import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * F1 DoD migration test (rebook-ai milestones.md): `rebook_ai` created
 * idempotently by seed; `users` table + the PRD F-7 role ladder present with
 * argon2 hashes after `pnpm seed:rebook`. Runs against the compose
 * profile "rebook" stack.
 */

const pool = new pg.Pool({
  connectionString:
    process.env.REBOOK_DATABASE_URL ??
    "postgresql://turnaround:turnaround@localhost:5433/rebook_ai",
  max: 2,
});

afterAll(async () => {
  await pool.end();
});

describe("rebook_ai migrations (F1 slice)", () => {
  it("has the users table with the role ladder enum", async () => {
    const table = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'users'`,
    );
    const columns = table.rows.map((r) => r.column_name);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "email", "password_hash", "display_name", "role", "is_active"]),
    );

    const labels = await pool.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'user_role'
       order by e.enumsortorder`,
    );
    expect(labels.rows.map((r) => r.enumlabel)).toEqual(["passenger", "agent", "supervisor"]);
  });

  it("holds the three seeded users with argon2id hashes (D-09 pattern)", async () => {
    const rows = await pool.query<{ email: string; role: string; password_hash: string }>(
      "select email, role::text as role, password_hash from users order by email",
    );
    const byEmail = new Map(rows.rows.map((r) => [r.email, r]));
    expect(byEmail.get("nadia.cho@pax-sim.example")?.role).toBe("passenger");
    expect(byEmail.get("amir.hassan@nx-sim.example")?.role).toBe("agent");
    expect(byEmail.get("grace.tan@nx-sim.example")?.role).toBe("supervisor");
    for (const row of rows.rows) {
      // argon2id encoded hash format, never plaintext (data-ethics.md §5).
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
    }
  });

  it("is idempotent: re-running the seed upserts without duplicating users", async () => {
    // The compose web service seeds exactly once; this verifies the upsert
    // property on a second direct seed via the same SQL path (on-conflict).
    const before = await pool.query<{ count: string }>("select count(*)::text as count from users");
    const { createDb } = await import("../src/db/client");
    const { hashPassword } = await import("../src/lib/auth/password");
    const { users } = await import("../src/db/schema");
    const { db, close } = createDb();
    try {
      await db
        .insert(users)
        .values({
          email: "nadia.cho@pax-sim.example",
          displayName: "Nadia Cho",
          role: "passenger",
          passwordHash: await hashPassword("passenger-nx-01"),
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { displayName: "Nadia Cho", isActive: true },
        });
    } finally {
      await close();
    }
    const after = await pool.query<{ count: string }>("select count(*)::text as count from users");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
