import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * mro-copilot database client. The mro app must not read turnaround-iq's
 * DATABASE_URL (both apps live in the shared root .env) — hence the
 * MRO_DATABASE_URL name and the mro_copilot default (data-model.md).
 */
export const DEFAULT_LOCAL_DATABASE_URL =
  "postgresql://turnaround:turnaround@localhost:5433/mro_copilot";

export function resolveDatabaseUrl(
  url: string | undefined = process.env.MRO_DATABASE_URL ?? process.env.DATABASE_URL,
): string {
  return url ?? DEFAULT_LOCAL_DATABASE_URL;
}

export type MroDb = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string = resolveDatabaseUrl()): {
  db: MroDb;
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
