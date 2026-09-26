import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "rebook-ai/db/schema";

/**
 * rebook-ai database handle for the orchestrator. Deliberately NOT
 * `@aviation/db`'s createDb: that resolves turnaround-iq's DATABASE_URL and
 * schema (F1 report deviation note). The rebook orchestrator attaches the
 * rebook-ai drizzle project (the single schema source, data-model.md §6) and
 * resolves REBOOK_DATABASE_URL explicitly (ADR-0015).
 */

export const DEFAULT_REBOOK_DATABASE_URL =
  "postgresql://turnaround:turnaround@localhost:5433/rebook_ai";

export function resolveOrchestratorDatabaseUrl(
  url: string | undefined = process.env.REBOOK_DATABASE_URL,
): string {
  return url ?? DEFAULT_REBOOK_DATABASE_URL;
}

export type OrchestratorDb = NodePgDatabase<typeof schema>;

export function createOrchestratorDb(connectionString: string = resolveOrchestratorDatabaseUrl()): {
  db: OrchestratorDb;
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
export * from "rebook-ai/db/schema";
