import type { NextRequest } from "next/server";
import { desc } from "drizzle-orm";

import { evalRuns } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { createEvalRunRequestSchema, evalRunsResponseSchema } from "@/lib/api/schemas";
import { handleRouteError, jsonResponse, newRequestId, requireSession } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";

/**
 * Eval run history (api-contracts.md §1 Evaluation, PRD FR-21/US-7).
 *
 * GET  — reviewer+ read-only run history for the eval dashboard.
 * POST — reviewer+ (service account): persists ONE run's report. Written only
 *        by the eval CLI (`pnpm eval:mro`), which drives the public endpoints
 *        — eval tests the product, not internals.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  const requestId = newRequestId();
  try {
    await requireSession("reviewer");
    const db = getSingletonDb();
    const rows = await db.select().from(evalRuns).orderBy(desc(evalRuns.startedAt)).limit(100);
    const body = evalRunsResponseSchema.parse({
      runs: rows.map((row) => ({
        runId: row.id,
        mode: row.mode,
        fixtureVersion: row.fixtureVersion,
        startedAt: row.startedAt.toISOString(),
        gates: row.gates,
        passed: row.passed,
      })),
    });
    return jsonResponse(body);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = newRequestId();
  try {
    const session = await requireSession("reviewer");
    const body = createEvalRunRequestSchema.parse(await request.json());
    const db = getSingletonDb();
    const [row] = await db
      .insert(evalRuns)
      .values({
        mode: body.mode,
        fixtureVersion: body.fixtureVersion,
        startedAt: new Date(body.startedAt),
        metrics: body.metrics,
        gates: body.gates,
        passed: body.passed,
        caseSummaries: body.caseSummaries,
        reportPath: body.reportPath ?? null,
      })
      .returning({ id: evalRuns.id });

    await recordAudit({
      eventType: "eval.recorded",
      answerId: null,
      actorId: session.sub,
      payload: {
        runId: row?.id ?? null,
        mode: body.mode,
        fixtureVersion: body.fixtureVersion,
        passed: body.passed,
      },
    });

    return jsonResponse({ runId: row!.id }, 201);
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
