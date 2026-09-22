import { sql } from "drizzle-orm";

import { errorResponse, jsonResponse, logInfo } from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";

/** Readiness — checks the PostgreSQL dependency (architecture.md §7). Root path per api-contracts.md §1. */
export async function GET() {
  try {
    await getSingletonDb().execute(sql`select 1`);
    return jsonResponse({ status: "ready", dependencies: { postgres: "up" } });
  } catch (err) {
    logInfo("readyz", "dependency_check_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("INTERNAL", "dependencies unavailable", { status: 503 });
  }
}
