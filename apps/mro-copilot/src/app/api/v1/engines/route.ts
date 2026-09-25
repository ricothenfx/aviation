import { asc, inArray, sql } from "drizzle-orm";

import { engineAlerts, engineUnits } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { enginesResponseSchema, type EnginesUnit } from "@/lib/api/schemas";
import { handleRouteError, jsonResponse, newRequestId, requireSession } from "@/lib/api/respond";
import { OPEN_ALERT_STATES } from "@/lib/engines/alerts";

/**
 * GET /api/v1/engines (api-contracts.md §1, PRD F-5): fleet snapshot — per
 * unit the latest scored RUL + uncertainty band + provenance, and its open
 * alert count. Units never scored (insufficient history) carry latestRul:
 * null and the dashboard renders "—" — never 0 (D-15 honesty precedent).
 */
export const dynamic = "force-dynamic";

interface LatestPredictionRow extends Record<string, unknown> {
  unit_id: string;
  cycle: number;
  rul_cycles: number;
  band_low: number;
  band_high: number;
  model_version: string;
  model_sha256: string;
}

export async function GET() {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const db = getSingletonDb();

    const units = await db.select().from(engineUnits).orderBy(asc(engineUnits.unitId));

    const latestResult = await db.execute<LatestPredictionRow>(sql`
      select distinct on (unit_id)
        unit_id, cycle, rul_cycles, band_low, band_high, model_version, model_sha256
      from rul_predictions
      order by unit_id, cycle desc, created_at desc
    `);
    const latestByUnit = new Map(latestResult.rows.map((r) => [r.unit_id, r]));

    const alertCounts = await db
      .select({ unitId: engineAlerts.unitId, count: sql<number>`count(*)::int` })
      .from(engineAlerts)
      .where(inArray(engineAlerts.state, [...OPEN_ALERT_STATES]))
      .groupBy(engineAlerts.unitId);
    const countByUnit = new Map(alertCounts.map((r) => [r.unitId, Number(r.count)]));

    const payload = {
      units: units.map<EnginesUnit>((unit) => {
        const prediction = latestByUnit.get(unit.unitId);
        return {
          unitId: unit.unitId,
          dataset: unit.dataset === "synthetic-sample" ? "synthetic-sample" : "cmapss-fd001",
          windowThresholdCycles: unit.windowThresholdCycles,
          status: unit.status,
          latestRul: prediction ? Number(prediction.rul_cycles) : null,
          bandLow: prediction ? Number(prediction.band_low) : null,
          bandHigh: prediction ? Number(prediction.band_high) : null,
          latestCycle: prediction ? Number(prediction.cycle) : null,
          modelVersion: prediction ? prediction.model_version : null,
          modelSha256: prediction ? prediction.model_sha256 : null,
          alertCount: countByUnit.get(unit.unitId) ?? 0,
        };
      }),
    };

    return jsonResponse(enginesResponseSchema.parse(payload));
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
