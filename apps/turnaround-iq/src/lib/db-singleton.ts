import { createDb, type Db } from "@aviation/db/client";

/**
 * One pooled connection per server process (route handlers, readyz).
 * Cached on globalThis so Next.js dev-mode module reloads reuse the pool.
 */
const globalStore = globalThis as unknown as { __tiqDb?: Db };

export function getSingletonDb(): Db {
  if (!globalStore.__tiqDb) {
    globalStore.__tiqDb = createDb().db;
  }
  return globalStore.__tiqDb;
}
