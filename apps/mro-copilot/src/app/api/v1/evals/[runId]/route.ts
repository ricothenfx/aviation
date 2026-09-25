import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { evalRuns } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { evalRunDetailSchema } from "@/lib/api/schemas";
import {
  ApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";

/**
 * GET /api/v1/evals/{runId} (api-contracts.md §1): full metrics + per-case
 * results summary for one eval run — reviewer+ only (PRD FR-21).
 */
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const requestId = newRequestId();
  try {
    await requireSession("reviewer");
    const { runId } = await context.params;
    const db = getSingletonDb();
    const rows = await db.select().from(evalRuns).where(eq(evalRuns.id, runId)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiError("NOT_FOUND", `eval run ${runId} not found`);
    const body = evalRunDetailSchema.parse({
      runId: row.id,
      mode: row.mode,
      fixtureVersion: row.fixtureVersion,
      startedAt: row.startedAt.toISOString(),
      gates: row.gates,
      passed: row.passed,
      metrics: row.metrics,
      caseSummaries: row.caseSummaries,
      reportPath: row.reportPath,
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
