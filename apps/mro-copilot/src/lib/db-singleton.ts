import { createDb, type MroDb } from "@/db/client";

/**
 * One pooled connection per server process (route handlers, readyz).
 * Cached on globalThis so Next.js dev-mode module reloads reuse the pool.
 */
const globalStore = globalThis as unknown as { __mroDb?: MroDb };

export function getSingletonDb(): MroDb {
  if (!globalStore.__mroDb) {
    globalStore.__mroDb = createDb().db;
  }
  return globalStore.__mroDb;
}
