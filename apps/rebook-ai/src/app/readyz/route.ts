import { sql } from "drizzle-orm";

import { errorResponse, jsonResponse } from "@/lib/api/respond";
import { getSingletonDb } from "@/lib/db-singleton";
import { logger } from "@/lib/logger";

/**
 * Readiness — reports DB and LLM provider status (rebook-ai architecture.md
 * §7, DoD F1). Hard dependency: postgres. The provider is informational:
 * `LLM_PROVIDER=off` is a supported degrade-to-rules mode (ADR-0003/D-10),
 * not an outage — proposals would be labeled `source: "rules"`.
 */
export async function GET() {
  const dependencies: Record<string, string> = {
    postgres: "down",
    provider: (process.env.LLM_PROVIDER ?? "mock") === "off" ? "off (degrade)" : "up (mock)",
  };

  try {
    const db = getSingletonDb();
    await db.execute(sql`select 1`);
    dependencies.postgres = "up";
  } catch (err) {
    logger.warn({
      msg: "dependency_check_failed",
      dependency: "postgres",
      err: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("INTERNAL", "dependencies unavailable", { status: 503 });
  }

  return jsonResponse({ status: "ready", dependencies });
}
