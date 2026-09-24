import { sql } from "drizzle-orm";

import { aiServiceReady } from "@/lib/ai/client";
import type { DependencyState } from "@/lib/ai/contract";
import { errorResponse, jsonResponse } from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";
import { logger } from "@/lib/logger";

/**
 * Readiness — reports DB, pgvector, model artifact and provider status
 * (architecture.md §7, DoD F1). Hard dependencies: postgres, pgvector, the
 * ai-service (retrieval/embedding provider). The RUL model artifact lives in
 * the ai-service and is reported through its readyz; `not_loaded` is the
 * expected F1 state (the artifact arrives with F4, ADR-0011) and does not fail
 * readiness yet — F4 tightens this when predictions go live.
 */
export async function GET() {
  const dependencies: Record<string, DependencyState | "unreachable" | "unknown"> = {
    postgres: "down",
    pgvector: "down",
    provider: "unreachable",
    model: "unknown",
  };

  try {
    const db = getSingletonDb();
    await db.execute(sql`select 1`);
    dependencies.postgres = "up";

    const ext = await db.execute<{ extname: string }>(
      sql`select extname from pg_extension where extname = 'vector'`,
    );
    dependencies.pgvector = ext.rows.length > 0 ? "up" : "down";
  } catch (err) {
    logger.warn({
      msg: "dependency_check_failed",
      dependency: "postgres",
      err: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("INTERNAL", "dependencies unavailable", { status: 503 });
  }

  try {
    const ai = await aiServiceReady();
    dependencies.provider = ai.dependencies.provider;
    dependencies.model = ai.dependencies.model;
  } catch {
    dependencies.provider = "unreachable";
    return errorResponse("AI_SERVICE_UNAVAILABLE", "ai-service is unreachable", {
      details: { mode: ["readyz"] },
    });
  }

  return jsonResponse({ status: "ready", dependencies });
}
