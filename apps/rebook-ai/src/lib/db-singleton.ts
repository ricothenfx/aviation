import { createDb, type RebookDb } from "@/db/client";

/**
 * One pooled connection per server process (route handlers, readyz).
 * Cached on globalThis so Next.js dev-mode module reloads reuse the pool.
 */
const globalStore = globalThis as unknown as { __rebookDb?: RebookDb };

export function getSingletonDb(): RebookDb {
  if (!globalStore.__rebookDb) {
    globalStore.__rebookDb = createDb().db;
  }
  return globalStore.__rebookDb;
}
