import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * Throwaway local dev default (compose profile "infra" publishes 5433).
 * Not a secret — the cluster only ever contains simulated data.
 */
export const DEFAULT_LOCAL_DATABASE_URL =
  "postgresql://turnaround:turnaround@localhost:5433/turnaround_iq";

export function resolveDatabaseUrl(url: string | undefined = process.env.DATABASE_URL): string {
  return url ?? DEFAULT_LOCAL_DATABASE_URL;
}

export type Db = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string = resolveDatabaseUrl()): {
  db: Db;
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
