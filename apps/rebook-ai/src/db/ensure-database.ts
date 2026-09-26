import { Client } from "pg";

import { resolveDatabaseUrl } from "./client";

/**
 * The shared compose cluster (monorepo-architecture.md §3) initializes its
 * default database from POSTGRES_DB; `rebook_ai` is created on first
 * migrate/seed — idempotent, safe on every boot (DoD: clean-clone run).
 */
export async function ensureDatabase(connectionString?: string): Promise<void> {
  const url = new URL(resolveDatabaseUrl(connectionString));
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error(`rebook database URL has no database name: ${url.toString()}`);
  }
  url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() });
  try {
    await admin.connect();
    const exists = await admin.query<{ datname: string }>(
      "select datname from pg_database where datname = $1",
      [database],
    );
    if (exists.rowCount === 0) {
      await admin.query(`create database "${database.replace(/"/g, "")}"`);
    }
  } finally {
    await admin.end();
  }
}
