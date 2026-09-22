import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDb, resolveDatabaseUrl } from "./client";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const migrationsFolder = path.resolve(currentDir, "../../drizzle");

/** Forward-only migrations (engineering-standards.md §8). Safe to call repeatedly. */
export async function runMigrations(connectionString?: string): Promise<void> {
  const { db, close } = createDb(resolveDatabaseUrl(connectionString));
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
