import { asc, desc, eq } from "drizzle-orm";

import { engineAlerts, engineUnits, rulPredictions, sensorReadings } from "@/db/schema";
import { getSingletonDb } from "@/lib/db-singleton";
import { engineDetailSchema } from "@/lib/api/schemas";
import {
  MroApiError,
  handleRouteError,
  jsonResponse,
  newRequestId,
  requireSession,
} from "@/lib/api/respond";
import { alertToApi, userNameMap } from "@/lib/engines/serialize";

/**
 * GET /api/v1/engines/{unitId} (api-contracts.md §1): unit detail —
 * prediction history (trend series), alerts, threshold. 404 for unknown
 * units; provenance travels on every prediction row (FR-16).
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ unitId: string }> }) {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const { unitId } = await context.params;
    const db = getSingletonDb();

    const unitRows = await db
      .select()
      .from(engineUnits)
      .where(eq(engineUnits.unitId, unitId))
      .limit(1);
    const unit = unitRows[0];
    if (!unit) throw new MroApiError("NOT_FOUND", `engine unit ${unitId} not found`);

    const readingCount = await db.$count(sensorReadings, eq(sensorReadings.unitId, unit.unitId));

    const predictions = await db
      .select({
        cycle: rulPredictions.cycle,
        rulCycles: rulPredictions.rulCycles,
        bandLow: rulPredictions.bandLow,
        bandHigh: rulPredictions.bandHigh,
        modelVersion: rulPredictions.modelVersion,
        modelSha256: rulPredictions.modelSha256,
        predictedAt: rulPredictions.createdAt,
      })
      .from(rulPredictions)
      .where(eq(rulPredictions.unitId, unit.unitId))
      .orderBy(asc(rulPredictions.cycle));

    const alerts = await db
      .select()
      .from(engineAlerts)
      .where(eq(engineAlerts.unitId, unit.unitId))
      .orderBy(desc(engineAlerts.raisedAt));
    const names = await userNameMap();

    return jsonResponse(
      engineDetailSchema.parse({
        unit: {
          unitId: unit.unitId,
          dataset: unit.dataset === "synthetic-sample" ? "synthetic-sample" : "cmapss-fd001",
          windowThresholdCycles: unit.windowThresholdCycles,
          status: unit.status,
          latestCycle: predictions.at(-1)?.cycle ?? null,
          readingCount,
        },
        predictions: predictions.map((p) => ({
          cycle: p.cycle,
          rulCycles: p.rulCycles,
          bandLow: p.bandLow,
          bandHigh: p.bandHigh,
          modelVersion: p.modelVersion,
          modelSha256: p.modelSha256,
          predictedAt: p.predictedAt.toISOString(),
        })),
        alerts: alerts.map((a) => alertToApi(a, names)),
      }),
    );
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
