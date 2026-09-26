import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * rebook-ai database client. The rebook app must not read turnaround-iq's or
 * mro-copilot's DATABASE_URL (all apps share the root .env) — hence the
 * REBOOK_DATABASE_URL name and the rebook_ai default (rebook-ai data-model.md,
 * ADR-0015).
 */
export const DEFAULT_LOCAL_DATABASE_URL =
  "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

export function resolveDatabaseUrl(
  url: string | undefined = process.env.REBOOK_DATABASE_URL ?? process.env.DATABASE_URL,
): string {
  return url ?? DEFAULT_LOCAL_DATABASE_URL;
}

export type RebookDb = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string = resolveDatabaseUrl()): {
  db: RebookDb;
  pool: Pool;
  close: () => Promise<void>;
} {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export { schema };
